"""Async subprocess wrapper for AI CLI interactive / one-shot runs."""

from __future__ import annotations

import asyncio
import logging
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Optional

logger = logging.getLogger(__name__)

DELIMITER = "---END_OF_AITEST_RESPONSE_TOKEN---"

_CREATE_NO_WINDOW = 0
if sys.platform == "win32":
    _CREATE_NO_WINDOW = getattr(subprocess, "CREATE_NO_WINDOW", 0x08000000)


def _exc_detail(exc: BaseException) -> str:
    """NotImplementedError() has empty str — surface type + winerror."""
    parts = [type(exc).__name__]
    msg = str(exc).strip()
    if msg:
        parts.append(msg)
    winerror = getattr(exc, "winerror", None)
    if winerror is not None:
        parts.append(f"winerror={winerror}")
    errno = getattr(exc, "errno", None)
    if errno is not None:
        parts.append(f"errno={errno}")
    return ": ".join(parts) if len(parts) > 1 else parts[0]


def _powershell_exe() -> str:
    sys_root = os.environ.get("SystemRoot", r"C:\Windows")
    candidate = Path(sys_root) / "System32" / "WindowsPowerShell" / "v1.0" / "powershell.exe"
    if candidate.is_file():
        return str(candidate)
    return shutil.which("powershell.exe") or "powershell.exe"


def resolve_command(command: list[str]) -> list[str]:
    """
    Resolve CLI for Windows: `agent` often maps to agent.cmd / agent.ps1 which
    create_subprocess_exec cannot launch directly — wrap via cmd/powershell.

    Important: paths with spaces (e.g. C:\\Users\\Dell One\\...) must be a
    single quoted string after `cmd /c`, not split argv tokens.
    """
    if not command:
        return command
    exe = command[0]
    rest = list(command[1:])
    resolved = shutil.which(exe) or exe
    path = Path(resolved)
    ps = _powershell_exe()

    if sys.platform == "win32":
        # Prefer .ps1 over .cmd when both exist (avoids cmd quoting issues)
        if path.suffix.lower() == ".cmd":
            ps1 = path.with_suffix(".ps1")
            if ps1.is_file():
                return [
                    ps,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ps1),
                    *rest,
                ]
        if path.suffix.lower() in (".cmd", ".bat"):
            cmdline = subprocess.list2cmdline([str(path), *rest])
            return ["cmd.exe", "/d", "/s", "/c", cmdline]
        if path.suffix.lower() == ".ps1":
            return [
                ps,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(path),
                *rest,
            ]
        cmd_candidate = path.with_suffix(".cmd") if not path.suffix else None
        if cmd_candidate and cmd_candidate.is_file():
            ps1 = cmd_candidate.with_suffix(".ps1")
            if ps1.is_file():
                return [
                    ps,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(ps1),
                    *rest,
                ]
            cmdline = subprocess.list2cmdline([str(cmd_candidate), *rest])
            return ["cmd.exe", "/d", "/s", "/c", cmdline]

    return [str(resolved), *rest]


def _sync_run(
    command: list[str],
    *,
    input_text: str | None,
    cwd: str | None,
    timeout: int,
) -> subprocess.CompletedProcess[bytes]:
    return subprocess.run(
        command,
        input=(input_text.encode("utf-8") if input_text is not None else None),
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        cwd=cwd,
        env=os.environ.copy(),
        timeout=timeout,
        creationflags=_CREATE_NO_WINDOW,
    )


async def _spawn_exec(
    command: list[str],
    *,
    cwd: str | None,
) -> asyncio.subprocess.Process:
    """
    Spawn with asyncio pipes. On Windows, uvicorn may use SelectorEventLoop which
    raises NotImplementedError (empty message) for create_subprocess_exec — then
    fall back is handled by callers for oneshot; interactive uses Popen bridge.
    """
    kwargs: dict = {}
    if sys.platform == "win32" and _CREATE_NO_WINDOW:
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    return await asyncio.create_subprocess_exec(
        *command,
        stdin=asyncio.subprocess.PIPE,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
        cwd=cwd,
        env=os.environ.copy(),
        **kwargs,
    )


