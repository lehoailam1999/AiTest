"""Tests for UnitTestOrchestrator sandbox auto-repair (Step 3)."""

from __future__ import annotations

import asyncio

from app.llm.base import UnitRequest
from app.services.unit_test_orchestrator import (
    UnitTestOrchestrator,
    build_repair_prompt_context,
    extract_code_block,
)


def _req(**kwargs) -> UnitRequest:
    base = dict(
        test_case_title="T",
        test_case_type="Functional",
        priority="High",
        steps="1",
        expected_result="ok",
        precondition="",
        test_data="",
        source_file_name="src/auth.ts",
        source_code="export const n = 1;",
        class_name="Auth",
        method_name="",
        framework="jest",
        language="TypeScript",
        module="Auth",
    )
    base.update(kwargs)
    return UnitRequest(**base)


def test_extract_code_block():
    raw = "Here\n```ts\nconst x = 1;\n```\n"
    assert extract_code_block(raw) == "const x = 1;"


def test_build_repair_prompt_context():
    ctx = build_repair_prompt_context(
        test_file_rel="AItest/UnitTest/Auth/auth.spec.ts",
        run_command=["npx", "vitest", "run"],
        error_log="FAIL expected 1",
        attempt=1,
        max_retries=3,
    )
    assert "attempt 1/3" in ctx
    assert "vitest" in ctx
    assert "FAIL expected 1" in ctx


def test_sandbox_auto_repair_succeeds_on_second_attempt(tmp_path):
    (tmp_path / "package.json").write_text('{"name":"t"}', encoding="utf-8")
    orch = UnitTestOrchestrator(str(tmp_path), source_relative_path="src/a.ts")
    calls = {"run": 0, "fix": 0}

    async def run_fn(cmd, cwd):
        calls["run"] += 1
        if calls["run"] == 1:
            return 1, "AssertionError: expected true"
        return 0, "ok"

    async def fix_fn(req, repair_ctx):
        calls["fix"] += 1
        assert "AssertionError" in repair_ctx
        return "```ts\nexport function ok() { return true }\n```"

    result = asyncio.run(
        orch.execute_sandbox_and_auto_repair(
            initial_code="bad",
            test_file_rel="AItest/UnitTest/Auth/a.spec.ts",
            req=_req(),
            max_retries=3,
            run_fn=run_fn,
            fix_fn=fix_fn,
            write_file=True,
        )
    )
    assert result.status == "PASSED"
    assert result.attempts == 2
    assert calls["fix"] == 1
    assert "ok()" in result.code
    written = (tmp_path / "AItest/UnitTest/Auth/a.spec.ts").read_text(encoding="utf-8")
    assert "ok()" in written


def test_sandbox_auto_repair_fails_after_max(tmp_path):
    orch = UnitTestOrchestrator(str(tmp_path))

    async def run_fn(cmd, cwd):
        return 1, "always fail"

    async def fix_fn(req, repair_ctx):
        return "```js\nstill bad\n```"

    result = asyncio.run(
        orch.execute_sandbox_and_auto_repair(
            initial_code="x",
            test_file_rel="AItest/UnitTest/x.test.js",
            req=_req(),
            max_retries=3,
            run_fn=run_fn,
            fix_fn=fix_fn,
            write_file=False,
        )
    )
    assert result.status == "FAILED"
    assert result.attempts == 3
    assert len(result.history) == 3
