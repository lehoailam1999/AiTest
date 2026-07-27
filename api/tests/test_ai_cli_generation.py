"""Tests for AI CLI JSON parser + runner mode routing."""

from __future__ import annotations

import types

from app.llm.cli.json_parser import clean_and_parse_json_array
from app.services.ai_service import (
    RUNNER_AI_CLI,
    RUNNER_API_DIRECT,
    connection_runner_mode,
    build_cli_adapter,
)


def test_parse_json_from_fence():
    raw = """Here you go:
```json
[{"title": "Đăng nhập OK", "type": "Chức năng", "steps": "1. Mở app"}]
```
"""
    rows = clean_and_parse_json_array(raw)
    assert rows[0]["title"] == "Đăng nhập OK"


def test_parse_test_cases_object():
    raw = '{"testCases":[{"title":"A","steps":"1"}]}'
    rows = clean_and_parse_json_array(raw)
    assert len(rows) == 1
    assert rows[0]["title"] == "A"


def test_connection_runner_mode():
    conn = types.SimpleNamespace(runner_mode="AI_CLI")
    assert connection_runner_mode(conn) == RUNNER_AI_CLI
    conn.runner_mode = None
    assert connection_runner_mode(conn) == RUNNER_API_DIRECT


def test_build_gemini_cli_adapter():
    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="gemini-cli",
        cli_path="gemini",
        cli_args_json='["--yolo"]',
        model_name=None,
    )
    adapter = build_cli_adapter(conn)
    assert adapter.vendor == "gemini-cli"
    cmd = adapter.build_command(oneshot=True)
    assert cmd[0] == "gemini"
    assert "-p" in cmd
    assert "--yolo" in cmd


def test_build_cursor_cli_adapter():
    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="cursor-cli",
        cli_path="agent",
        cli_args_json="",
        model_name=None,
    )
    adapter = build_cli_adapter(conn)
    assert adapter.vendor == "cursor-cli"
    cmd = adapter.build_command(oneshot=True)
    assert cmd[0] == "agent"
    assert "--print" in cmd
    assert "--mode" in cmd
    assert "ask" in cmd


def test_resolve_command_wraps_cmd_on_windows(tmp_path):
    import sys

    from app.llm.cli.process_runner import resolve_command

    if sys.platform != "win32":
        return
    # Prefer .ps1 beside .cmd (Cursor agent layout)
    cmd = tmp_path / "agent.cmd"
    ps1 = tmp_path / "agent.ps1"
    cmd.write_text("@echo off\n")
    ps1.write_text("# noop\n")
    out = resolve_command([str(cmd), "--print", "hi"])
    assert "powershell" in out[0].lower()
    assert str(ps1) in out

    # .cmd only → single /c cmdline (spaces-safe)
    only = tmp_path / "only.cmd"
    only.write_text("@echo off\n")
    out2 = resolve_command([str(only), "--print", "hello world"])
    assert out2[0].lower() == "cmd.exe"
    assert "/c" in out2
    assert str(only) in out2[-1]


def test_build_cursor_includes_trust():
    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="cursor-cli",
        cli_path="agent",
        cli_args_json="",
        model_name=None,
    )
    adapter = build_cli_adapter(conn)
    cmd = adapter.build_command(oneshot=True)
    assert "--trust" in cmd
    assert "--model" in cmd
    assert "auto" in cmd


def test_exc_detail_notimplemented():
    from app.llm.cli.process_runner import _exc_detail

    assert "NotImplementedError" in _exc_detail(NotImplementedError())


def test_cli_adapter_has_chat():
    import asyncio

    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter("00000000-0000-0000-0000-000000000001")
    assert callable(adapter.chat)

    async def fake_run(prompt, *, topic_key=None):
        assert "SYS" in prompt and "USER" in prompt
        assert topic_key == "knowledge-chat"
        return '{"summary":"ok"}'

    adapter._run_prompt = fake_run  # type: ignore[method-assign]
    out = asyncio.run(adapter.chat("SYS", "USER"))
    assert out == '{"summary":"ok"}'


def test_cli_adapter_generate_unit():
    import asyncio

    from app.llm.base import UnitRequest
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter("00000000-0000-0000-0000-000000000001")

    async def fake_run(prompt, *, topic_key=None):
        assert topic_key == "unit_test_gen"
        assert "unit" in prompt.lower() or "test" in prompt.lower()
        return "```typescript\nexport function testOk() { expect(1).toBe(1); }\n```"

    adapter._run_prompt = fake_run  # type: ignore[method-assign]
    req = UnitRequest(
        test_case_title="Login OK",
        test_case_type="Functional",
        priority="High",
        steps="1. Open",
        expected_result="OK",
        precondition="",
        test_data="",
        source_file_name="src/auth.ts",
        source_code="export function login() { return true; }",
        class_name="Auth",
        method_name="login",
        framework="jest",
        language="TypeScript",
        module="Auth",
    )
    result = asyncio.run(adapter.generate_unit(req))
    assert "expect(1)" in result.code
    assert result.file_name
    assert "AItest" in result.suggested_path.replace("\\", "/") or "UnitTest" in result.suggested_path

