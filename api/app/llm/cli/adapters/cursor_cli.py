from __future__ import annotations

import asyncio
import json
import logging
import os
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path
from typing import Any

from app.llm.cli.adapters.base_cli import BaseCLIAdapter
from app.llm.cli.process_runner import CLIProcessRunner, resolve_command

logger = logging.getLogger(__name__)

_CREATE_NO_WINDOW = 0
if sys.platform == "win32":
    _CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def _extract_stream_text(obj: dict[str, Any]) -> str:
    """Pull visible text from a Cursor agent stream-json event."""
    for key in ("text", "delta", "content", "message", "result"):
        val = obj.get(key)
        if isinstance(val, str) and val.strip():
            return val
        if isinstance(val, dict):
            nested = _extract_stream_text(val)
            if nested:
                return nested
    choices = obj.get("choices")
    if isinstance(choices, list) and choices:
        ch0 = choices[0] if isinstance(choices[0], dict) else {}
        delta = ch0.get("delta") if isinstance(ch0, dict) else None
        if isinstance(delta, dict):
            t = delta.get("content")
            if isinstance(t, str):
                return t
    return ""


def _event_label(obj: dict[str, Any]) -> str | None:
    typ = str(obj.get("type") or obj.get("event") or obj.get("subtype") or "").lower()
    if not typ:
        return None
    if "tool" in typ:
        name = None
        tool = obj.get("tool")
        if isinstance(tool, dict):
            name = tool.get("name")
        name = name or obj.get("name") or obj.get("toolName")
        return f"tool: {name}" if name else "đang gọi tool…"
    if typ in ("thinking", "reasoning", "thought"):
        return "model đang suy nghĩ…"
    if typ in ("assistant", "message", "text", "delta", "content_block_delta"):
        return "đang sinh nội dung…"
    if typ in ("error", "failed"):
        err = obj.get("error") or obj.get("message") or typ
        return f"lỗi CLI: {err}"
    if typ in ("result", "done", "completed", "end"):
        return "CLI sắp xong…"
    return None


