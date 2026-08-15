"""Tests for AI CLI JSON parser + runner mode routing."""

from __future__ import annotations

import types

from app.llm.cli.json_parser import clean_and_parse_json_array
from app.services.ai_service import (
    RUNNER_AI_CLI,
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
    assert connection_runner_mode(conn) == RUNNER_AI_CLI
    conn.runner_mode = "API_DIRECT"
    assert connection_runner_mode(conn) == RUNNER_AI_CLI


def test_get_adapter_always_cli():
    from app.services.ai_service import get_adapter_for_connection
    from app.llm.cli.adapters.base_cli import BaseCLIAdapter

    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="API_DIRECT",
        cli_type="cursor-cli",
        cli_path="agent",
        cli_args_json="",
        model_name=None,
    )
    adapter = get_adapter_for_connection(conn)
    assert isinstance(adapter, BaseCLIAdapter)
    assert adapter.vendor == "cursor-cli"


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


def test_build_antigravity_cli_adapter():
    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="antigravity-cli",
        cli_path="",
        cli_args_json="",
        model_name="gemini-3.5-flash-medium",
    )
    adapter = build_cli_adapter(conn)
    assert adapter.vendor == "antigravity-cli"
    cmd = adapter.build_command(oneshot=True)
    assert cmd[0] == "agy"
    assert "-p" in cmd
    assert "--model" in cmd
    assert "gemini-3.5-flash-medium" in cmd

    alias = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="agy",
        cli_path="C:\\tools\\agy.exe",
        cli_args_json='["--print-timeout","15m"]',
        model_name=None,
    )
    adapter2 = build_cli_adapter(alias)
    assert adapter2.vendor == "antigravity-cli"
    cmd2 = adapter2.build_command(oneshot=True)
    assert cmd2[0] == "C:\\tools\\agy.exe"
    assert "--print-timeout" in cmd2


def test_antigravity_health_rejects_cursor_agent_path():
    import asyncio

    conn = types.SimpleNamespace(
        project_id="00000000-0000-0000-0000-000000000001",
        runner_mode="AI_CLI",
        cli_type="antigravity-cli",
        cli_path="agent",
        cli_args_json="",
        model_name=None,
    )
    adapter = build_cli_adapter(conn)
    assert asyncio.run(adapter.health_check()) is False


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

    from app.llm.cli.adapters.gemini_cli import GeminiCLIAdapter

    adapter = GeminiCLIAdapter("00000000-0000-0000-0000-000000000001")
    assert callable(adapter.chat)

    async def fake_run(prompt, *, topic_key=None, **kwargs):
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

    async def fake_run(prompt, *, topic_key=None, **kwargs):
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


def test_cli_adapter_generate_e2e_two_pass_with_scaffold():
    import asyncio

    from app.llm.base import E2ERequest
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter("00000000-0000-0000-0000-000000000001")
    calls: list[str | None] = []

    spec_code = (
        "### FILE: pages/todo.page.ts\n```ts\n"
        "export class TodoPage { constructor(public page: any) {} async gotoFeature() { await this.page.goto('/todos'); } async submitForm() { await this.page.locator('button').click(); } async expectExpectedState() { await this.page.locator('body').waitFor(); } }\n```\n"
        "### FILE: specs/todo.spec.ts\n```ts\n"
        "import { test, expect } from '@playwright/test';\n"
        "import { ensureAuthenticated } from '../fixtures/auth.helper';\n"
        "import { TodoPage } from '../pages/todo.page';\n"
        "// featurePath: /todos\n"
        "// authRole: guest\n"
        "// landmark: todo form\n"
        "test('x', async ({ page }) => {\n"
        "  const pom = new TodoPage(page);\n"
        "  await test.step('0. Đăng nhập / authenticate', async () => { await ensureAuthenticated(page); });\n"
        "  await test.step('1. Feature entry', async () => { await pom.gotoFeature(); });\n"
        "  await test.step('2. Act', async () => { await pom.submitForm(); await page.locator('button').click(); });\n"
        "  await test.step('3. Assert', async () => { await expect(page.locator('body')).toBeVisible(); });\n"
        "});\n"
        "```\n"
    )

    async def fake_run(prompt, *, topic_key=None, prefer_oneshot=None, resume_chat_id=None, **kwargs):
        del prefer_oneshot, resume_chat_id
        calls.append(topic_key)
        return spec_code

    adapter._run_prompt = fake_run  # type: ignore[method-assign]
    req = E2ERequest(
        test_case_title="Todo flow",
        test_case_type="E2E",
        priority="High",
        steps="1. Mo man hinh\n2. Luu",
        expected_result="Thanh cong",
        feature_path="/todos",
        test_data="featurePath: /todos",
        precondition="authRole: guest\nlandmark: todo form",
        pom_scaffold="# class: TodoPage\nrequiredMethods:\n- gotoFeature(...args: unknown[]): Promise<void>",
    )
    out = asyncio.run(adapter.generate_e2e(req))
    assert len(out.files) >= 1
    assert calls[:2] == ["e2e_test_gen_p1", "e2e_test_gen_p2"]


def test_cli_adapter_generate_e2e_single_pass_without_scaffold():
    import asyncio

    from app.llm.base import E2ERequest
    from app.llm.cli.adapters.cursor_cli import CursorCLIAdapter

    adapter = CursorCLIAdapter("00000000-0000-0000-0000-000000000001")
    calls: list[str | None] = []

    async def fake_run(prompt, *, topic_key=None, prefer_oneshot=None, resume_chat_id=None, **kwargs):
        del prompt, prefer_oneshot, resume_chat_id
        calls.append(topic_key)
        return (
            "### FILE: specs/todo.spec.ts\n```ts\n"
            "import { test, expect } from '@playwright/test';\n"
            "import { ensureAuthenticated } from '../fixtures/auth.helper';\n"
            "// featurePath: /todos\n"
            "// authRole: guest\n"
            "// landmark: todo form\n"
            "test('x', async ({ page }) => {\n"
            "  await test.step('0. Đăng nhập / authenticate', async () => { await ensureAuthenticated(page); });\n"
            "  await test.step('1. Feature entry', async () => { await page.goto('/todos'); });\n"
            "  await test.step('2. Act', async () => { await page.locator('button').click(); });\n"
            "  await test.step('3. Assert', async () => { await expect(page.locator('body')).toBeVisible(); });\n"
            "});\n"
            "```\n"
        )

    adapter._run_prompt = fake_run  # type: ignore[method-assign]
    req = E2ERequest(
        test_case_title="Todo flow",
        test_case_type="E2E",
        priority="High",
        steps="1. Mo man hinh",
        expected_result="Thanh cong",
        feature_path="/todos",
        test_data="featurePath: /todos",
        precondition="authRole: guest\nlandmark: todo form",
    )
    _ = asyncio.run(adapter.generate_e2e(req))
    assert calls == ["e2e_test_gen"]
