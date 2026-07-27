"""
Unit Test Sandbox Auto-Repair Orchestrator — Step 3.

Vòng lặp: ghi file test → chạy runner → nếu fail gửi log cho AI CLI/API sửa → tối đa N lần.
Desktop staging dùng cùng ý tưởng qua autoRepairLoop.ts; module này phục vụ
BE (projectRoot cùng máy) và unit test với runner/fix injectable.
"""

from __future__ import annotations

import asyncio
import logging
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Sequence

from app.llm.base import UnitRequest, UnitResult, strip_code_fences
from app.models.domain import AiBackendConnection
from app.services.ai_service import generate_unit_for_connection
from app.services.project_inspector import ProjectInspector, StackInspect

logger = logging.getLogger(__name__)

DEFAULT_MAX_RETRIES = 3
LOG_TAIL = 2500

RunCommandFn = Callable[[Sequence[str], str], Awaitable[tuple[int, str]]]
FixCodeFn = Callable[[UnitRequest, str], Awaitable[str]]


@dataclass
class SandboxAttempt:
    attempt: int
    exit_code: int
    success: bool
    log_excerpt: str


@dataclass
class SandboxRepairResult:
    status: str  # PASSED | FAILED
    test_file_path: str
    code: str
    attempts: int
    error_log: str | None = None
    history: list[SandboxAttempt] = field(default_factory=list)
    stack: dict | None = None


