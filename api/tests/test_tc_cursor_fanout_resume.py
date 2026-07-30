"""Phase 2 — Cursor TC fan-out uses hidden chat resume (not interactive warm)."""

from __future__ import annotations

import asyncio
from unittest.mock import AsyncMock, MagicMock, patch

from app.llm.base import GenerateContext
from app.llm import base as llm_base
from app.services.ai_service import connection_is_cursor_cli


def test_connection_is_cursor_cli():
    conn = MagicMock()
    conn.runner_mode = "AI_CLI"
    conn.cli_type = "cursor-cli"
    assert connection_is_cursor_cli(conn) is True
    conn.cli_type = "gemini-cli"
    assert connection_is_cursor_cli(conn) is False
    conn.runner_mode = "API_DIRECT"
    conn.cli_type = "cursor"
    assert connection_is_cursor_cli(conn) is False


def test_generate_test_cases_passes_resume_to_cursor_oneshot():
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter("proj", cli_path="agent")
    oneshot = AsyncMock(return_value='{"testCases":[{"title":"T1","type":"E2E","priority":"Cao","severity":"Nặng","module":"Auth","precondition":"","steps":"1. x","expectedResult":"ok","testData":"","automationReady":false}]}')

    with patch.object(adapter, "_run_oneshot", oneshot):
        drafts = asyncio.run(
            adapter.generate_test_cases(
                "Req",
                "Feature Auth: user must login",
                ctx=GenerateContext(feature_titles=["Auth"], preferred_engine="e2e"),
                resume_chat_id="chat-xyz",
                prefer_oneshot=True,
            )
        )

    assert len(drafts) >= 1
    oneshot.assert_awaited()
    _args, kwargs = oneshot.await_args
    assert kwargs.get("resume_chat_id") == "chat-xyz"


def test_generate_for_connection_meta_includes_cursor_chat():
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter
    from app.services import ai_service as svc

    conn = MagicMock()
    conn.runner_mode = "AI_CLI"
    conn.cli_type = "cursor-cli"
    conn.project_id = "p1"
    conn.cli_path = "agent"
    conn.cli_args_json = None
    conn.model_name = "auto"

    draft = llm_base.TestCaseDraft(
        title="TC1",
        type="Unit",
        priority="Cao",
        severity="Nặng",
        module="M",
        precondition="",
        steps="1. a",
        expected_result="ok",
        test_data="",
        automation_ready=False,
    )

    adapter = CursorCLIAdapter("p1", cli_path="agent")
    adapter.generate_test_cases = AsyncMock(return_value=[draft])  # type: ignore[method-assign]
    adapter.last_session_key = "sess"
    adapter.last_cursor_chat_id = "chat-99"

    with patch.object(svc, "get_adapter_for_connection", return_value=adapter):
        with patch.object(svc, "connection_runner_mode", return_value=svc.RUNNER_AI_CLI):
            drafts, meta = asyncio.run(
                svc.generate_test_cases_for_connection(
                    conn,
                    "T",
                    "body",
                    GenerateContext(),
                    resume_chat_id="chat-99",
                )
            )

    assert len(drafts) == 1
    assert meta["cursorChatId"] == "chat-99"
    assert adapter.generate_test_cases.await_args.kwargs.get("resume_chat_id") == "chat-99"
