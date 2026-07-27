from __future__ import annotations

from app.llm.cli.adapters.base_cli import BaseCLIAdapter


class OllamaCLIAdapter(BaseCLIAdapter):
    vendor = "ollama"
    default_path = "ollama"
    interactive_args = []
    oneshot_args = []
    prefer_oneshot = True

    def build_command(self, *, oneshot: bool = False) -> list[str]:
        model = self.model_name or "llama3.2"
        return [self.cli_path, "run", model]
