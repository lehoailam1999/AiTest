from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import GenerationTask, Job, Source, TestCase, WorkspaceRun
from app.models.user import User
from app.responses import errors, ok, page, page_params
from app.serializers import testcase_dto
from app.services.requirement_content import source_content_hash
from app.services.vietnamese_labels import priority_vi, severity_vi, type_vi

router = APIRouter(prefix="/api", tags=["testcases"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


@router.get("/testcases")
def list_testcases(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(TestCase)
    qp = request.query_params
    if v := qp.get("projectId"):
        if pid := _uuid(v):
            q = q.filter(TestCase.project_id == pid)
    if v := qp.get("jobId"):
        if jid := _uuid(v):
            q = q.filter(TestCase.job_id == jid)
    for key in ("requirementId", "sourceId"):
        if v := qp.get(key):
            if sid := _uuid(v):
                q = q.filter(TestCase.source_id == sid)
    if v := (qp.get("reviewStatus") or "").strip():
        q = q.filter(TestCase.review_status == v)
    total = q.count()
    items = (
        q.order_by(TestCase.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    source_ids = {t.source_id for t in items if t.source_id}
    hash_by_source: dict[uuid.UUID, str | None] = {}
    if source_ids:
        for src in db.query(Source).filter(Source.id.in_(source_ids)).all():
            hash_by_source[src.id] = source_content_hash(src.content, src.description)
    return ok(
        page(
            [
                testcase_dto(t, hash_by_source.get(t.source_id) if t.source_id else None)
                for t in items
            ],
            total,
            page_number,
            size,
        )
    )


@router.post("/testcases")
async def create_testcase(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    source_id = _uuid(str(body.get("sourceId") or "")) or _uuid(
        str(body.get("requirementId") or "")
    )
    if project_id is None and source_id is not None:
        src = db.query(Source).filter(Source.id == source_id).first()
        if src:
            project_id = src.project_id
    title = body.get("title") or ""
    steps = body.get("steps") or ""
    expected = body.get("expectedResult") or ""
    if project_id is None or not title or not steps or not expected:
        return errors(400, "projectId, title, steps, expectedResult required")

    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    tc = TestCase(
        project_id=project_id,
        source_id=source_id,
        job_id=_uuid(str(body.get("jobId") or "")),
        test_case_code=f"TC-{count + 1:03d}",
        title=title,
        module=body.get("module"),
        type=type_vi(body.get("type")),
        priority=priority_vi(body.get("priority")),
        severity=severity_vi(body.get("severity")),
        precondition=body.get("precondition"),
        steps=steps,
        expected_result=expected,
        test_data=body.get("testData"),
        automation_ready=bool(body.get("automationReady", False)),
        is_ai_generated=False,
        review_status=C.REVIEW_DRAFT,
        execution_status="Pending",
    )
    db.add(tc)
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.post("/testcases/bulk")
async def bulk_save_testcases(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    test_cases = body.get("testCases") or []
    if project_id is None or not test_cases:
        return errors(400, "projectId and testCases required")

    job_id = _uuid(str(body.get("jobId") or ""))
    source_id = _uuid(str(body.get("sourceId") or ""))
    if job_id is not None and source_id is None:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job:
            source_id = job.source_id

    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    created: list[TestCase] = []
    for i, item in enumerate(test_cases):
        title = (item.get("title") or "").strip()
        steps = (item.get("steps") or "").strip()
        expected = (item.get("expectedResult") or "").strip()
        if not title or not steps or not expected:
            db.rollback()
            return errors(400, f"testCases[{i}]: title, steps, expectedResult required")
        count += 1
        tc = TestCase(
            project_id=project_id,
            source_id=source_id,
            job_id=job_id,
            test_case_code=f"TC-{count:03d}",
            title=title,
            module=item.get("module"),
            type=type_vi(item.get("type")),
            priority=priority_vi(item.get("priority")),
            severity=severity_vi(item.get("severity")),
            precondition=item.get("precondition"),
            steps=steps,
            expected_result=expected,
            test_data=item.get("testData"),
            automation_ready=bool(item.get("automationReady", False)),
            is_ai_generated=True,
            review_status=C.REVIEW_DRAFT,
            execution_status="Pending",
        )
        db.add(tc)
        created.append(tc)

    if job_id is not None:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job:
            job.status = C.JOB_COMPLETED
            job.completed_at = datetime.now(timezone.utc)
            job.error = None
    db.commit()
    for tc in created:
        db.refresh(tc)
    return ok({"count": len(created), "testCases": [testcase_dto(t) for t in created]})


@router.get("/testcases/{tc_id}")
def get_testcase(tc_id: str, db: Annotated[Session, Depends(get_db)]):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    return ok(testcase_dto(tc))


@router.put("/testcases/{tc_id}")
async def update_testcase(tc_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    body = await request.json()
    if body.get("title"):
        tc.title = body["title"]
    tc.module = body.get("module")
    if body.get("priority"):
        tc.priority = priority_vi(body["priority"])
    if body.get("severity"):
        tc.severity = severity_vi(body["severity"])
    if body.get("type"):
        tc.type = type_vi(body["type"])
    tc.precondition = body.get("precondition")
    if body.get("steps"):
        tc.steps = body["steps"]
    if body.get("expectedResult"):
        tc.expected_result = body["expectedResult"]
    tc.actual_result = body.get("actualResult")
    tc.test_data = body.get("testData")
    tc.automation_ready = bool(body.get("automationReady", False))
    if body.get("executionStatus"):
        tc.execution_status = body["executionStatus"]
    if tc.review_status in (C.REVIEW_APPROVED, C.REVIEW_REJECTED):
        tc.review_status = C.REVIEW_DRAFT
        tc.reviewed_by = None
        tc.reviewed_at = None
        tc.review_comment = None
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.delete("/testcases/{tc_id}")
def delete_testcase(tc_id: str, db: Annotated[Session, Depends(get_db)]):
    """Hard-delete test case row from database (not soft-delete)."""
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")

    db.query(GenerationTask).filter(GenerationTask.test_case_id == tid).delete(
        synchronize_session=False
    )
    db.query(WorkspaceRun).filter(WorkspaceRun.test_case_id == tid).update(
        {WorkspaceRun.test_case_id: None},
        synchronize_session=False,
    )
    db.delete(tc)
    db.commit()
    return ok({"status": "ok", "deleted": True})


def _transition(
    db: Session, tc_id: str, to: str, user: User, comment: str | None
):
    tid = _uuid(tc_id)
    if tid is None:
        return errors(400, "invalid id")
    tc = db.query(TestCase).filter(TestCase.id == tid).first()
    if tc is None:
        return errors(404, "not found")
    if not C.can_transition_review(tc.review_status, to):
        return errors(400, f"cannot transition from {tc.review_status} to {to}")
    tc.review_status = to
    now = datetime.now(timezone.utc)
    if to in (C.REVIEW_APPROVED, C.REVIEW_REJECTED):
        tc.reviewed_by = user.id
        tc.reviewed_at = now
        tc.review_comment = comment
    else:
        tc.reviewed_by = None
        tc.reviewed_at = None
        tc.review_comment = None
    db.commit()
    db.refresh(tc)
    return ok(testcase_dto(tc))


@router.post("/testcases/{tc_id}/submit")
def submit_testcase(
    tc_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _transition(db, tc_id, C.REVIEW_IN_REVIEW, user, None)


@router.post("/testcases/{tc_id}/approve")
def approve_testcase(
    tc_id: str,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    return _transition(db, tc_id, C.REVIEW_APPROVED, user, None)


@router.post("/testcases/{tc_id}/reject")
async def reject_testcase(
    tc_id: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    user: Annotated[User, Depends(get_current_user)],
):
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001 — empty body allowed
        body = {}
    return _transition(db, tc_id, C.REVIEW_REJECTED, user, (body or {}).get("comment"))
