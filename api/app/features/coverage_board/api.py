"""Coverage Board API — GET /api/projects/{id}/coverage-board (F6)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.features.coverage_board.application import compute_coverage_board
from app.responses import errors, ok

router = APIRouter(
    prefix="/api/projects",
    tags=["coverage-board"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/{project_id}/coverage-board")
def coverage_board(
    project_id: str,
    db: Annotated[Session, Depends(get_db)],
    page: int = Query(1, ge=1),
    pageSize: int = Query(50, ge=1, le=100),
    module: str | None = Query(None, description="Filter module name (substring)"),
    hasLocalPath: bool = Query(
        False,
        description="Desktop soft-gate: local Workspace Host folder bound",
    ),
):
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return errors(400, "invalid project id")

    payload = compute_coverage_board(
        db,
        pid,
        has_local_path=hasLocalPath,
        page=page,
        page_size=pageSize,
        module_q=module,
    )
    if payload is None:
        return errors(404, "Project not found")
    return ok(payload)
