from __future__ import annotations

from app.llm.cli.adapters.base_cli import BaseCLIAdapter


class GeminiCLIAdapter(BaseCLIAdapter):
    vendor = "gemini-cli"
    default_path = "gemini"
    interactive_args = ["--interactive", "--no-color"]
    oneshot_args = ["-p"]
    prefer_oneshot = True
