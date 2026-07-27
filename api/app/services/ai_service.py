"""AI Service router — API_DIRECT vs AI_CLI for test-case generation."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.llm.base import GenerateContext, TestCaseDraft, UnitRequest, UnitResult
from app.llm.base_adapter import BaseLLMAdapter
from app.llm.cli.adapters.base_cli import BaseCLIAdapter
from app.llm.cli.adapters.claude_cli import ClaudeCLIAdapter
from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter
from app.llm.cli.adapters.custom_script_cli import CustomScriptCLIAdapter
from app.llm.cli.adapters.gemini_cli import GeminiCLIAdapter
from app.llm.cli.adapters.ollama_cli import OllamaCLIAdapter
from app.llm.cli.session_pool import CLISessionPool
from app.llm.direct_api_adapter import DirectAPIAdapter
from app.llm.providers import Provider
from app.models.domain import AiBackendConnection
from app.services.connection_service import connection_api_key, llm_from_connection

logger = logging.getLogger(__name__)

RUNNER_API_DIRECT = "API_DIRECT"
RUNNER_AI_CLI = "AI_CLI"


def _parse_cli_args(raw: str | None) -> list[str]:
    if not raw or not str(raw).strip():
        return []
    text = str(raw).strip()
    try:
        data = json.loads(text)
        if isinstance(data, list):
            return [str(x) for x in data]
    except Exception:
        pass
    return [p for p in text.split() if p]


def connection_runner_mode(conn: AiBackendConnection) -> str:
    mode = (getattr(conn, "runner_mode", None) or RUNNER_API_DIRECT).strip().upper()
    if mode in ("AI_CLI", "CLI", "BACKGROUND_CLI"):
        return RUNNER_AI_CLI
    return RUNNER_API_DIRECT


def build_cli_adapter(conn: AiBackendConnection) -> BaseLLMAdapter:
    cli_type = (getattr(conn, "cli_type", None) or "gemini-cli").strip().lower()
    cli_path = (getattr(conn, "cli_path", None) or "").strip() or None
    cli_args = _parse_cli_args(getattr(conn, "cli_args_json", None))
    model = (conn.model_name or "").strip() or None
    pid = str(conn.project_id)

    if cli_type in ("claude", "claude-cli", "claude-code"):
        return ClaudeCLIAdapter(
            pid, cli_path=cli_path or "claude", cli_args=cli_args, model_name=model
        )
    if cli_type in ("cursor", "cursor-cli", "cursor-agent", "agent"):
        return CursorCLIAdapter(
            pid, cli_path=cli_path or "agent", cli_args=cli_args, model_name=model
        )
    if cli_type in ("ollama", "ollama-cli"):
        return OllamaCLIAdapter(
            pid, cli_path=cli_path or "ollama", cli_args=cli_args, model_name=model
        )
    if cli_type in ("custom", "custom-script", "script"):
        if not cli_path:
            raise ValueError(
                "AI_CLI custom-script cần cli_path (đường dẫn executable/script)"
            )
        return CustomScriptCLIAdapter(
            pid, cli_path=cli_path, cli_args=cli_args, model_name=model
        )
    return GeminiCLIAdapter(
        pid, cli_path=cli_path or "gemini", cli_args=cli_args, model_name=model
    )


def get_adapter_for_connection(
    conn: AiBackendConnection,
    *,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> BaseLLMAdapter:
    if connection_runner_mode(conn) == RUNNER_AI_CLI:
        return build_cli_adapter(conn)
    key = api_key
    if key is None:
        key = connection_api_key(conn)
    prov = provider or llm_from_connection(conn)
    return DirectAPIAdapter(prov, key)


async def generate_test_cases_for_connection(
    conn: AiBackendConnection,
    title: str,
    content: str,
    ctx: GenerateContext,
    *,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> tuple[list[TestCaseDraft], dict[str, Any]]:
    """Returns (drafts, meta) with runnerUsed / cliSessionKey."""
    mode = connection_runner_mode(conn)
    meta: dict[str, Any] = {"runnerUsed": mode, "cliSessionKey": None}
    adapter = get_adapter_for_connection(conn, api_key=api_key, provider=provider)
    drafts = await adapter.generate_test_cases(title, content, ctx=ctx)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
    return drafts, meta


async def chat_for_connection(
    conn: AiBackendConnection,
    system: str,
    user: str,
    *,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> tuple[str, dict[str, Any]]:
    """
    Chat / Knowledge enrich via API_DIRECT or AI_CLI.
    Returns (raw_text, meta) with runnerUsed.
    """
    mode = connection_runner_mode(conn)
    meta: dict[str, Any] = {"runnerUsed": mode, "cliSessionKey": None}
    key = api_key
    if mode == RUNNER_AI_CLI:
        key = None  # CLI không cần API key
    elif key is None:
        key = connection_api_key(conn)
    adapter = get_adapter_for_connection(conn, api_key=key, provider=provider)
    raw = await adapter.chat(system, user)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
    return raw, meta


async def generate_unit_for_connection(
    conn: AiBackendConnection,
    req: UnitRequest,
    *,
    api_key: str | None = None,
    provider: Provider | None = None,
) -> tuple[UnitResult, dict[str, Any]]:
    """
    Step 1 Unit Test CLI workflow — sinh unit qua API_DIRECT hoặc AI_CLI.
    Returns (UnitResult, meta) with runnerUsed / provider / cliSessionKey.
    """
    mode = connection_runner_mode(conn)
    meta: dict[str, Any] = {
        "runnerUsed": mode,
        "cliSessionKey": None,
        "provider": None,
    }
    key = api_key
    if mode == RUNNER_AI_CLI:
        key = None
    elif key is None:
        key = connection_api_key(conn)
    adapter = get_adapter_for_connection(conn, api_key=key, provider=provider)
    result = await adapter.generate_unit(req)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
        meta["provider"] = adapter.vendor
    elif isinstance(adapter, DirectAPIAdapter):
        meta["provider"] = adapter.provider.name
    else:
        meta["provider"] = "llm"
    return result, meta


def cli_session_status(project_id: str) -> list[dict[str, Any]]:
    return CLISessionPool().list_sessions(project_id)
