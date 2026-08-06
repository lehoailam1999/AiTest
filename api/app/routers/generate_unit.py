from __future__ import annotations

import logging
import time
import uuid
from typing import Annotated, Any

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError
from app.llm.base import UnitRequest
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.ai_service import (
    RUNNER_AI_CLI,
    connection_runner_mode,
    generate_unit_for_connection,
)
from app.services.context_packet import (
    gaps_from_packet,
    source_under_test_summary,
    test_samples_from_packet,
    testing_hints_from_packet,
    unit_strategy_summary,
)
from app.services.generate_source_resolve import (
    language_from_packet,
    packet_is_usable,
    resolve_from_body_legacy,
    resolve_from_context_packet,
)
from app.services.source_surface import analyze_source_surface
from app.services.project_inspector import (
    ProjectInspector,
    apply_stack_to_generate_fields,
)
from app.services.phase5_gen_input import (
    format_unit_planner_hint,
    merge_related_from_context_files,
    parse_context_files,
    parse_index_version,
    parse_planner,
)

# Short-lived cache — batch generate hits same projectRoot repeatedly
_INSPECT_CACHE: dict[str, tuple[float, Any]] = {}
_INSPECT_TTL_SEC = 120.0


def _cached_inspect_project(
    project_root: str,
    *,
    source_relative_path: str | None,
    module: str,
    package_prefix: str | None,
):
    key = f"{project_root}|{source_relative_path or ''}|{module}|{package_prefix or ''}"
    now = time.monotonic()
    hit = _INSPECT_CACHE.get(key)
    if hit and now - hit[0] < _INSPECT_TTL_SEC:
        return hit[1]
    stack = ProjectInspector.inspect_project(
        project_root,
        source_relative_path=source_relative_path,
        module=module,
        package_prefix=package_prefix,
    )
    _INSPECT_CACHE[key] = (now, stack)
    if len(_INSPECT_CACHE) > 64:
        # Drop oldest
        oldest = sorted(_INSPECT_CACHE.items(), key=lambda kv: kv[1][0])[:16]
        for k, _ in oldest:
            _INSPECT_CACHE.pop(k, None)
    return stack

router = APIRouter(
    prefix="/api", tags=["generate-unit"], dependencies=[Depends(get_current_user)]
)

