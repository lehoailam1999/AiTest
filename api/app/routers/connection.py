from __future__ import annotations

import uuid
from datetime import datetime, timezone
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import get_db
from app.deps import get_current_user
from app.llm import LLMError
from app.models.domain import AiBackendConnection, Project
from app.responses import errors, ok
from app.serializers import connection_dto
from app.services import secret
from app.services.connection_service import (
    connection_api_key,
    enc_key,
    get_or_create_conn,
    llm_from_connection,
)

router = APIRouter(
    prefix="/api", tags=["connection"], dependencies=[Depends(get_current_user)]
)


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
    raw = body.get("provider") or body.get("backendType")
    provider = C.normalize_provider(raw)
    if provider is None:
        return errors(400, "provider must be openai|anthropic|gemini|ollama|antigravity")

    conn = get_or_create_conn(db, pid)
    conn.backend_type = provider

    if "modelName" in body:
        model = (body.get("modelName") or "").strip()
        conn.model_name = model or None

    if "baseUrl" in body or "base_url" in body:
        raw_base = body.get("baseUrl") if "baseUrl" in body else body.get("base_url")
        base = (raw_base or "").strip().rstrip("/")
        conn.base_url = base or None

    if "apiKey" in body:
        key = (body.get("apiKey") or "").strip()
        if not key:
            conn.api_key_ciphertext = None
            conn.status = C.STATUS_NOT_CONFIGURED
            conn.last_error = None
        else:
            conn.api_key_ciphertext = secret.encrypt(key, enc_key())
            if not C.is_ai_ready(conn.status):
                conn.status = C.STATUS_NOT_CONFIGURED

    if provider == C.PROVIDER_OLLAMA and not C.is_ai_ready(conn.status):
        conn.status = C.STATUS_NOT_CONFIGURED

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
        api_key = connection_api_key(conn)
    except ValueError as exc:
        conn.status = C.STATUS_NOT_CONFIGURED
        conn.last_error = str(exc)
        db.commit()
        return errors(400, str(exc))

    try:
        provider = llm_from_connection(conn)
    except LLMError as exc:
        return errors(400, str(exc))

    try:
        await provider.verify(api_key)
    except Exception as exc:  # noqa: BLE001 — surface provider error to client
        conn.status = C.STATUS_ERROR
        conn.last_error = str(exc)
        conn.last_verified_at = datetime.now(timezone.utc)
        db.commit()
        return errors(400, f"verify failed: {exc}")

    conn.status = C.STATUS_READY
    conn.last_verified_at = datetime.now(timezone.utc)
    conn.last_error = None
    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))


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
    backend = (conn.backend_type or "").lower()
    local_ag = backend == C.PROVIDER_ANTIGRAVITY and bool(
        (getattr(conn, "base_url", None) or "").strip()
        and (
            "127.0.0.1" in (conn.base_url or "").lower()
            or "localhost" in (conn.base_url or "").lower()
        )
    )
    if (
        st == C.STATUS_READY
        and not conn.api_key_ciphertext
        and backend != C.PROVIDER_OLLAMA
        and not local_ag
    ):
        return errors(400, "không thể Ready khi chưa có API Key — dùng Verify")
    conn.status = st
    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))
