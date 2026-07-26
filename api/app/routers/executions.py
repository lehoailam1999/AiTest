from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import Execution, Project
from app.responses import errors, ok, page, page_params
from app.serializers import execution_dto

router = APIRouter(prefix="/api", tags=["executions"], dependencies=[Depends(get_current_user)])

MAX_LOG_EXCERPT = 32000


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _truncate(s: str, limit: int) -> str:
    if limit <= 0 or len(s) <= limit:
        return s
    return s[:limit] + "\n…[truncated]"


def _parse_time(value: str | None, fallback: datetime) -> datetime:
    if not value:
        return fallback
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00")).astimezone(timezone.utc)
    except ValueError:
        return fallback


@router.post("/executions")
async def create_execution(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    if project_id is None:
        return errors(400, "projectId required")
    project = db.query(Project).filter(Project.id == project_id, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    exit_code = int(body.get("exitCode") or 0)
    failed = int(body.get("failed") or 0)
    status = (body.get("status") or "").strip()
    if not status:
        if exit_code == 0 and failed == 0:
            status = C.EXEC_PASSED
        elif exit_code != 0 or failed > 0:
            status = C.EXEC_FAILED
        else:
            status = C.EXEC_ERROR
    if status not in (C.EXEC_PASSED, C.EXEC_FAILED, C.EXEC_ERROR):
        return errors(400, "status must be Passed|Failed|Error")

    cmd = (body.get("command") or "").strip() or "test"
    now = datetime.now(timezone.utc)
    started = _parse_time(body.get("startedAt"), now)
    finished = _parse_time(body.get("finishedAt"), started)

    passed = int(body.get("passed") or 0)
    skipped = int(body.get("skipped") or 0)
    total = int(body.get("total") or 0)
    if total == 0 and (passed + failed + skipped) > 0:
        total = passed + failed + skipped

    ex = Execution(
        project_id=project_id,
        command=cmd,
        exit_code=exit_code,
        status=status,
        passed=passed,
        failed=failed,
        skipped=skipped,
        total=total,
        duration_ms=int(body.get("durationMs") or 0),
        log_excerpt=_truncate(body.get("logExcerpt") or "", MAX_LOG_EXCERPT),
        trx_file_name=body.get("trxFileName"),
        filter=body.get("filter"),
        started_at=started,
        finished_at=finished,
    )
    db.add(ex)
    db.commit()
    db.refresh(ex)
    return ok(execution_dto(ex))


@router.get("/executions")
def list_executions(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(Execution)
    if v := request.query_params.get("projectId"):
        if pid := _uuid(v):
            q = q.filter(Execution.project_id == pid)
    total = q.count()
    items = (
        q.order_by(Execution.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(page([execution_dto(e) for e in items], total, page_number, size))


@router.get("/executions/{exec_id}")
def get_execution(exec_id: str, db: Annotated[Session, Depends(get_db)]):
    eid = _uuid(exec_id)
    if eid is None:
        return errors(400, "invalid id")
    ex = db.query(Execution).filter(Execution.id == eid).first()
    if ex is None:
        return errors(404, "not found")
    return ok(execution_dto(ex))
