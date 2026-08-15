"""API: AI xếp hạng path local theo TC — không nhận/ghi source code."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.ai_service import chat_for_connection
from app.services.resolve_source_scope import (
    build_resolve_scope_prompts,
    build_resolve_tokens_prompts,
    parse_resolve_scope_json,
    parse_resolve_tokens_json,
)

router = APIRouter(
    prefix="/api", tags=["resolve-source"], dependencies=[Depends(get_current_user)]
)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.post("/resolve-source-scope")
async def resolve_source_scope(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Body: projectId, testCaseId, candidates: string[] (path relative).
    Trả: { primary, related[], reason } — chỉ path, không content.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    candidates_raw = body.get("candidates")
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")
    if not isinstance(candidates_raw, list) or not candidates_raw:
        return errors(400, "candidates must be a non-empty path array")

    candidates = [
        str(p).replace("\\", "/").strip()
        for p in candidates_raw
        if str(p).strip()
    ][:80]
    if not candidates:
        return errors(400, "candidates empty")

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(400, "AI chưa Ready — vào Settings cấu hình AI CLI và Verify")

    system, user = build_resolve_scope_prompts(
        title=tc.title or "",
        module=tc.module,
        steps=tc.steps or "",
        expected=tc.expected_result or "",
        precondition=tc.precondition,
        test_data=tc.test_data,
        candidates=candidates,
    )
    try:
        raw, _meta = await chat_for_connection(conn, system, user)
        result = parse_resolve_scope_json(raw, candidates)
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"Không xếp hạng được file: {exc}")

    return ok(result)


@router.post("/resolve-source-tokens")
async def resolve_source_tokens(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    Body: projectId, testCaseId.
    Trả: { tokens: string[], reason } — map TC VI → identifier EN để FE lọc path (không gửi source).
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if project_id is None or test_case_id is None:
        return errors(400, "projectId and testCaseId required")

    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    tc = (
        db.query(TestCase)
        .filter(TestCase.id == test_case_id, TestCase.project_id == project_id)
        .first()
    )
    if tc is None:
        return errors(404, "test case not found")

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(400, "AI chưa Ready — vào Settings cấu hình AI CLI và Verify")

    system, user = build_resolve_tokens_prompts(
        title=tc.title or "",
        module=tc.module,
        steps=tc.steps or "",
        expected=tc.expected_result or "",
        precondition=tc.precondition,
        test_data=tc.test_data,
    )
    try:
        raw, _meta = await chat_for_connection(conn, system, user)
        result = parse_resolve_tokens_json(raw)
    except Exception as exc:  # noqa: BLE001
        return errors(400, f"Không map token được: {exc}")

    return ok(result)
