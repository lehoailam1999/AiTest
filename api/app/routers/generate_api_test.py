from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError, generate_api_test
from app.llm.base import UnitRequest
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.connection_service import connection_api_key, llm_from_connection
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

log = logging.getLogger("aitest.generate")

router = APIRouter(
    prefix="/api", tags=["generate-api-test"], dependencies=[Depends(get_current_user)]
)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.post("/generate-api-test")
async def generate_api_test_route(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")

    open_api = (body.get("openApiSpec") or "").strip()
    has_packet = packet_is_usable(body.get("contextPacket"))
    has_workspace = bool(str(body.get("workspaceId") or "").strip())
    if (
        not (body.get("sourceCode") or "").strip()
        and not open_api
        and not has_packet
        and not has_workspace
    ):
        return errors(
            400,
            "sourceCode, openApiSpec, contextPacket, or workspaceId required",
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
        return errors(400, "Chỉ Test Case Approved mới Generate API Test (BR-03)")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(400, "AI chưa Ready — vào Settings cấu hình API Key và Verify")
    try:
        api_key = connection_api_key(conn)
    except ValueError as exc:
        return errors(400, str(exc))

    try:
        provider = llm_from_connection(conn)
    except LLMError as exc:
        return errors(400, str(exc))

    language = (body.get("language") or "").strip() or (project.language or "")
    packet = body.get("contextPacket") if isinstance(body.get("contextPacket"), dict) else None
    workspace_id = str(body.get("workspaceId") or "").strip() or None
    language = language_from_packet(packet, language)
    related_sources: list[tuple[str, str]] = []

    # P4: packet wins over workspaceId / body.sourceCode
    if has_packet and packet is not None:
        resolved = resolve_from_context_packet(
            packet,
            workspace_id=workspace_id,
            body_source_code=str(body.get("sourceCode") or ""),
            body_source_file_name=str(body.get("sourceFileName") or ""),
        )
        related_sources = resolved.related_sources
        source_file_name = resolved.source_file_name
        source_code = resolved.source_code
    elif workspace_id:
        from app.features.workspace.di import get_workspace_service
        from app.features.workspace.generate_scope import resolve_generate_scope

        log.warning(
            "P4 deprecation: generate-api-test workspace expand fallback workspaceId=%s",
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
        if not source_code.strip() and not open_api:
            return errors(
                400,
                "Không đọc được source từ workspace — chọn file/OpenAPI hoặc kiểm tra index",
            )
    else:
        if (body.get("sourceCode") or "").strip():
            resolved = resolve_from_body_legacy(body)
            related_sources = resolved.related_sources
            source_file_name = resolved.source_file_name
            source_code = resolved.source_code
        else:
            source_file_name = str(body.get("sourceFileName") or "")
            source_code = ""

    packet_dict = packet if has_packet else None
    hints = testing_hints_from_packet(packet_dict)
    body_fw = (body.get("framework") or "").strip()
    testing_fw = hints.get("testing_framework") or body_fw
    if body_fw and body_fw.lower() not in ("auto", "default"):
        framework = body_fw
    else:
        framework = testing_fw or body_fw

    from app.llm.ai_rules import parse_project_meta, rules_pair_from_meta

    proj_rules, usr_rules = rules_pair_from_meta(
        parse_project_meta(getattr(project, "meta", None)),
        language=language or project.language,
    )

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
        class_name=body.get("className") or "",
        method_name=body.get("methodName") or "",
        framework=framework,
        language=language,
        related_sources=related_sources,
        repair_context=(body.get("repairContext") or "").strip(),
        open_api_spec=open_api,
        module=(body.get("module") or hints.get("module") or tc.module or "") or "",
        package_prefix=(
            None
            if body.get("packagePrefix") is None and body.get("package_prefix") is None
            else str(body.get("packagePrefix", body.get("package_prefix")) or "")
        ),
        testing_framework=testing_fw or framework,
        mock_framework=hints.get("mock_framework") or "",
        assertion_library=hints.get("assertion_library") or "",
        source_under_test_summary=source_under_test_summary(packet_dict),
        unit_strategy_summary=unit_strategy_summary(packet_dict),
        test_samples=test_samples_from_packet(packet_dict),
        context_gaps=gaps_from_packet(packet_dict),
        project_rules=proj_rules,
        user_rules=usr_rules,
    )
    try:
        result = await generate_api_test(provider, api_key, req)
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"generate api test failed: {exc}")

    return ok(
        {
            "code": result.code,
            "suggestedPath": result.suggested_path,
            "fileName": result.file_name,
            "testCaseId": str(tc.id),
            "projectId": str(project_id),
            "provider": provider.name,
            "contextSource": "packet" if has_packet else ("workspace" if workspace_id else "body"),
        }
    )
