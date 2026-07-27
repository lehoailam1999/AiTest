from __future__ import annotations

from app.llm.cli.adapters.base_cli import BaseCLIAdapter


class ClaudeCLIAdapter(BaseCLIAdapter):
    vendor = "claude-cli"
    default_path = "claude"
    interactive_args = []  # claude interactive is TTY-heavy; prefer -p
    oneshot_args = ["-p"]
    prefer_oneshot = True
