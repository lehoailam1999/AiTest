"""Journey status query — single cockpit payload for Home CTA (W4)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Query
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.features.journey.application import compute_journey_payload
from app.responses import errors, ok

router = APIRouter(
    prefix="/api/projects",
    tags=["journey"],
    dependencies=[Depends(get_current_user)],
)


@router.get("/{project_id}/journey-status")
def journey_status(
    project_id: str,
    db: Annotated[Session, Depends(get_db)],
    ide_root: Annotated[str | None, Query()] = None,
    local_path: Annotated[str | None, Query()] = None,
):
    try:
        pid = uuid.UUID(project_id)
    except ValueError:
        return errors(400, "invalid project id")
    payload = compute_journey_payload(
        db,
        pid,
        ide_root=ide_root,
        local_path=local_path,
    )
    if payload is None:
        return errors(404, "Project not found")
    return ok(payload)
