"""AI Service — AI_CLI only (Cursor / Claude / Gemini / Antigravity / Ollama / custom)."""

from __future__ import annotations

import json
import logging
from typing import Any

from app.llm.base import GenerateContext, TestCaseDraft, UnitRequest, UnitResult
from app.llm.base_adapter import BaseLLMAdapter
from app.llm.cli.adapters.antigravity_cli import AntigravityCLIAdapter
from app.llm.cli.adapters.base_cli import BaseCLIAdapter
from app.llm.cli.adapters.claude_cli import ClaudeCLIAdapter
from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter
from app.llm.cli.adapters.custom_script_cli import CustomScriptCLIAdapter
from app.llm.cli.adapters.gemini_cli import GeminiCLIAdapter
from app.llm.cli.adapters.ollama_cli import OllamaCLIAdapter
from app.llm.cli.session_pool import CLISessionPool
from app.models.domain import AiBackendConnection

logger = logging.getLogger(__name__)

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
    """Always AI_CLI — legacy API_DIRECT rows are coerced."""
    del conn  # kept for call-site compatibility
    return RUNNER_AI_CLI


def connection_is_cursor_cli(conn: AiBackendConnection) -> bool:
    """True when project AI is Cursor Agent CLI (oneshot --mode ask only)."""
    cli_type = (getattr(conn, "cli_type", None) or "").strip().lower()
    return cli_type in ("cursor", "cursor-cli", "cursor-agent", "agent")


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
    if cli_type in ("antigravity", "antigravity-cli", "agy"):
        return AntigravityCLIAdapter(
            pid, cli_path=cli_path or "agy", cli_args=cli_args, model_name=model
        )
    return GeminiCLIAdapter(
        pid, cli_path=cli_path or "gemini", cli_args=cli_args, model_name=model
    )


def get_adapter_for_connection(
    conn: AiBackendConnection,
    *,
    api_key: str | None = None,
    provider: Any | None = None,
) -> BaseLLMAdapter:
    """Always CLI adapter. api_key/provider kept for call-site compatibility (ignored)."""
    del api_key, provider
    return build_cli_adapter(conn)


async def generate_test_cases_for_connection(
    conn: AiBackendConnection,
    title: str,
    content: str,
    ctx: GenerateContext,
    *,
    api_key: str | None = None,
    provider: Any | None = None,
    on_progress: Any | None = None,
    prefer_oneshot: bool | None = None,
    session_topic_key: str | None = None,
    resume_chat_id: str | None = None,
    create_chat: bool = False,
) -> tuple[list[TestCaseDraft], dict[str, Any]]:
    """Returns (drafts, meta) with runnerUsed / cliSessionKey / cursorChatId."""
    meta: dict[str, Any] = {
        "runnerUsed": RUNNER_AI_CLI,
        "cliSessionKey": None,
        "cursorChatId": None,
    }
    adapter = get_adapter_for_connection(conn, api_key=api_key, provider=provider)
    kwargs: dict[str, Any] = {"ctx": ctx, "on_progress": on_progress}
    if isinstance(adapter, BaseCLIAdapter):
        if prefer_oneshot is not None:
            kwargs["prefer_oneshot"] = prefer_oneshot
        if session_topic_key is not None:
            kwargs["session_topic_key"] = session_topic_key
        if resume_chat_id is not None:
            kwargs["resume_chat_id"] = resume_chat_id
        if create_chat:
            kwargs["create_chat"] = True
    drafts = await adapter.generate_test_cases(title, content, **kwargs)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
        chat_id = getattr(adapter, "last_cursor_chat_id", None)
        if isinstance(chat_id, str) and chat_id.strip():
            meta["cursorChatId"] = chat_id.strip()
        elif resume_chat_id:
            meta["cursorChatId"] = resume_chat_id
    # Soft DoR: flag thin E2E TCs with [Thiếu Context] before Desktop Gen
    try:
        engine = (getattr(ctx, "preferred_engine", None) or "").strip().lower()
        if engine in ("e2e", "ui", "") or not engine:
            from app.services.e2e_tc_dor_annotate import annotate_e2e_tc_drafts

            # Only annotate when engine is e2e (skip pure unit jobs)
            if engine == "e2e" or any(
                (d.type or "").strip().upper() in ("E2E", "E2E_UI") for d in drafts
            ):
                drafts = annotate_e2e_tc_drafts(drafts)
    except Exception:  # noqa: BLE001
        pass
    return drafts, meta


