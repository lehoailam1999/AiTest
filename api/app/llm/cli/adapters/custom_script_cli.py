from __future__ import annotations

from app.llm.cli.adapters.base_cli import BaseCLIAdapter


class CustomScriptCLIAdapter(BaseCLIAdapter):
    """Wrapper cho script tùy chỉnh — cli_path = đường dẫn script, cli_args tùy chọn."""

    vendor = "custom-script"
    default_path = "python"
    interactive_args = []
    oneshot_args = []
    prefer_oneshot = True

    def build_command(self, *, oneshot: bool = False) -> list[str]:
        # Expect cli_path to be the script or executable; args appended as-is.
        cmd = [self.cli_path]
        cmd.extend(self.cli_args)
        return cmd
