"""CLI adapter package."""

from app.llm.cli.adapters.antigravity_cli import AntigravityCLIAdapter
from app.llm.cli.adapters.base_cli import BaseCLIAdapter
from app.llm.cli.adapters.claude_cli import ClaudeCLIAdapter
from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter
from app.llm.cli.adapters.custom_script_cli import CustomScriptCLIAdapter
from app.llm.cli.adapters.gemini_cli import GeminiCLIAdapter
from app.llm.cli.adapters.ollama_cli import OllamaCLIAdapter

__all__ = [
    "BaseCLIAdapter",
    "GeminiCLIAdapter",
    "ClaudeCLIAdapter",
    "CursorCLIAdapter",
    "OllamaCLIAdapter",
    "CustomScriptCLIAdapter",
    "AntigravityCLIAdapter",
]