def extract_code_block(text: str) -> str:
    """Ưu tiên fence ```; fallback strip_code_fences."""
    match = re.search(r"```(?:\w+)?\n(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return strip_code_fences(text).strip()


def build_repair_prompt_context(
    *,
    test_file_rel: str,
    run_command: Sequence[str],
    error_log: str,
    attempt: int,
    max_retries: int,
) -> str:
    cmd = " ".join(run_command)
    return (
        f"Sandbox Auto-Repair attempt {attempt}/{max_retries}\n"
        f"Target file: {test_file_rel}\n"
        f"Command: {cmd}\n\n"
        f"Log lỗi (đuôi):\n```\n{error_log[-LOG_TAIL:]}\n```\n\n"
        "Hãy sửa lại toàn bộ file Unit Test để lệnh trên pass. "
        "Ưu tiên sửa lỗi import/module path (file nằm dưới AItest/, không cùng folder production). "
        "Chỉ trả về mã nguồn đã sửa trong fence ```."
    )


async def _default_run_command(cmd: Sequence[str], cwd: str) -> tuple[int, str]:
    if not cmd:
        return 0, "(skip — empty run_command)"
    proc = await asyncio.create_subprocess_exec(
        *cmd,
        cwd=cwd,
        stdout=asyncio.subprocess.PIPE,
        stderr=asyncio.subprocess.PIPE,
    )
    stdout_b, stderr_b = await proc.communicate()
    out = (stdout_b or b"").decode("utf-8", errors="replace")
    err = (stderr_b or b"").decode("utf-8", errors="replace")
    return int(proc.returncode or 0), f"{out}\n{err}".strip()


async def _default_fix_via_connection(
    conn: AiBackendConnection,
    req: UnitRequest,
    repair_context: str,
) -> str:
    fixed_req = UnitRequest(
        test_case_title=req.test_case_title,
        test_case_type=req.test_case_type,
        priority=req.priority,
        steps=req.steps,
        expected_result=req.expected_result,
        precondition=req.precondition,
        test_data=req.test_data,
        source_file_name=req.source_file_name,
        source_code=req.source_code,
        class_name=req.class_name,
        method_name=req.method_name,
        framework=req.framework,
        language=req.language,
        related_sources=list(req.related_sources),
        repair_context=repair_context,
        module=req.module,
        package_prefix=req.package_prefix,
        testing_framework=req.testing_framework,
        mock_framework=req.mock_framework,
        assertion_library=req.assertion_library,
        source_under_test_summary=req.source_under_test_summary,
        unit_strategy_summary=req.unit_strategy_summary,
        test_samples=list(req.test_samples),
        context_gaps=list(req.context_gaps),
    )
    result, _meta = await generate_unit_for_connection(conn, fixed_req)
    return result.code


class UnitTestOrchestrator:
    """Điều phối Sinh/Verify/Auto-Fix trên project_root (cùng máy với API)."""

    def __init__(
        self,
        project_root: str,
        *,
        stack: StackInspect | None = None,
        source_relative_path: str | None = None,
        module: str = "",
        package_prefix: str | None = None,
    ):
        self.project_root = str(Path(project_root))
        self.stack = stack or ProjectInspector.inspect_project(
            self.project_root,
            source_relative_path=source_relative_path,
            module=module,
            package_prefix=package_prefix,
        )

    def resolve_test_rel(
        self,
        *,
        source_file_path: str,
        suggested_path: str | None = None,
        module: str = "",
        package_prefix: str | None = None,
    ) -> str:
        if suggested_path and suggested_path.strip():
            return suggested_path.replace("\\", "/").lstrip("./")
        info = ProjectInspector.inspect_project(
            self.project_root,
            source_relative_path=source_file_path,
            module=module,
            package_prefix=package_prefix,
        )
        return (info.suggested_unit_path or f"AItest/UnitTest/{Path(source_file_path).stem}Tests.txt").replace(
            "\\", "/"
        )

    async def execute_sandbox_and_auto_repair(
        self,
        *,
        initial_code: str,
        test_file_rel: str,
        req: UnitRequest,
        conn: AiBackendConnection | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        run_command: Sequence[str] | None = None,
        run_fn: RunCommandFn | None = None,
        fix_fn: FixCodeFn | None = None,
        write_file: bool = True,
    ) -> SandboxRepairResult:
        """
        Ghi test_file_rel → chạy run_command → fail thì AI sửa → lặp tối đa max_retries.
        """
        cmd = list(run_command or self.stack.run_command or [])
        runner = run_fn or _default_run_command
        history: list[SandboxAttempt] = []
        code = initial_code
        last_log = ""
        abs_path = Path(self.project_root) / test_file_rel.replace("\\", "/")

        if write_file:
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_text(code, encoding="utf-8")

        for attempt in range(1, max_retries + 1):
            logger.info(
                "Sandbox verify attempt %s/%s file=%s cmd=%s",
                attempt,
                max_retries,
                test_file_rel,
                cmd,
            )
            exit_code, log = await runner(cmd, self.project_root)
            last_log = log
            ok = exit_code == 0
            history.append(
                SandboxAttempt(
                    attempt=attempt,
                    exit_code=exit_code,
                    success=ok,
                    log_excerpt=log[-LOG_TAIL:],
                )
            )
            if ok:
                return SandboxRepairResult(
                    status="PASSED",
                    test_file_path=test_file_rel,
                    code=code,
                    attempts=attempt,
                    error_log=None,
                    history=history,
                    stack=self.stack.to_dict(),
                )

            if attempt >= max_retries:
                break

            repair_ctx = build_repair_prompt_context(
                test_file_rel=test_file_rel,
                run_command=cmd,
                error_log=log,
                attempt=attempt,
                max_retries=max_retries,
            )
            # Put broken code into source_code slot for model context when repairing
            repair_req = UnitRequest(
                test_case_title=req.test_case_title,
                test_case_type=req.test_case_type,
                priority=req.priority,
                steps=req.steps,
                expected_result=req.expected_result,
                precondition=req.precondition,
                test_data=req.test_data,
                source_file_name=req.source_file_name or test_file_rel,
                source_code=req.source_code or code,
                class_name=req.class_name,
                method_name=req.method_name,
                framework=req.framework or self.stack.framework,
                language=req.language or self.stack.language,
                related_sources=[(test_file_rel, code), *list(req.related_sources)],
                repair_context=repair_ctx,
                module=req.module,
                package_prefix=req.package_prefix,
                testing_framework=req.testing_framework or self.stack.framework,
                mock_framework=req.mock_framework,
                assertion_library=req.assertion_library,
                source_under_test_summary=req.source_under_test_summary,
                unit_strategy_summary=req.unit_strategy_summary,
                test_samples=list(req.test_samples),
                context_gaps=list(req.context_gaps),
            )

            if fix_fn is not None:
                fixed = await fix_fn(repair_req, repair_ctx)
            elif conn is not None:
                fixed = await _default_fix_via_connection(conn, repair_req, repair_ctx)
            else:
                raise ValueError("Sandbox repair cần conn hoặc fix_fn")

            code = extract_code_block(fixed) or fixed
            if req.source_file_name:
                from app.services.test_output_layout import rewrite_sut_imports

                code = rewrite_sut_imports(
                    code,
                    test_rel=test_file_rel,
                    source_rel=req.source_file_name,
                )
            if write_file:
                abs_path.write_text(code, encoding="utf-8")

        return SandboxRepairResult(
            status="FAILED",
            test_file_path=test_file_rel,
            code=code,
            attempts=max_retries,
            error_log=last_log[-LOG_TAIL:] if last_log else None,
            history=history,
            stack=self.stack.to_dict(),
        )


async def generate_then_sandbox_repair(
    conn: AiBackendConnection,
    req: UnitRequest,
    *,
    project_root: str,
    max_retries: int = DEFAULT_MAX_RETRIES,
    run_fn: RunCommandFn | None = None,
    write_file: bool = True,
) -> tuple[UnitResult, SandboxRepairResult]:
    """Step 3 helper: generate_unit → sandbox auto-repair trên suggested path."""
    result, _meta = await generate_unit_for_connection(conn, req)
    orch = UnitTestOrchestrator(
        project_root,
        source_relative_path=req.source_file_name or None,
        module=req.module or "",
        package_prefix=req.package_prefix,
    )
    test_rel = orch.resolve_test_rel(
        source_file_path=req.source_file_name or "SUT",
        suggested_path=result.suggested_path,
        module=req.module or "",
        package_prefix=req.package_prefix,
    )
    sandbox = await orch.execute_sandbox_and_auto_repair(
        initial_code=result.code,
        test_file_rel=test_rel,
        req=req,
        conn=conn,
        max_retries=max_retries,
        run_fn=run_fn,
        write_file=write_file,
    )
    final = UnitResult(
        code=sandbox.code,
        suggested_path=result.suggested_path,
        file_name=result.file_name,
    )
    return final, sandbox