log = logging.getLogger("aitest.generate")


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.post("/generate-unit")
async def generate_unit_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")
    has_packet = packet_is_usable(body.get("contextPacket"))
    has_workspace = bool(str(body.get("workspaceId") or "").strip())
    has_context_files = bool(
        parse_context_files(body.get("contextFiles") or body.get("context_files"))
    )
    if (
        not (body.get("sourceCode") or "").strip()
        and not has_packet
        and not has_workspace
        and not has_context_files
    ):
        return errors(
            400,
            "sourceCode, contextPacket, workspaceId, or contextFiles required",
        )

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found in project")
    if tc.review_status != C.REVIEW_APPROVED:
        return errors(400, "Chỉ Test Case Approved mới Generate Unit Test (BR-03)")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(
            400,
            "AI chưa Ready — vào Cấu hình AI thiết lập AI CLI và Verify",
        )

    packet = body.get("contextPacket") if isinstance(body.get("contextPacket"), dict) else None
    workspace_id = str(body.get("workspaceId") or "").strip() or None
    language = (body.get("language") or "").strip() or (project.language or "")
    language = language_from_packet(packet, language)

    # --- P4: packet-only when usable (workspaceId / body.sourceCode must not win) ---
    if has_packet and packet is not None:
        resolved = resolve_from_context_packet(
            packet,
            workspace_id=workspace_id,
            body_source_code=str(body.get("sourceCode") or ""),
            body_source_file_name=str(body.get("sourceFileName") or ""),
        )
        source_file_name = resolved.source_file_name
        source_code = resolved.source_code
        related_sources = resolved.related_sources
    elif workspace_id:
        from app.features.workspace.di import get_workspace_service
        from app.features.workspace.generate_scope import resolve_generate_scope

        log.warning(
            "P4 deprecation: generate-unit workspace expand fallback workspaceId=%s "
            "(send contextPacket from Desktop Context Builder)",
            workspace_id,
        )
        svc = get_workspace_service()
        session = svc.get(workspace_id)
        if session is None:
            return errors(404, "workspace not found")
        if session.project_id != str(project_id):
            return errors(400, "workspace does not belong to project")
        try:
            scope = await resolve_generate_scope(
                svc,
                workspace_id,
                module=tc.module or "",
                title=tc.title or "",
                body=body,
            )
        except Exception as exc:  # noqa: BLE001
            return errors(400, f"workspace resolve failed: {exc}")
        source_file_name = scope.get("primary") or body.get("sourceFileName") or ""
        source_code = scope.get("primaryContent") or ""
        related_sources = [
            (r["path"], r["content"])
            for r in (scope.get("related") or [])
            if r.get("path") and r.get("content")
        ]
        if not source_code.strip():
            return errors(
                400,
                "Không đọc được source từ workspace — chọn file hoặc kiểm tra index",
            )
    else:
        resolved = resolve_from_body_legacy(body)
        source_file_name = resolved.source_file_name
        source_code = resolved.source_code
        related_sources = resolved.related_sources

    # Phase 5 — optional contextFiles / planner (packet & workspace still win)
    context_files = parse_context_files(body.get("contextFiles") or body.get("context_files"))
    related_sources = merge_related_from_context_files(
        related_sources,
        context_files,
        primary_path=source_file_name,
    )
    if not (source_code or "").strip() and context_files:
        source_file_name = context_files[0][0]
        source_code = context_files[0][1]
        related_sources = merge_related_from_context_files(
            [],
            context_files,
            primary_path=source_file_name,
        )

    if not source_code.strip():
        return errors(
            400,
            "sourceCode required — gửi contextPacket/sourceCode hoặc workspaceId",
        )

    # Prefer language from source path when body/project language is a mashup
    # (e.g. Forensic "C# + TypeScript") or mismatched with file under test.
    src_name = (source_file_name or str(body.get("sourceFileName") or "")).lower()
    if src_name.endswith(".cs") and (
        not language
        or "+" in language
        or any(x in language.lower() for x in ("typescript", "javascript", "node"))
    ):
        language = "C#"
    elif src_name.endswith((".ts", ".tsx")) and (
        not language or "+" in language or "c#" in language.lower()
    ):
        language = "TypeScript"

    packet_dict = packet if has_packet else None
    hints = testing_hints_from_packet(packet_dict)
    body_fw = (body.get("framework") or "").strip()
    testing_fw = hints.get("testing_framework") or body_fw
    if body_fw and body_fw.lower() not in ("auto", "default"):
        framework = body_fw
    else:
        framework = testing_fw or body_fw

    # Step 2 — ProjectInspector: điền language/framework khi auto/empty
    stack_inspect = None
    project_root = str(body.get("projectRoot") or body.get("project_root") or "").strip()
    if project_root:
        try:
            pkg_prefix = body.get("packagePrefix", body.get("package_prefix"))
            stack_inspect = _cached_inspect_project(
                project_root,
                source_relative_path=source_file_name
                or str(body.get("sourceFileName") or "")
                or None,
                module=(body.get("module") or hints.get("module") or tc.module or "")
                or "",
                package_prefix=(
                    None
                    if pkg_prefix is None
                    else str(pkg_prefix)
                ),
            )
            language, framework, testing_fw = apply_stack_to_generate_fields(
                language=language,
                framework=framework,
                testing_framework=testing_fw or framework,
                stack=stack_inspect,
            )
        except Exception as exc:  # noqa: BLE001
            log.warning("project inspect failed root=%s: %s", project_root, exc)

    fw_l = (framework or "").lower()
    lang_l = language.lower()
    if any(x in lang_l for x in ("c#", "csharp", ".net")) and fw_l in (
        "jest",
        "vitest",
        "mocha",
    ):
        framework = "xunit"
        testing_fw = "xunit"
    elif any(x in lang_l for x in ("typescript", "javascript")) and fw_l in (
        "xunit",
        "nunit",
        "mstest",
    ):
        framework = testing_fw if testing_fw.lower() in ("jest", "vitest", "mocha") else "jest"

    class_name = (body.get("className") or "").strip()
    method_name = (body.get("methodName") or "").strip()
    if packet_dict and isinstance(packet_dict.get("sourceUnderTest"), dict):
        sut = packet_dict["sourceUnderTest"]
        if not class_name and sut.get("symbol"):
            class_name = str(sut["symbol"])
        if not method_name:
            methods = sut.get("methods")
            if isinstance(methods, list) and methods:
                method_name = str(methods[0])

    sut_summary = source_under_test_summary(packet_dict)
    strategy_summary = unit_strategy_summary(packet_dict)
    samples = test_samples_from_packet(packet_dict)
    gaps = gaps_from_packet(packet_dict)

    if not sut_summary.strip() and source_code.strip():
        surface = analyze_source_surface(
            path=source_file_name,
            content=source_code,
            language=language,
            test_case_title=tc.title or "",
        )
        if not class_name and surface.get("symbol"):
            class_name = str(surface["symbol"])
        if not method_name:
            methods = surface.get("methods")
            if isinstance(methods, list) and methods:
                method_name = str(methods[0])
        sut_summary = str(surface.get("source_under_test_summary") or "")
        strategy_summary = str(surface.get("unit_strategy_summary") or "")

    req_title = str(body.get("requirementTitle") or body.get("requirement_title") or "").strip()
    req_desc = str(body.get("requirementDescription") or body.get("requirement_description") or "").strip()

    if not req_title and tc.source_id:
        from app.models.domain import Requirement
        req_obj = db.query(Requirement).filter(Requirement.id == tc.source_id).first()
        if req_obj:
            req_title = req_obj.title or ""
            req_desc = req_obj.description or ""

    from app.llm.ai_rules import parse_project_meta, rules_pair_from_meta

    proj_rules, usr_rules = rules_pair_from_meta(
        parse_project_meta(getattr(project, "meta", None)),
        language=language or project.language,
    )

    # Phase 5 extras — optional; ignored when absent (legacy clients unchanged)
    planner = parse_planner(body.get("planner"))
    index_version = parse_index_version(body.get("indexVersion") or body.get("index_version"))

    req = UnitRequest(
        test_case_title=tc.title,
        test_case_type=tc.type,
        priority=tc.priority,
        steps=tc.steps,
        expected_result=tc.expected_result,
        precondition=tc.precondition or "",
        test_data=tc.test_data or "",
        source_file_name=source_file_name,
        source_code=source_code,
        class_name=class_name,
        method_name=method_name,
        framework=framework,
        language=language,
        related_sources=related_sources,
        repair_context=(body.get("repairContext") or "").strip(),
        module=(body.get("module") or hints.get("module") or tc.module or "") or "",
        package_prefix=(
            None
            if body.get("packagePrefix") is None and body.get("package_prefix") is None
            else str(body.get("packagePrefix", body.get("package_prefix")) or "")
        ),
        testing_framework=testing_fw or framework,
        mock_framework=hints.get("mock_framework") or "",
        assertion_library=hints.get("assertion_library") or "",
        source_under_test_summary=sut_summary,
        unit_strategy_summary=strategy_summary,
        test_samples=samples,
        context_gaps=gaps,
        requirement_title=req_title,
        requirement_description=req_desc,
        project_rules=proj_rules,
        user_rules=usr_rules,
        planner_hint=format_unit_planner_hint(planner),
        index_version=index_version,
    )
    try:
        result, meta = await generate_unit_for_connection(conn, req)
    except LLMError as exc:
        return errors(400, f"generate unit failed: {exc}")
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"generate unit failed: {exc}")

    provider_label = meta.get("provider") or "ai-cli"
    return ok(
        {
            "code": result.code,
            "suggestedPath": result.suggested_path,
            "fileName": result.file_name,
            "testCaseId": str(tc.id),
            "projectId": str(project_id),
            "provider": provider_label,
            "runnerUsed": meta.get("runnerUsed") or RUNNER_AI_CLI,
            "cliSessionKey": meta.get("cliSessionKey"),
            "stackInspect": stack_inspect.to_dict() if stack_inspect else None,
            "contextSource": body.get("contextSource")
            or ("packet" if has_packet else ("workspace" if workspace_id else "body")),
            "agentConfidence": body.get("agentConfidence"),
            "agentEnough": body.get("agentEnough"),
            "agentOverride": bool(body.get("agentOverride")),
            "indexVersion": index_version or None,
            "plannerAttached": bool(planner),
        }
    )


