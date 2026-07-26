"""Ports (interfaces) — LLM, LanguageAdapter, TestRunner, CoverageParser (W3)."""

from __future__ import annotations

from typing import Protocol, runtime_checkable


@runtime_checkable
class LlmPort(Protocol):
    name: str

    async def verify(self, api_key: str) -> None: ...

    async def chat(self, api_key: str, system: str, user: str) -> str: ...


@runtime_checkable
class LanguageAdapterPort(Protocol):
    language: str

    def source_extensions(self) -> list[str]: ...

    def suggest_unit_test_path(self, source_rel: str, class_name: str) -> str: ...

    def default_test_command(self, framework: str | None) -> str: ...


@runtime_checkable
class TestRunnerPort(Protocol):
    name: str

    def parse_output(self, stdout: str, stderr: str, exit_code: int) -> dict:
        """Return {passed, failed, skipped, total, status}."""
        ...


@runtime_checkable
class CoverageParserPort(Protocol):
    format: str

    def parse(self, content: str) -> dict:
        """Return {linePct, branchPct?, files?} — meta only, no source."""
        ...


# WorkspacePort lives in ports/workspace.py (Local Agent swap point)
from app.ports.workspace import WorkspacePort as WorkspacePort  # noqa: E402

__all__ = [
    "LlmPort",
    "LanguageAdapterPort",
    "TestRunnerPort",
    "CoverageParserPort",
    "WorkspacePort",
]