async def chat_for_connection(
    conn: AiBackendConnection,
    system: str,
    user: str,
    *,
    api_key: str | None = None,
    provider: Any | None = None,
    resume_chat_id: str | None = None,
    create_chat: bool = False,
) -> tuple[str, dict[str, Any]]:
    """
    Chat / Knowledge enrich via AI CLI.
    Returns (raw_text, meta) with runnerUsed.
    Optional create_chat / resume_chat_id — Cursor hidden conversation (--mode ask).
    """
    meta: dict[str, Any] = {
        "runnerUsed": RUNNER_AI_CLI,
        "cliSessionKey": None,
        "cursorChatId": None,
    }
    adapter = get_adapter_for_connection(conn, api_key=api_key, provider=provider)
    raw = await adapter.chat(
        system,
        user,
        resume_chat_id=resume_chat_id,
        create_chat=create_chat,
    )
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
        chat_id = getattr(adapter, "last_cursor_chat_id", None)
        if isinstance(chat_id, str) and chat_id.strip():
            meta["cursorChatId"] = chat_id.strip()
    return raw, meta


async def generate_unit_for_connection(
    conn: AiBackendConnection,
    req: UnitRequest,
    *,
    api_key: str | None = None,
    provider: Any | None = None,
) -> tuple[UnitResult, dict[str, Any]]:
    """Step 1 Unit Test — sinh unit qua AI CLI."""
    meta: dict[str, Any] = {
        "runnerUsed": RUNNER_AI_CLI,
        "cliSessionKey": None,
        "provider": None,
    }
    adapter = get_adapter_for_connection(conn, api_key=api_key, provider=provider)
    result = await adapter.generate_unit(req)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
        meta["provider"] = adapter.vendor
    else:
        meta["provider"] = "llm"
    return result, meta


async def generate_e2e_for_connection(
    conn: AiBackendConnection,
    req: "E2ERequest",
    *,
    api_key: str | None = None,
    provider: Any | None = None,
    heal: bool = False,
) -> tuple["E2EResult", dict[str, Any]]:
    """E2E Playwright generate / heal via AI CLI."""
    meta: dict[str, Any] = {
        "runnerUsed": RUNNER_AI_CLI,
        "cliSessionKey": None,
        "provider": None,
        "heal": heal,
    }
    adapter = get_adapter_for_connection(conn, api_key=api_key, provider=provider)

    if isinstance(adapter, BaseCLIAdapter) and hasattr(adapter, "generate_e2e"):
        result = await adapter.generate_e2e(req, heal=heal)
        meta["cliSessionKey"] = adapter.last_session_key
        meta["provider"] = adapter.vendor
        return result, meta

    # Fallback chat path (non-CLI adapters should not occur — kept for safety)
    from app.llm.base import e2e_result_from_raw, e2e_system_prompt, e2e_user_prompt
    from app.services.e2e_auth_mode import is_login_or_auth_tc, resolve_auth_mode

    auth_mode = resolve_auth_mode(
        use_storage=bool((req.storage_state_rel or "").strip()),
        has_valid_storage_json=False,
        is_login_tc=is_login_or_auth_tc(req.test_case_title),
    )
    sys_p = e2e_system_prompt(
        heal=heal,
        has_storage_state=(auth_mode == "storage"),
        project_rules=req.project_rules,
        user_rules=req.user_rules,
    )
    usr_p = e2e_user_prompt(req)
    raw = await adapter.chat(sys_p, usr_p)
    if isinstance(adapter, BaseCLIAdapter):
        meta["cliSessionKey"] = adapter.last_session_key
        meta["provider"] = adapter.vendor
    else:
        meta["provider"] = "llm"
    result = e2e_result_from_raw(raw, req)
    return result, meta


def cli_session_status(project_id: str) -> list[dict[str, Any]]:
    return CLISessionPool().list_sessions(project_id)
