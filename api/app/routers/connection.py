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
from app.llm import LLMError
from app.models.domain import AiBackendConnection, Project
from app.responses import errors, ok
from app.serializers import connection_dto
from app.services import secret
from app.services.ai_service import (
    RUNNER_AI_CLI,
    cli_session_status,
    connection_runner_mode,
    get_adapter_for_connection,
)
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

    # Apply runner mode BEFORE apiKey handling (empty key + AI_CLI must not force NotConfigured)
    if "runnerMode" in body or "runner_mode" in body:
        raw_mode = body.get("runnerMode") if "runnerMode" in body else body.get("runner_mode")
        mode = str(raw_mode or "API_DIRECT").strip().upper()
        conn.runner_mode = "AI_CLI" if mode in ("AI_CLI", "CLI") else "API_DIRECT"

    if "cliType" in body or "cli_type" in body:
        raw_t = body.get("cliType") if "cliType" in body else body.get("cli_type")
        conn.cli_type = (str(raw_t).strip() if raw_t else None) or "gemini-cli"

    if "cliPath" in body or "cli_path" in body:
        raw_p = body.get("cliPath") if "cliPath" in body else body.get("cli_path")
        conn.cli_path = (str(raw_p).strip() if raw_p else None) or None

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

    if "baseUrl" in body or "base_url" in body:
        raw_base = body.get("baseUrl") if "baseUrl" in body else body.get("base_url")
        base = (raw_base or "").strip().rstrip("/")
        conn.base_url = base or None

    if "apiKey" in body:
        key = (body.get("apiKey") or "").strip()
        if not key:
            conn.api_key_ciphertext = None
            if connection_runner_mode(conn) != RUNNER_AI_CLI:
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

    # AI CLI mode — verify executable on PATH / cli_path
    if connection_runner_mode(conn) == RUNNER_AI_CLI:
        try:
            adapter = get_adapter_for_connection(conn, api_key="")
            ok_cli = await adapter.health_check()
        except Exception as exc:  # noqa: BLE001
            conn.status = C.STATUS_ERROR
            conn.last_error = str(exc)
            conn.last_verified_at = datetime.now(timezone.utc)
            db.commit()
            return errors(400, f"CLI verify failed: {exc}")
        if not ok_cli:
            conn.status = C.STATUS_ERROR
            path = getattr(conn, "cli_path", None) or "gemini"
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
        and connection_runner_mode(conn) != RUNNER_AI_CLI
    ):
        return errors(400, "không thể Ready khi chưa có API Key — dùng Verify")
    conn.status = st
    db.commit()
    db.refresh(conn)
    return ok(connection_dto(conn))
