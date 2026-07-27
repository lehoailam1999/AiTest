from __future__ import annotations

import logging
import shutil
import tempfile
from pathlib import Path

from app.llm.cli.adapters.base_cli import BaseCLIAdapter
from app.llm.cli.process_runner import CLIProcessRunner

logger = logging.getLogger(__name__)


class CursorCLIAdapter(BaseCLIAdapter):
    """
    Cursor Agent CLI — binary `agent` (agent.cmd / agent.ps1 trên Windows).

    One-shot headless:
      agent --print --mode ask --output-format text --trust <prompt-or-stdin>
    """

    vendor = "cursor-cli"
    default_path = "agent"
    interactive_args = []
    # ask = read-only Q&A (không sửa file); trust = bỏ prompt workspace headless
    oneshot_args = ["--print", "--mode", "ask", "--output-format", "text", "--trust"]
    prefer_oneshot = True

    def build_command(self, *, oneshot: bool = False) -> list[str]:
        cmd = super().build_command(oneshot=oneshot)
        # Default Auto avoids paid-model usage-limit blocks on Pro accounts
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
        Ghi temp file rồi truyền path ngắn làm prompt: "Read file X and respond…"
        đồng thời pipe nội dung qua stdin làm dự phòng.
        """
        cmd = self.build_command(oneshot=True)
        # Short prompts: pass as argv (still via resolved cmd wrapper)
        if len(prompt) <= 3500:
            runner = CLIProcessRunner(command=[*cmd, prompt])
            return await runner.run_oneshot("")

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
                f"Chỉ trả JSON theo schema được yêu cầu trong file, không giải thích."
            )
            # Prefer short argv pointing at file (avoids cmdline limit)
            runner = CLIProcessRunner(command=[*cmd, wrapper])
            try:
                return await runner.run_oneshot("")
            except Exception as e:  # noqa: BLE001
                logger.warning("cursor file-ref oneshot failed, try stdin pipe: %s", e)
                runner2 = CLIProcessRunner(command=cmd)
                return await runner2.run_oneshot(prompt)
        finally:
            try:
                Path(prompt_path).unlink(missing_ok=True)
            except Exception:
                pass