class CLIProcessRunner:
    """Quản lý vòng đời một Subprocess CLI (interactive session hoặc one-shot)."""

    def __init__(self, command: list[str], cwd: Optional[str] = None):
        self.command = resolve_command(command)
        self.cwd = cwd
        self.process: Optional[asyncio.subprocess.Process] = None
        self._popen: Optional[subprocess.Popen[bytes]] = None
        self.is_alive = False

    async def start(self) -> None:
        try:
            try:
                self.process = await _spawn_exec(self.command, cwd=self.cwd)
            except NotImplementedError:
                # SelectorEventLoop on Windows — use sync Popen + thread readers later
                self._popen = subprocess.Popen(
                    self.command,
                    stdin=subprocess.PIPE,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                    cwd=self.cwd,
                    env=os.environ.copy(),
                    creationflags=_CREATE_NO_WINDOW,
                )
            self.is_alive = True
            pid = (
                self.process.pid
                if self.process
                else (self._popen.pid if self._popen else None)
            )
            logger.info("CLI Subprocess started. PID=%s cmd=%s", pid, self.command[:6])
        except Exception as e:
            self.is_alive = False
            detail = _exc_detail(e)
            logger.error("Failed to start CLI process: %s | cmd=%s", detail, self.command)
            raise RuntimeError(
                f"Failed to start CLI process: {detail} | cmd={self.command[:10]}"
            ) from e

    async def send_prompt(self, prompt_text: str, timeout: int = 180) -> str:
        if not self.process and not self._popen:
            await self.start()
        if not self.is_alive:
            await self.start()

        formatted = (
            f"{prompt_text}\n\n"
            f"Sau khi trả lời xong, hãy in đúng dòng văn bản sau ở cuối: {DELIMITER}\n"
        )

        if self._popen is not None:
            return await self._send_prompt_popen(formatted, timeout=timeout)

        assert self.process and self.process.stdin and self.process.stdout
        try:
            self.process.stdin.write(formatted.encode("utf-8"))
            await self.process.stdin.drain()

            response_lines: list[str] = []
            while True:
                line_bytes = await asyncio.wait_for(
                    self.process.stdout.readline(), timeout=timeout
                )
                if not line_bytes:
                    break
                line = line_bytes.decode("utf-8", errors="replace")
                if DELIMITER in line:
                    break
                response_lines.append(line)
            return "".join(response_lines)
        except asyncio.TimeoutError:
            logger.error("CLI Process response timeout")
            await self.terminate()
            raise TimeoutError("CLI Process timed out waiting for response.") from None
        except Exception as e:
            logger.error("Error communicating with CLI Process: %s", _exc_detail(e))
            await self.terminate()
            raise

    async def _send_prompt_popen(self, formatted: str, *, timeout: int) -> str:
        assert self._popen and self._popen.stdin and self._popen.stdout

        def _write_read() -> str:
            assert self._popen and self._popen.stdin and self._popen.stdout
            self._popen.stdin.write(formatted.encode("utf-8"))
            self._popen.stdin.flush()
            lines: list[str] = []
            while True:
                line = self._popen.stdout.readline()
                if not line:
                    break
                text = line.decode("utf-8", errors="replace")
                if DELIMITER in text:
                    break
                lines.append(text)
            return "".join(lines)

        try:
            return await asyncio.wait_for(asyncio.to_thread(_write_read), timeout=timeout)
        except asyncio.TimeoutError:
            await self.terminate()
            raise TimeoutError("CLI Process timed out waiting for response.") from None
        except Exception as e:
            logger.error("Error communicating with CLI Popen: %s", _exc_detail(e))
            await self.terminate()
            raise

    async def run_oneshot(self, prompt_text: str, timeout: int = 300) -> str:
        """Chạy CLI một lần. Ưu tiên thread+subprocess (ổn định trên Windows/uvicorn)."""
        # Windows: luôn dùng subprocess.run trong thread — tránh NotImplementedError
        # khi event loop là SelectorEventLoop (uvicorn --reload / một số host).
        if sys.platform == "win32":
            return await self._run_oneshot_thread(prompt_text, timeout=timeout)

        try:
            proc = await _spawn_exec(self.command, cwd=self.cwd)
        except NotImplementedError:
            return await self._run_oneshot_thread(prompt_text, timeout=timeout)
        except Exception as e:
            detail = _exc_detail(e)
            logger.error("Failed to start CLI oneshot: %s | cmd=%s", detail, self.command)
            raise RuntimeError(
                f"Failed to start CLI process: {detail} | cmd={self.command[:10]}"
            ) from e

        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(
                    prompt_text.encode("utf-8") if prompt_text is not None else None
                ),
                timeout=timeout,
            )
        except asyncio.TimeoutError:
            proc.kill()
            await proc.wait()
            raise TimeoutError("CLI one-shot timed out") from None
        return self._decode_result(
            proc.returncode,
            (stdout_b or b"").decode("utf-8", errors="replace"),
            (stderr_b or b"").decode("utf-8", errors="replace"),
        )

    async def _run_oneshot_thread(self, prompt_text: str, timeout: int) -> str:
        try:
            completed = await asyncio.to_thread(
                _sync_run,
                self.command,
                input_text=prompt_text if prompt_text else None,
                cwd=self.cwd,
                timeout=timeout,
            )
        except subprocess.TimeoutExpired as e:
            raise TimeoutError("CLI one-shot timed out") from e
        except Exception as e:
            detail = _exc_detail(e)
            logger.error("Failed to start CLI oneshot: %s | cmd=%s", detail, self.command)
            raise RuntimeError(
                f"Failed to start CLI process: {detail} | cmd={self.command[:10]}"
            ) from e

        out = (completed.stdout or b"").decode("utf-8", errors="replace")
        err = (completed.stderr or b"").decode("utf-8", errors="replace")
        return self._decode_result(completed.returncode, out, err)

    @staticmethod
    def _decode_result(returncode: int | None, out: str, err: str) -> str:
        if returncode not in (0, None) and not out.strip():
            raise RuntimeError(f"CLI exit {returncode}: {(err or out)[:1200]}")
        if not out.strip() and err.strip():
            logger.warning("CLI stdout empty; stderr=%s", err[:400])
        return out or err

    async def terminate(self) -> None:
        if self.process:
            try:
                self.process.terminate()
                await asyncio.wait_for(self.process.wait(), timeout=5)
            except Exception:
                try:
                    self.process.kill()
                except Exception:
                    pass
            self.process = None
        if self._popen:
            try:
                self._popen.terminate()
                await asyncio.to_thread(self._popen.wait, 5)
            except Exception:
                try:
                    self._popen.kill()
                except Exception:
                    pass
            self._popen = None
        self.is_alive = False
        logger.info("CLI Subprocess terminated.")