class CursorCLIAdapter(BaseCLIAdapter):
    """
    Cursor Agent CLI — binary `agent` (agent.cmd / agent.ps1 trên Windows).

    One-shot headless with live progress:
      agent --print --mode ask --output-format stream-json --stream-partial-output --trust
    """

    vendor = "cursor-cli"
    default_path = "agent"
    interactive_args = []
    oneshot_args = [
        "--print",
        "--mode",
        "ask",
        "--output-format",
        "stream-json",
        "--stream-partial-output",
        "--trust",
    ]
    prefer_oneshot = True

    def build_command(self, *, oneshot: bool = False) -> list[str]:
        cmd = super().build_command(oneshot=oneshot)
        if "--model" not in cmd:
            cmd.extend(["--model", self.model_name or "auto"])
        return cmd

    async def health_check(self) -> bool:
        path = Path(self.cli_path)
        if path.is_file():
            return True
        if shutil.which(self.cli_path):
            return True
        for alt in ("agent", "cursor-agent", "cursor"):
            found = shutil.which(alt)
            if found:
                self.cli_path = alt
                return True
        return False

    async def _run_oneshot(self, prompt: str) -> str:
        """
        Prompt Sinh TC thường rất dài (>8k) → không nhét vào argv Windows.
        Ghi temp file rồi truyền path ngắn; stream stdout NDJSON để theo dõi.
        """
        cmd = self.build_command(oneshot=True)
        if len(prompt) <= 3500:
            return await self._stream_oneshot([*cmd, prompt], stdin_text=None)

        with tempfile.NamedTemporaryFile(
            mode="w",
            suffix=".txt",
            delete=False,
            encoding="utf-8",
        ) as fh:
            fh.write(prompt)
            prompt_path = fh.name

        try:
            wrapper = (
                f"Đọc toàn bộ nội dung file sau (UTF-8) và trả lời ĐÚNG theo yêu cầu trong đó. "
                f"File: {prompt_path}\n"
                f"Tuân thủ định dạng output mà file yêu cầu "
                f"(JSON / mã trong fence ``` / …). Không thêm lời giải thích ngoài định dạng đó."
            )
            try:
                return await self._stream_oneshot([*cmd, wrapper], stdin_text=None)
            except TimeoutError:
                raise
            except Exception as e:  # noqa: BLE001
                logger.warning("cursor stream file-ref failed, try stdin text mode: %s", e)
                fixed: list[str] = []
                skip_next = False
                for i, a in enumerate(cmd):
                    if skip_next:
                        skip_next = False
                        continue
                    if a == "--output-format" and i + 1 < len(cmd):
                        fixed.extend(["--output-format", "text"])
                        skip_next = True
                        continue
                    if a == "--stream-partial-output":
                        continue
                    fixed.append(a)
                if "--output-format" not in fixed:
                    fixed.extend(["--output-format", "text"])
                runner = CLIProcessRunner(command=fixed)
                self._progress("Cursor CLI: fallback text mode (không stream)…")
                return await runner.run_oneshot(prompt)
        finally:
            try:
                Path(prompt_path).unlink(missing_ok=True)
            except Exception:
                pass

    async def _stream_oneshot(
        self,
        command: list[str],
        *,
        stdin_text: str | None,
        timeout: int | None = None,
    ) -> str:
        if timeout is None:
            try:
                timeout = max(
                    60,
                    min(600, int(os.environ.get("AITEST_CURSOR_ONESHOT_TIMEOUT", "240"))),
                )
            except ValueError:
                timeout = 240
        resolved = resolve_command(command)
        self._progress(f"Cursor CLI: khởi động agent… (timeout {timeout}s)")

        def _run() -> str:
            proc = subprocess.Popen(
                resolved,
                stdin=subprocess.PIPE,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                cwd=None,
                env=os.environ.copy(),
                creationflags=_CREATE_NO_WINDOW,
            )
            assert proc.stdin and proc.stdout
            if stdin_text:
                proc.stdin.write(stdin_text.encode("utf-8"))
            proc.stdin.close()

            text_parts: list[str] = []
            raw_lines: list[str] = []
            last_progress = 0.0
            last_text_flush = 0.0
            pending_text = ""
            started = time.monotonic()
            event_n = 0

            def _flush_text(force: bool = False) -> None:
                nonlocal pending_text, last_text_flush
                now = time.monotonic()
                if not pending_text.strip():
                    return
                if not force and (now - last_text_flush) < 0.8:
                    return
                elapsed = int(now - started)
                preview = pending_text[-1200:].replace("\r", "")
                self._progress(f"[{elapsed}s] assistant:\n{preview}")
                pending_text = ""
                last_text_flush = now

            while True:
                if time.monotonic() - started > timeout:
                    proc.kill()
                    raise TimeoutError("Cursor CLI stream timed out")
                line_b = proc.stdout.readline()
                if not line_b:
                    break
                line = line_b.decode("utf-8", errors="replace").rstrip("\n")
                if not line.strip():
                    continue
                raw_lines.append(line)
                event_n += 1
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    text_parts.append(line)
                    pending_text += line + "\n"
                    _flush_text()
                    continue
                if not isinstance(obj, dict):
                    continue
                typ = str(obj.get("type") or obj.get("event") or obj.get("subtype") or "")
                typ_l = typ.lower()
                label = _event_label(obj)
                chunk = _extract_stream_text(obj)
                # Thinking/reasoning chỉ hiện progress — không lẫn vào raw code/JSON.
                is_thinking = (
                    typ_l in ("thinking", "reasoning", "thought")
                    or "thinking" in typ_l
                    or "reasoning" in typ_l
                )
                if chunk and not is_thinking:
                    text_parts.append(chunk)
                    pending_text += chunk
                now = time.monotonic()
                elapsed = int(now - started)
                if label and "sinh nội dung" not in (label or ""):
                    if (now - last_progress) >= 0.6 or "tool" in typ_l or "error" in typ_l:
                        last_progress = now
                        detail = (chunk or json.dumps(obj, ensure_ascii=False)[:240]).replace(
                            "\n", " "
                        )
                        self._progress(f"[{elapsed}s] {label}" + (f" — {detail[:200]}" if detail else ""))
                _flush_text()
                # heartbeat so UI không im lặng khi model thinking lâu
                if event_n % 25 == 0:
                    self._progress(f"[{elapsed}s] stream… ({event_n} events, {len(''.join(text_parts))} chars)")

            _flush_text(force=True)
            self._progress(
                f"[{int(time.monotonic() - started)}s] Cursor CLI kết thúc stream "
                f"({event_n} events, {len(''.join(text_parts))} chars output)"
            )

            stderr = ""
            if proc.stderr:
                stderr = proc.stderr.read().decode("utf-8", errors="replace")
            code = proc.wait(timeout=10)
            joined = "".join(text_parts).strip()
            if not joined:
                for line in reversed(raw_lines):
                    try:
                        obj = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if isinstance(obj, dict):
                        for key in ("result", "text", "content", "message"):
                            val = obj.get(key)
                            if isinstance(val, str) and val.strip():
                                joined = val.strip()
                                break
                    if joined:
                        break
            if not joined and raw_lines:
                joined = "\n".join(raw_lines)
            if code not in (0, None) and not joined.strip():
                raise RuntimeError(f"Cursor CLI exit {code}: {(stderr or '')[:1200]}")
            if not joined.strip() and stderr.strip():
                logger.warning("Cursor CLI stdout empty; stderr=%s", stderr[:400])
                return stderr
            return joined

        return await asyncio.to_thread(_run)
