"""Integration test generation (P5e / W7) — same pipeline as unit with kind=integration."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError, generate_unit
from app.llm.base import UnitRequest
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.connection_service import connection_api_key, llm_from_connection
from app.services.context_packet import (
    gaps_from_packet,
    primary_from_packet,
    related_sources_from_packet,
    source_under_test_summary,
    test_samples_from_packet,
    testing_hints_from_packet,
    unit_strategy_summary,
)

router = APIRouter(
    prefix="/api",
    tags=["generate-integration"],
    dependencies=[Depends(get_current_user)],
)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.post("/generate-integration-test")
async def generate_integration_test_route(
    request: Request, db: Annotated[Session, Depends(get_db)]
):
    """Phase 2 Integration — Desktop gửi contextPacket; Verify/Apply vẫn local."""
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")

    has_packet = (
        isinstance(body.get("contextPacket"), dict)
        and body.get("contextPacket", {}).get("packetVersion") == 1
    )
    if not (body.get("sourceCode") or "").strip() and not has_packet:
        return errors(400, "sourceCode or contextPacket required")

    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
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
        return errors(400, "Chỉ Test Case Approved mới Generate Integration Test")

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
    except Exception as exc:  # noqa: BLE001
        return errors(400, str(exc))

    packet = body.get("contextPacket") if has_packet else None
    packet_dict = packet if isinstance(packet, dict) else None
    primary = primary_from_packet(packet_dict) if packet_dict else None
    primary_name = primary[0] if primary else ""
    primary_code = primary[1] if primary else ""
    source_code = (body.get("sourceCode") or primary_code or "").strip()
    source_file = (body.get("sourceFileName") or primary_name or "SUT").strip()
    related = related_sources_from_packet(packet_dict) if packet_dict else []
    hints = testing_hints_from_packet(packet_dict)
    body_fw = (body.get("framework") or project.framework or "").strip()
    testing_fw = hints.get("testing_framework") or body_fw
    if body_fw and body_fw.lower() not in ("auto", "default"):
        framework = body_fw
    else:
        framework = testing_fw or body_fw

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

    req = UnitRequest(
        test_case_title=tc.title,
        test_case_type=tc.type or "Integration",
        priority=tc.priority or "Medium",
        steps=tc.steps or "",
        expected_result=tc.expected_result or "",
        precondition=tc.precondition or "",
        test_data=tc.test_data or "",
        source_file_name=source_file,
        source_code=source_code,
        class_name=class_name or "SUT",
        method_name=method_name,
        framework=framework,
        language=(body.get("language") or project.language or ""),
        related_sources=related,
        repair_context=(body.get("repairContext") or ""),
        module=(body.get("module") or hints.get("module") or tc.module or "") or "",
        testing_framework=testing_fw or framework,
        mock_framework=hints.get("mock_framework") or "",
        assertion_library=hints.get("assertion_library") or "",
        source_under_test_summary=source_under_test_summary(packet_dict),
        unit_strategy_summary=unit_strategy_summary(packet_dict),
        test_samples=test_samples_from_packet(packet_dict),
        context_gaps=gaps_from_packet(packet_dict),
    )
    try:
        result = await generate_unit(provider, api_key, req)
    except LLMError as exc:
        return errors(502, str(exc))
    except Exception as exc:  # noqa: BLE001
        return errors(500, f"Integration generate failed: {exc}")

    from app.services.test_output_layout import under_generated_test_folder

    suggested = under_generated_test_folder(
        "integration",
        result.file_name,
        source_file_name=source_file or None,
        module=(body.get("module") or tc.module or "") or None,
    )

    return ok(
        {
            "code": result.code,
            "suggestedPath": suggested,
            "fileName": result.file_name,
            "testCaseId": str(tc.id),
            "projectId": str(project.id),
            "provider": provider.name,
            "artifactKind": "integration",
        }
    )
