"""REST API — Workspace Manager."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.features.workspace.application import WorkspaceApplicationService
from app.features.workspace.di import get_workspace_service
from app.features.workspace.domain.errors import (
    InvalidRootPath,
    PathOutsideRoot,
    WorkspaceError,
    WorkspaceNotFound,
    WorkspaceNotReady,
)
from app.models.domain import Project
from app.responses import errors, ok

router = APIRouter(
    prefix="/api/workspace",
    tags=["workspace"],
    dependencies=[Depends(get_current_user)],
)


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _map_error(exc: Exception):
    if isinstance(exc, WorkspaceNotFound):
        return errors(404, exc.message)
    if isinstance(exc, WorkspaceNotReady):
        return errors(409, exc.message)
    if isinstance(exc, (InvalidRootPath, PathOutsideRoot)):
        return errors(400, exc.message)
    if isinstance(exc, WorkspaceError):
        return errors(400, exc.message)
    return errors(500, str(exc))


@router.post("/open")
async def open_workspace(
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    body = await request.json()
    project_id = _uuid(str(body.get("projectId") or ""))
    root_path = str(body.get("rootPath") or "").strip()
    if project_id is None or not root_path:
        return errors(400, "projectId and rootPath required")
    project = (
        db.query(Project)
        .filter(Project.id == project_id, Project.deleted_at.is_(None))
        .first()
    )
    if project is None:
        return errors(404, "Project not found")
    try:
        session = svc.open(str(project_id), root_path)
        return ok(session.to_dict())
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.get("/{workspace_id}")
def get_workspace(
    workspace_id: str,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    session = svc.get(workspace_id)
    if session is None:
        return errors(404, "workspace not found")
    return ok(session.to_dict())


@router.get("/{workspace_id}/status")
def workspace_status(
    workspace_id: str,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    st = svc.status(workspace_id)
    if st is None:
        return errors(404, "workspace not found")
    return ok(st)


@router.post("/{workspace_id}/refresh")
async def refresh_workspace(
    workspace_id: str,
    request: Request,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    body = {}
    try:
        body = await request.json()
    except Exception:  # noqa: BLE001
        body = {}
    full = bool(body.get("full")) if isinstance(body, dict) else False
    try:
        session = svc.refresh(workspace_id, full=full)
        return ok(session.to_dict())
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.post("/{workspace_id}/close")
def close_workspace(
    workspace_id: str,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    try:
        svc.close(workspace_id)
        return ok({"status": "closed", "workspaceId": workspace_id})
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.get("/{workspace_id}/files")
def list_files(
    workspace_id: str,
    request: Request,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    qp = request.query_params
    ext = qp.get("ext")
    q = qp.get("q")
    try:
        limit = int(qp.get("limit") or 100)
        cursor = int(qp.get("cursor") or 0)
    except ValueError:
        return errors(400, "invalid limit/cursor")
    try:
        return ok(
            svc.list_files(
                workspace_id, ext=ext, q=q, limit=min(limit, 500), cursor=max(0, cursor)
            )
        )
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.post("/{workspace_id}/search")
async def search_files(
    workspace_id: str,
    request: Request,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    body = await request.json()
    try:
        return ok(svc.search(workspace_id, body if isinstance(body, dict) else {}))
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.post("/{workspace_id}/read")
async def read_files(
    workspace_id: str,
    request: Request,
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    body = await request.json()
    try:
        return ok(svc.read(workspace_id, body if isinstance(body, dict) else {}))
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)


@router.post("/{workspace_id}/resolve-scope")
async def resolve_scope(
    workspace_id: str,
    request: Request,
    db: Annotated[Session, Depends(get_db)],
    svc: Annotated[WorkspaceApplicationService, Depends(get_workspace_service)],
):
    """
    Body: { testCaseId?, tokens?: string[], useAiTokens?: bool }
    Uses workspace index to find candidates; optionally AI tokens via existing service.
    """
    from app import constants as C
    from app.llm import LLMError
    from app.models.domain import AiBackendConnection, TestCase
    from app.services.connection_service import connection_api_key, llm_from_connection
    from app.services.resolve_source_scope import (
        build_resolve_scope_prompts,
        build_resolve_tokens_prompts,
        parse_resolve_scope_json,
        parse_resolve_tokens_json,
    )

    body = await request.json()
    session = svc.get(workspace_id)
    if session is None:
        return errors(404, "workspace not found")

    tokens: list[str] = []
    raw_tokens = body.get("tokens")
    if isinstance(raw_tokens, list):
        tokens = [str(t).strip() for t in raw_tokens if str(t).strip()]

    tc = None
    test_case_id = _uuid(str(body.get("testCaseId") or ""))
    if test_case_id:
        tc = (
            db.query(TestCase)
            .filter(
                TestCase.id == test_case_id,
                TestCase.project_id == uuid.UUID(session.project_id),
            )
            .first()
        )

    use_ai = body.get("useAiTokens", True)
    if use_ai and tc is not None and not tokens:
        conn = (
            db.query(AiBackendConnection)
            .filter(AiBackendConnection.project_id == uuid.UUID(session.project_id))
            .first()
        )
        if conn and C.is_ai_ready(conn.status):
            try:
                api_key = connection_api_key(conn)
                provider = llm_from_connection(conn)
                system, user = build_resolve_tokens_prompts(
                    title=tc.title or "",
                    module=tc.module,
                    steps=tc.steps or "",
                    expected=tc.expected_result or "",
                    precondition=tc.precondition,
                    test_data=tc.test_data,
                )
                raw = await provider.chat(api_key, system, user)
                tokens = parse_resolve_tokens_json(raw).get("tokens") or []
            except (ValueError, LLMError, Exception):  # noqa: BLE001
                tokens = []

    if not tokens and tc is not None:
        # fallback: module + title words
        blob = f"{tc.module or ''} {tc.title or ''}"
        tokens = [w for w in blob.replace("-", " ").split() if len(w) >= 3][:12]

    try:
        ctx = svc.build_context(workspace_id, tokens)
        primary = ctx.primary_path
        related = [r["path"] for r in ctx.related]
        reason = ctx.reason

        # Optional AI rank among candidates
        if use_ai and tc is not None and ctx.candidates:
            conn = (
                db.query(AiBackendConnection)
                .filter(AiBackendConnection.project_id == uuid.UUID(session.project_id))
                .first()
            )
            if conn and C.is_ai_ready(conn.status):
                try:
                    api_key = connection_api_key(conn)
                    provider = llm_from_connection(conn)
                    system, user = build_resolve_scope_prompts(
                        title=tc.title or "",
                        module=tc.module,
                        steps=tc.steps or "",
                        expected=tc.expected_result or "",
                        precondition=tc.precondition,
                        test_data=tc.test_data,
                        candidates=ctx.candidates[:60],
                    )
                    raw = await provider.chat(api_key, system, user)
                    ranked = parse_resolve_scope_json(raw, ctx.candidates)
                    primary = ranked.get("primary") or primary
                    related = ranked.get("related") or related
                    reason = ranked.get("reason") or reason
                except Exception:  # noqa: BLE001
                    pass

        return ok(
            {
                "primary": primary,
                "related": related,
                "reason": reason,
                "candidates": ctx.candidates,
                "tokens": tokens,
                "workspaceId": workspace_id,
            }
        )
    except Exception as exc:  # noqa: BLE001
        return _map_error(exc)
