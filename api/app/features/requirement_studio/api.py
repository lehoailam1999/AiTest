"""Requirement Studio API — upload + Phân tích (Knowledge)."""

from __future__ import annotations

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, File, UploadFile
from pydantic import BaseModel, Field
from sqlalchemy.orm import Session

from app.database import get_db
from app.deps import get_current_user
from app.features.requirement_studio import application as app_svc
from app.features.requirement_studio.dto import workspace_dto
from app.responses import errors, ok

router = APIRouter(
    prefix="/api",
    tags=["requirement-studio"],
    dependencies=[Depends(get_current_user)],
)


class CreateWorkspaceBody(BaseModel):
    title: str | None = Field(default=None, max_length=300)


class UpdateWorkspaceBody(BaseModel):
    title: str = Field(..., min_length=1, max_length=300)


class BuildKnowledgeBody(BaseModel):
    useLlm: bool = True


def _uuid(value: str):
    try:
        return uuid.UUID(value)
    except ValueError:
        return None


@router.get("/projects/{project_id}/requirement-workspaces")
def list_workspaces(
    project_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if app_svc.get_project(db, pid) is None:
        return errors(404, "Project not found")
    return ok({"items": app_svc.list_workspaces(db, pid)})


@router.post("/projects/{project_id}/requirement-workspaces")
def create_workspace(
    project_id: str,
    body: CreateWorkspaceBody,
    db: Annotated[Session, Depends(get_db)],
):
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if app_svc.get_project(db, pid) is None:
        return errors(404, "Project not found")
    return ok(app_svc.create_workspace(db, pid, title=body.title), status_code=201)


@router.post("/projects/{project_id}/requirement-workspaces/ensure")
def ensure_workspace(
    project_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    """Idempotent: return existing or create default workspace (UX: zero friction)."""
    pid = _uuid(project_id)
    if pid is None:
        return errors(400, "invalid project id")
    if app_svc.get_project(db, pid) is None:
        return errors(404, "Project not found")
    return ok(app_svc.ensure_default_workspace(db, pid))


@router.get("/requirement-workspaces/{workspace_id}")
def get_workspace(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    files = app_svc.list_files(db, wid)
    return ok(workspace_dto(ws, file_count=len(files)))


@router.put("/requirement-workspaces/{workspace_id}")
def update_workspace(
    workspace_id: str,
    body: UpdateWorkspaceBody,
    db: Annotated[Session, Depends(get_db)],
):
    """Sửa tên Requirement (title)."""
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    try:
        result = app_svc.update_workspace(db, wid, title=body.title)
    except ValueError as exc:
        return errors(400, str(exc))
    if result is None:
        return errors(404, "workspace not found")
    return ok(result)


@router.delete("/requirement-workspaces/{workspace_id}")
def delete_workspace(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    """Hard-delete Requirement + snapshots, TCs, files, chat, knowledge."""
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    result = app_svc.hard_delete_workspace(db, wid)
    if result is None:
        return errors(404, "workspace not found")
    return ok(result)


@router.get("/requirement-workspaces/{workspace_id}/files")
def list_files(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok({"items": app_svc.list_files(db, wid)})


@router.post("/requirement-workspaces/{workspace_id}/files")
async def upload_files(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
    files: Annotated[list[UploadFile], File()],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")

    if not files:
        return errors(400, "no files uploaded")
    if len(files) > app_svc.MAX_FILES_PER_REQUEST:
        return errors(
            400,
            f"Too many files (max {app_svc.MAX_FILES_PER_REQUEST} per request)",
        )

    refs: list[dict] = []
    for upload in files:
        raw = await upload.read()
        if len(raw) > app_svc.MAX_FILE_BYTES:
            return errors(
                400,
                f"{upload.filename or 'file'}: quá lớn (tối đa ~15 MB)",
            )
        refs.append(
            app_svc.ingest_upload(
                db,
                ws,
                file_name=upload.filename or "upload",
                raw=raw,
                mime_type=upload.content_type,
            )
        )

    return ok({"items": refs}, status_code=201)


@router.get("/requirement-files/{file_id}")
def get_file(
    file_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    fid = _uuid(file_id)
    if fid is None:
        return errors(400, "invalid file id")
    detail = app_svc.get_file_detail(db, fid)
    if detail is None:
        return errors(404, "file not found")
    return ok(detail)


@router.delete("/requirement-files/{file_id}")
def delete_file(
    file_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    fid = _uuid(file_id)
    if fid is None:
        return errors(400, "invalid file id")
    row = app_svc.soft_delete_file(db, fid)
    if row is None:
        return errors(404, "file not found")
    return ok({"status": "deleted", "id": str(fid)})


@router.get("/requirement-workspaces/{workspace_id}/knowledge")
def get_knowledge(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok(app_svc.get_knowledge(db, wid))


@router.post("/requirement-workspaces/{workspace_id}/knowledge/build")
async def build_knowledge(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
    body: BuildKnowledgeBody | None = None,
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    opts = body or BuildKnowledgeBody()
    try:
        result = await app_svc.build_knowledge(db, ws, use_llm=opts.useLlm)
    except ValueError as e:
        return errors(400, str(e))
    return ok(result)


@router.get("/requirement-workspaces/{workspace_id}/coverage")
def get_coverage(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok(app_svc.coverage_summary(db, wid))


@router.get("/requirement-workspaces/{workspace_id}/analysis")
def get_analysis_records(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok({"items": app_svc.list_analysis_records(db, wid)})


@router.post("/requirement-workspaces/{workspace_id}/coverage/analyze")
def analyze_coverage(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    try:
        result = app_svc.analyze_coverage(db, wid)
    except ValueError as e:
        return errors(400, str(e))
    return ok(result)


class ChatMessageBody(BaseModel):
    message: str = Field(..., min_length=1, max_length=8000)
    sessionId: str | None = None
    useLlm: bool = True


class CreateChatSessionBody(BaseModel):
    title: str | None = Field(default=None, max_length=300)


@router.get("/requirement-workspaces/{workspace_id}/chat/sessions")
def list_chat_sessions(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok({"items": app_svc.list_chat_sessions(db, wid)})


@router.post("/requirement-workspaces/{workspace_id}/chat/sessions")
def create_chat_session(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
    body: CreateChatSessionBody | None = None,
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    opts = body or CreateChatSessionBody()
    try:
        return ok(app_svc.create_chat_session(db, ws, title=opts.title), status_code=201)
    except ValueError as e:
        return errors(400, str(e))


@router.post("/requirement-workspaces/{workspace_id}/chat/sessions/ensure")
def ensure_chat_session(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    try:
        return ok(app_svc.ensure_chat_session(db, ws))
    except ValueError as e:
        return errors(400, str(e))


@router.get("/chat/sessions/{session_id}/messages")
def list_chat_messages(
    session_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    sid = _uuid(session_id)
    if sid is None:
        return errors(400, "invalid session id")
    if app_svc.get_chat_session(db, sid) is None:
        return errors(404, "session not found")
    return ok({"items": app_svc.list_chat_messages(db, sid)})


@router.post("/requirement-workspaces/{workspace_id}/chat")
async def post_chat(
    workspace_id: str,
    body: ChatMessageBody,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")

    session = None
    if body.sessionId:
        sid = _uuid(body.sessionId)
        if sid is None:
            return errors(400, "invalid session id")
        session = app_svc.get_chat_session(db, sid)
        if session is None or session.workspace_id != wid:
            return errors(404, "session not found")
    else:
        try:
            ensured = app_svc.ensure_chat_session(db, ws)
            session = app_svc.get_chat_session(db, uuid.UUID(str(ensured["id"])))
        except ValueError as e:
            return errors(400, str(e))

    if session is None:
        return errors(500, "cannot open chat session")

    try:
        result = await app_svc.post_chat_turn(
            db, ws, session, message=body.message, use_llm=body.useLlm
        )
    except ValueError as e:
        return errors(400, str(e))
    return ok(result)


class FreezeBody(BaseModel):
    acknowledgeMissing: bool = False
    note: str | None = Field(default=None, max_length=2000)


class GenerateFromSnapshotBody(BaseModel):
    mode: str = Field(default="append")
    preferredEngine: str | None = Field(default=None, max_length=20)
    targetUrl: str | None = Field(default=None, max_length=500)
    authHint: str | None = Field(default=None, max_length=1000)
    focusModules: str | None = Field(default=None, max_length=500)
    # fast | full — mặc định fast nếu bỏ trống để tối ưu tốc độ
    speed: str | None = Field(default="fast", max_length=20)
    maxPerModule: int | None = Field(default=None, ge=2, le=30)


class FreezeAndGenerateBody(BaseModel):
    acknowledgeMissing: bool = False
    note: str | None = Field(default=None, max_length=2000)
    mode: str = Field(default="append")
    preferredEngine: str | None = Field(default=None, max_length=20)
    targetUrl: str | None = Field(default=None, max_length=500)
    authHint: str | None = Field(default=None, max_length=1000)
    focusModules: str | None = Field(default=None, max_length=500)
    speed: str | None = Field(default="fast", max_length=20)
    maxPerModule: int | None = Field(default=None, ge=2, le=30)


@router.post("/requirement-workspaces/{workspace_id}/freeze")
def freeze_workspace(
    workspace_id: str,
    body: FreezeBody,
    db: Annotated[Session, Depends(get_db)],
    user=Depends(get_current_user),
):
    """R6 — Freeze Knowledge → Requirement Snapshot (BR-V2-19)."""
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    try:
        result = app_svc.freeze_knowledge(
            db,
            ws,
            frozen_by=getattr(user, "id", None),
            acknowledge_missing=body.acknowledgeMissing,
            note=body.note,
        )
    except ValueError as e:
        return errors(400, str(e))
    return ok(result, status_code=201)


@router.get("/requirement-workspaces/{workspace_id}/snapshots")
def list_workspace_snapshots(
    workspace_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    if app_svc.get_workspace(db, wid) is None:
        return errors(404, "workspace not found")
    return ok({"items": app_svc.list_snapshots(db, wid)})


@router.get("/requirement-snapshots/{snapshot_id}")
def get_requirement_snapshot(
    snapshot_id: str,
    db: Annotated[Session, Depends(get_db)],
):
    from app.features.requirement_studio.dto import snapshot_dto

    sid = _uuid(snapshot_id)
    if sid is None:
        return errors(400, "invalid snapshot id")
    snap = app_svc.get_snapshot(db, sid)
    if snap is None:
        return errors(404, "snapshot not found")
    return ok(snapshot_dto(snap))


@router.post("/requirement-snapshots/{snapshot_id}/generate-tc")
async def generate_tc_from_snapshot(
    snapshot_id: str,
    body: GenerateFromSnapshotBody,
    db: Annotated[Session, Depends(get_db)],
):
    """R7 — Generate TC from Snapshot only (BR-V2-16)."""
    import asyncio

    from app.routers.jobs import process_generate_job
    from app.serializers import job_dto

    sid = _uuid(snapshot_id)
    if sid is None:
        return errors(400, "invalid snapshot id")
    snap = app_svc.get_snapshot(db, sid)
    if snap is None:
        return errors(404, "snapshot not found")
    mode = (body.mode or "append").strip().lower()
    if mode not in ("append", "replace"):
        return errors(400, "mode must be append or replace")
    try:
        job = app_svc.enqueue_generate_from_snapshot(
            db,
            snap,
            mode=mode,
            preferred_engine=body.preferredEngine,
            target_url=body.targetUrl,
            auth_hint=body.authHint,
            focus_modules=body.focusModules,
            speed=body.speed,
            max_per_module=body.maxPerModule,
        )
    except ValueError as e:
        return errors(400, str(e))
    asyncio.create_task(process_generate_job(job.id))
    return ok(
        {
            "job": job_dto(job),
            "snapshotId": str(snap.id),
            "knowledgeVersion": snap.knowledge_version,
        },
        status_code=201,
    )


@router.post("/requirement-workspaces/{workspace_id}/freeze-and-generate")
async def freeze_and_generate(
    workspace_id: str,
    body: FreezeAndGenerateBody,
    db: Annotated[Session, Depends(get_db)],
    user=Depends(get_current_user),
):
    """R6+R7 CTA — Freeze then enqueue Generate TC from the new Snapshot."""
    import asyncio

    from app.routers.jobs import process_generate_job
    from app.serializers import job_dto

    wid = _uuid(workspace_id)
    if wid is None:
        return errors(400, "invalid workspace id")
    ws = app_svc.get_workspace(db, wid)
    if ws is None:
        return errors(404, "workspace not found")
    try:
        frozen = app_svc.freeze_knowledge(
            db,
            ws,
            frozen_by=getattr(user, "id", None),
            acknowledge_missing=body.acknowledgeMissing,
            note=body.note,
        )
        snap_id = uuid.UUID(str(frozen["snapshot"]["id"]))
        snap = app_svc.get_snapshot(db, snap_id)
        if snap is None:
            return errors(500, "snapshot missing after freeze")
        mode = (body.mode or "append").strip().lower()
        if mode not in ("append", "replace"):
            return errors(400, "mode must be append or replace")
        job = app_svc.enqueue_generate_from_snapshot(
            db,
            snap,
            mode=mode,
            preferred_engine=body.preferredEngine,
            target_url=body.targetUrl,
            auth_hint=body.authHint,
            focus_modules=body.focusModules,
            speed=body.speed,
            max_per_module=body.maxPerModule,
        )
    except ValueError as e:
        return errors(400, str(e))
    asyncio.create_task(process_generate_job(job.id))
    return ok(
        {
            "snapshot": frozen["snapshot"],
            "warnings": frozen.get("warnings") or [],
            "job": job_dto(job),
            "preferredEngine": (body.preferredEngine or "").strip().lower() or None,
        },
        status_code=201,
    )

