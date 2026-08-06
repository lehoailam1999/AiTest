from __future__ import annotations

from pathlib import Path

from app.llm.cli.adapters.base_cli import BaseCLIAdapter


class AntigravityCLIAdapter(BaseCLIAdapter):
    """Google Antigravity CLI (`agy`) — headless print mode via `-p` / `--print`."""

    vendor = "antigravity-cli"
    default_path = "agy"
    interactive_args: list[str] = []
    oneshot_args = ["-p"]
    prefer_oneshot = True

    async def health_check(self) -> bool:
        """Reject Cursor `agent` path leftover after switching vendor in Settings."""
        base = Path(self.cli_path).name.lower()
        for suf in (".cmd", ".exe", ".bat", ".ps1"):
            if base.endswith(suf):
                base = base[: -len(suf)]
                break
        if base in ("agent", "cursor-agent", "cursor", "gemini", "claude", "ollama"):
            return False
        return await super().health_check()
