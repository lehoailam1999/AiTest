from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import (
    AiBackendConnection,
    Execution,
    Job,
    Project,
    Source,
    TestCase,
)
from app.responses import errors, ok, page, page_params
from app.serializers import project_dto

router = APIRouter(prefix="/api", tags=["projects"], dependencies=[Depends(get_current_user)])


def _counts(db: Session, project_id: uuid.UUID) -> tuple[int, int]:
    src = (
        db.query(Source)
        .filter(Source.project_id == project_id, Source.deleted_at.is_(None))
        .count()
    )
    tc = (
        db.query(TestCase)
        .filter(TestCase.project_id == project_id, TestCase.deleted_at.is_(None))
        .count()
    )
    return src, tc


def _dto(db: Session, p: Project) -> dict:
    src, tc = _counts(db, p.id)
    return project_dto(p, src, tc)


def parse_uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, AttributeError):
        return None


@router.get("/projects")
def list_projects(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(Project).filter(Project.deleted_at.is_(None))
    total = q.count()
    items = (
        q.order_by(Project.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(page([_dto(db, p) for p in items], total, page_number, size))


@router.post("/projects")
async def create_project(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    name = (body.get("name") or "").strip()
    if not name:
        return errors(400, "name required")
    p = Project(
        name=name,
        description=body.get("description"),
        code=body.get("code"),
        is_active=True,
    )
    db.add(p)
    db.commit()
    db.refresh(p)
    db.add(
        AiBackendConnection(
            project_id=p.id,
            backend_type=C.PROVIDER_OLLAMA,
            status=C.STATUS_DISCONNECTED,
        )
    )
    db.commit()
    return ok(_dto(db, p))


@router.get("/projects/{project_id}")
def get_project(project_id: str, db: Annotated[Session, Depends(get_db)]):
    pid = parse_uuid(project_id)
    if pid is None:
        return errors(400, "invalid id")
    p = db.query(Project).filter(Project.id == pid, Project.deleted_at.is_(None)).first()
    if p is None:
        return errors(404, "not found")
    return ok(_dto(db, p))


@router.put("/projects/{project_id}")
async def update_project(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = parse_uuid(project_id)
    if pid is None:
        return errors(400, "invalid id")
    p = db.query(Project).filter(Project.id == pid, Project.deleted_at.is_(None)).first()
    if p is None:
        return errors(404, "not found")
    body = await request.json()
    if body.get("name"):
        p.name = body["name"]
    if "description" in body:
        p.description = body.get("description")
    if "code" in body:
        p.code = body.get("code")
    if "language" in body:
        p.language = body.get("language")
    if "framework" in body:
        p.framework = body.get("framework")
    if "meta" in body:
        from app.llm.ai_rules import dumps_project_meta, merge_project_meta, seed_ai_rules_on_meta

        merged = merge_project_meta(p.meta, body.get("meta"))
        # Keep projectAuto fresh from scan fields unless locked
        merged = seed_ai_rules_on_meta(merged, language=p.language)
        p.meta = dumps_project_meta(merged)
    db.commit()
    db.refresh(p)
    p = db.query(Project).filter(Project.id == pid, Project.deleted_at.is_(None)).first()
    if p is None:
        return errors(404, "not found")
    return ok(_dto(db, p))


@router.delete("/projects/{project_id}")
def delete_project(project_id: str, db: Annotated[Session, Depends(get_db)]):
    pid = parse_uuid(project_id)
    if pid is None:
        return errors(400, "invalid id")
    p = db.query(Project).filter(Project.id == pid).first()
    if p:
        p.deleted_at = __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        db.commit()
    return ok({"status": "ok"})


# --- Dashboard / stubs ---


@router.get("/dashboard")
def dashboard(request: Request, db: Annotated[Session, Depends(get_db)]):
    project_id = parse_uuid(request.query_params.get("projectId") or "")

    projects = db.query(Project).filter(Project.deleted_at.is_(None)).count()

    src_q = db.query(Source).filter(Source.deleted_at.is_(None))
    tc_q = db.query(TestCase).filter(TestCase.deleted_at.is_(None))
    job_q = db.query(Job).filter(Job.deleted_at.is_(None))
    exec_q = db.query(Execution).filter(Execution.deleted_at.is_(None))

    if project_id is not None:
        src_q = src_q.filter(Source.project_id == project_id)
        tc_q = tc_q.filter(TestCase.project_id == project_id)
        job_q = job_q.filter(Job.project_id == project_id)
        exec_q = exec_q.filter(Execution.project_id == project_id)

    sources = src_q.count()
    tcs = tc_q.count()
    jobs = job_q.count()
    pass_n = exec_q.filter(Execution.status == C.EXEC_PASSED).count()
    fail_n = exec_q.filter(Execution.status == C.EXEC_FAILED).count()
    err_n = exec_q.filter(Execution.status == C.EXEC_ERROR).count()
    return ok(
        {
            "totalProjects": projects,
            "totalRequirements": sources,
            "totalTestCases": tcs,
            "totalAiCost": 0,
            "totalAiTokens": 0,
            "coveragePercent": 0,
            "executionPass": pass_n,
            "executionFail": fail_n,
            "executionPending": err_n,
            "jobCount": jobs,
            "scopedToProject": project_id is not None,
            "phase": 7,
            "note": "M7: execution metadata from Desktop upload",
        }
    )


@router.get("/prompts")
def prompts():
    return ok([])


@router.get("/history")
def history(request: Request):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    return ok(page([], 0, page_number, size))


@router.get("/reports/{project_id}")
def report_stub(project_id: str, db: Annotated[Session, Depends(get_db)]):
    total = db.query(TestCase).count()
    return ok(
        {
            "totalTestCases": total,
            "phase": 1,
            "byType": {},
            "byStatus": {},
        }
    )
