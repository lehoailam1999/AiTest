"""P9 — Agent APIs (Business Analyzer first)."""

from __future__ import annotations

import logging
import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError
from app.models.domain import AiBackendConnection, Project, TestCase
from app.responses import errors, ok
from app.services.business_analyzer import (
    build_analyze_intent_prompts,
    heuristic_business_intent,
    parse_business_intent_json,
)
from app.services.connection_service import connection_api_key, llm_from_connection

router = APIRouter(prefix="/api", tags=["agent"], dependencies=[Depends(get_current_user)])
log = logging.getLogger("aitest.agent")


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.post("/agent/analyze-intent")
async def analyze_intent(request: Request, db: Annotated[Session, Depends(get_db)]):
    """
    P9 — Business Analyzer.

    Body: { projectId, testCaseId, preferHeuristic?: bool }
    Returns BusinessIntent JSON. Never reads source code.
    """
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    prefer_heuristic = bool(body.get("preferHeuristic"))
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
        return errors(404, "test case not found in project")
    if tc.review_status != C.REVIEW_APPROVED:
        return errors(400, "Chỉ Test Case Approved mới phân tích intent để Generate Unit (BR-V2-02)")

    title = tc.title or ""
    module = tc.module
    steps = tc.steps or ""
    expected = tc.expected_result or ""
    precondition = tc.precondition
    test_data = tc.test_data

    def _heuristic() -> dict:
        intent = heuristic_business_intent(
            title=title,
            module=module,
            steps=steps,
            expected=expected,
            precondition=precondition,
            test_data=test_data,
        )
        intent["testCaseId"] = str(tc.id)
        intent["testCaseKey"] = tc.test_case_code
        return intent

    if prefer_heuristic:
        return ok(_heuristic())

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == project_id)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        log.info("P9 analyze-intent: AI not ready — heuristic fallback project=%s", project_id)
        return ok(_heuristic())

    try:
        api_key = connection_api_key(conn)
        provider = llm_from_connection(conn)
    except (ValueError, LLMError) as exc:
        log.warning("P9 analyze-intent connection error: %s — heuristic", exc)
        return ok(_heuristic())

    system, user = build_analyze_intent_prompts(
        title=title,
        module=module,
        steps=steps,
        expected=expected,
        precondition=precondition,
        test_data=test_data,
        tc_type=tc.type,
    )
    try:
        raw = await provider.chat(api_key, system, user)
        intent = parse_business_intent_json(raw)
        intent["source"] = "llm"
        intent["testCaseId"] = str(tc.id)
        intent["testCaseKey"] = tc.test_case_code
        return ok(intent)
    except Exception as exc:  # noqa: BLE001
        log.warning("P9 analyze-intent LLM failed: %s — heuristic", exc)
        intent = _heuristic()
        intent["fallbackReason"] = str(exc)[:200]
        return ok(intent)
