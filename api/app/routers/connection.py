from __future__ import annotations

import json
import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.models.domain import Project
from app.responses import errors, ok
from app.serializers import connection_dto
from app.services.ai_service import (
    cli_session_status,
    get_adapter_for_connection,
)
from app.services.connection_service import get_or_create_conn

router = APIRouter(
    prefix="/api", tags=["connection"], dependencies=[Depends(get_current_user)]
)

_CLI_DEFAULT_PATH = {
    "claude-cli": "claude",
    "claude": "claude",
    "claude-code": "claude",
    "cursor-cli": "agent",
    "cursor": "agent",
    "cursor-agent": "agent",
    "agent": "agent",
    "antigravity-cli": "agy",
    "antigravity": "agy",
    "agy": "agy",
    "ollama": "ollama",
    "ollama-cli": "ollama",
    "gemini-cli": "gemini",
}


def _pid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


def _project_exists(db: Session, pid: uuid.UUID) -> bool:
    return (
        db.query(Project).filter(Project.id == pid, Project.deleted_at.is_(None)).count()
        > 0
    )


@router.get("/projects/{project_id}/connection")
def get_connection(project_id: str, db: Annotated[Session, Depends(get_db)]):
    pid = _pid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if not _project_exists(db, pid):
        return errors(404, "Project not found")
    conn = get_or_create_conn(db, pid)
    return ok(connection_dto(conn))


@router.put("/projects/{project_id}/connection")
async def put_connection(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = _pid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if not _project_exists(db, pid):
        return errors(404, "Project not found")
    body = await request.json()

    conn = get_or_create_conn(db, pid)
    prev_cli_type = (getattr(conn, "cli_type", None) or "").strip().lower()
    prev_cli_path = (getattr(conn, "cli_path", None) or "").strip()

    if "cliType" in body or "cli_type" in body:
        raw_t = body.get("cliType") if "cliType" in body else body.get("cli_type")
        conn.cli_type = (str(raw_t).strip() if raw_t else None) or "cursor-cli"
    elif not (conn.cli_type or "").strip():
        conn.cli_type = "cursor-cli"

    if "cliPath" in body or "cli_path" in body:
        raw_p = body.get("cliPath") if "cliPath" in body else body.get("cli_path")
        path = (str(raw_p).strip() if raw_p else None) or None
        if not path:
            ctype = (conn.cli_type or "cursor-cli").strip().lower()
            path = _CLI_DEFAULT_PATH.get(ctype, "agent")
        conn.cli_path = path
    elif not (conn.cli_path or "").strip():
        ctype = (conn.cli_type or "cursor-cli").strip().lower()
        conn.cli_path = _CLI_DEFAULT_PATH.get(ctype, "agent")

    if "cliArgsJson" in body or "cli_args" in body or "cliArgs" in body:
        raw_a = (
            body.get("cliArgsJson")
            if "cliArgsJson" in body
            else body.get("cli_args")
            if "cli_args" in body
            else body.get("cliArgs")
        )
        if raw_a is None or raw_a == "":
            conn.cli_args_json = None
        elif isinstance(raw_a, list):
            conn.cli_args_json = json.dumps(raw_a, ensure_ascii=False)
        else:
            conn.cli_args_json = str(raw_a)

    if "modelName" in body:
        model = (body.get("modelName") or "").strip()
        conn.model_name = model or None

    new_cli_type = (getattr(conn, "cli_type", None) or "").strip().lower()
    new_cli_path = (getattr(conn, "cli_path", None) or "").strip()
    if (new_cli_type != prev_cli_type or new_cli_path != prev_cli_path) and C.is_ai_ready(
        conn.status
    ):
        conn.status = C.STATUS_NOT_CONFIGURED
        conn.last_error = None

    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))


@router.post("/projects/{project_id}/connection/verify")
async def verify_connection(project_id: str, db: Annotated[Session, Depends(get_db)]):
    pid = _pid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if not _project_exists(db, pid):
        return errors(404, "Project not found")
    conn = get_or_create_conn(db, pid)

    try:
        adapter = get_adapter_for_connection(conn)
        ok_cli = await adapter.health_check()
    except Exception as exc:  # noqa: BLE001
        conn.status = C.STATUS_ERROR
        conn.last_error = str(exc)
        conn.last_verified_at = datetime.now(timezone.utc)
        db.commit()
        return errors(400, f"CLI verify failed: {exc}")
    if not ok_cli:
        conn.status = C.STATUS_ERROR
        path = getattr(conn, "cli_path", None) or getattr(conn, "cli_type", None) or "CLI"
        conn.last_error = f"Không tìm thấy CLI executable: {path}"
        conn.last_verified_at = datetime.now(timezone.utc)
        db.commit()
        return errors(400, conn.last_error)
    conn.status = C.STATUS_READY
    conn.last_verified_at = datetime.now(timezone.utc)
    conn.last_error = None
    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))


@router.get("/projects/{project_id}/connection/cli-sessions")
def get_cli_sessions(project_id: str, db: Annotated[Session, Depends(get_db)]):
    pid = _pid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if not _project_exists(db, pid):
        return errors(404, "Project not found")
    return ok({"items": cli_session_status(str(pid))})


@router.put("/projects/{project_id}/connection/status")
async def put_connection_status(
    project_id: str, request: Request, db: Annotated[Session, Depends(get_db)]
):
    pid = _pid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    body = await request.json()
    st = body.get("status")
    if st == C.STATUS_CONNECTED:
        st = C.STATUS_READY
    elif st == C.STATUS_DISCONNECTED:
        st = C.STATUS_NOT_CONFIGURED
    elif st not in (C.STATUS_READY, C.STATUS_NOT_CONFIGURED, C.STATUS_ERROR):
        return errors(400, "status must be Ready|NotConfigured|Error")

    conn = get_or_create_conn(db, pid)
    conn.status = st
    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))