@router.post("/project-inspect")
async def project_inspect_route(request: Request):
    """
    Step 2 — quét manifest local (projectRoot) → language / framework / runCommand.
    Desktop gọi khi bind root hoặc trước Sinh Unit.
    """
    body = await request.json()
    project_root = str(body.get("projectRoot") or body.get("project_root") or "").strip()
    if not project_root:
        return errors(400, "projectRoot required")
    source = str(body.get("sourceFileName") or body.get("source_file_name") or "").strip()
    module = str(body.get("module") or "").strip()
    pkg = body.get("packagePrefix", body.get("package_prefix"))
    try:
        info = ProjectInspector.inspect_project(
            project_root,
            source_relative_path=source or None,
            module=module,
            package_prefix=None if pkg is None else str(pkg),
        )
    except ValueError as exc:
        return errors(400, str(exc))
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"inspect failed: {exc}")
    return ok(info.to_dict())


@router.post("/unit-sandbox-repair")
async def unit_sandbox_repair_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Step 3 — chạy sandbox auto-repair trên projectRoot (cùng máy API).
    Body: projectId, testCaseId, projectRoot, code, testFileRel?, maxRetries?
    + các field generate (language/framework/source…) để AI sửa đúng ngữ cảnh.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    project_root = str(body.get("projectRoot") or "").strip()
    code = str(body.get("code") or "").strip()
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")
    if not project_root:
        return errors(400, "projectRoot required")
    if not code:
        return errors(400, "code required")

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")
    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found in project")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(400, "AI chưa Ready — Verify CLI/API trước")

    from app.services.unit_test_orchestrator import (
        DEFAULT_MAX_RETRIES,
        UnitTestOrchestrator,
    )

    source_file = str(body.get("sourceFileName") or "").strip()
    module = str(body.get("module") or tc.module or "").strip()
    pkg = body.get("packagePrefix", body.get("package_prefix"))
    package_prefix = None if pkg is None else str(pkg)
    test_rel = str(body.get("testFileRel") or body.get("suggestedPath") or "").strip()
    max_retries = int(body.get("maxRetries") or DEFAULT_MAX_RETRIES)
    max_retries = max(1, min(max_retries, 5))

    try:
        orch = UnitTestOrchestrator(
            project_root,
            source_relative_path=source_file or None,
            module=module,
            package_prefix=package_prefix,
        )
        if not test_rel:
            test_rel = orch.resolve_test_rel(
                source_file_path=source_file or "SUT",
                suggested_path=str(body.get("suggestedPath") or "") or None,
                module=module,
                package_prefix=package_prefix,
            )
        from app.llm.ai_rules import parse_project_meta, rules_pair_from_meta

        lang = str(body.get("language") or orch.stack.language or project.language or "")
        proj_rules, usr_rules = rules_pair_from_meta(
            parse_project_meta(getattr(project, "meta", None)),
            language=lang or project.language,
        )
        req = UnitRequest(
            test_case_title=tc.title,
            test_case_type=tc.type,
            priority=tc.priority,
            steps=tc.steps,
            expected_result=tc.expected_result,
            precondition=tc.precondition or "",
            test_data=tc.test_data or "",
            source_file_name=source_file,
            source_code=str(body.get("sourceCode") or ""),
            class_name=str(body.get("className") or ""),
            method_name=str(body.get("methodName") or ""),
            framework=str(body.get("framework") or orch.stack.framework),
            language=lang,
            module=module,
            package_prefix=package_prefix,
            testing_framework=str(body.get("framework") or orch.stack.framework),
            project_rules=proj_rules,
            user_rules=usr_rules,
        )
        sandbox = await orch.execute_sandbox_and_auto_repair(
            initial_code=code,
            test_file_rel=test_rel,
            req=req,
            conn=conn,
            max_retries=max_retries,
            write_file=bool(body.get("writeFile", True)),
        )
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"sandbox repair failed: {exc}")

    return ok(
        {
            "status": sandbox.status,
            "code": sandbox.code,
            "testFilePath": sandbox.test_file_path,
            "attempts": sandbox.attempts,
            "errorLog": sandbox.error_log,
            "history": [
                {
                    "attempt": h.attempt,
                    "exitCode": h.exit_code,
                    "success": h.success,
                    "logExcerpt": h.log_excerpt,
                }
                for h in sandbox.history
            ],
            "stackInspect": sandbox.stack,
            "runnerUsed": connection_runner_mode(conn),
            "failureClass": sandbox.failure_class,
        }
    )
