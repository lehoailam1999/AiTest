"""Requirement Studio application — upload (R1) + knowledge (R3)."""

from __future__ import annotations

import hashlib
import json
import logging
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import func, select
from sqlalchemy.orm import Session

from app import constants as C
from app.features.requirement_studio.chat_orchestrator import (
    apply_knowledge_diff,
    chat_system_prompt,
    empty_diff,
    heuristic_chat_turn,
    parse_chat_llm_json,
)
from app.features.requirement_studio.coverage_analyzer import (
    analyze_requirement_coverage,
    coverage_score_pct,
)
from app.features.requirement_studio.analysis_records import replace_analysis_records
from app.features.requirement_studio.knowledge_pipeline import (
    build_knowledge,
    clear_enrich_state,
    get_enrich_state,
    load_chunk_pairs,
    set_enrich_state,
)
from app.features.requirement_studio.dto import (
    chat_message_dto,
    chat_session_dto,
    file_ref_dto,
    knowledge_dto,
    snapshot_dto,
    truncate_extracted_text,
    truncate_preview,
    workspace_dto,
)
from app.features.requirement_studio.knowledge_builder import (
    normalize_knowledge_payload,
)
from app.features.requirement_studio.snapshot_prompt import (
    build_freeze_bundle,
    parse_json_field,
    snapshot_payload_to_prompt,
)
from app.models.domain import (
    AiBackendConnection,
    ChatMessage,
    ChatSession,
    GenerationTask,
    Job,
    KnowledgeWorkspace,
    Project,
    RequirementAnalysisRecord,
    RequirementFile,
    RequirementSnapshot,
    RequirementWorkspace,
    TestCase,
    WorkspaceRun,
)
from app.services.requirement_file_parse import parse_requirement_file
from app.services.vietnamese_labels import priority_order_expr

logger = logging.getLogger(__name__)

MAX_FILE_BYTES = 15_000_000
MAX_FILES_PER_REQUEST = 20


def _alive(model):
    return model.deleted_at.is_(None)


def get_project(db: Session, project_id: uuid.UUID) -> Project | None:
    return db.scalar(
        select(Project).where(Project.id == project_id, _alive(Project))
    )


def get_workspace(db: Session, workspace_id: uuid.UUID) -> RequirementWorkspace | None:
    return db.scalar(
        select(RequirementWorkspace).where(
            RequirementWorkspace.id == workspace_id,
            _alive(RequirementWorkspace),
        )
    )


def get_file(db: Session, file_id: uuid.UUID) -> RequirementFile | None:
    return db.scalar(
        select(RequirementFile).where(
            RequirementFile.id == file_id,
            _alive(RequirementFile),
        )
    )


def list_workspaces(db: Session, project_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(RequirementWorkspace)
        .where(
            RequirementWorkspace.project_id == project_id,
            _alive(RequirementWorkspace),
        )
        .order_by(RequirementWorkspace.updated_at.desc())
    ).all()
    out: list[dict] = []
    for ws in rows:
        file_count = db.scalar(
            select(func.count())
            .select_from(RequirementFile)
            .where(
                RequirementFile.workspace_id == ws.id,
                _alive(RequirementFile),
            )
        )
        snap_count = db.scalar(
            select(func.count())
            .select_from(RequirementSnapshot)
            .where(
                RequirementSnapshot.workspace_id == ws.id,
                _alive(RequirementSnapshot),
            )
        )
        snap_ids = list(
            db.scalars(
                select(RequirementSnapshot.id).where(
                    RequirementSnapshot.workspace_id == ws.id,
                    _alive(RequirementSnapshot),
                )
            ).all()
        )
        tc_total = 0
        tc_pending = 0
        tc_approved = 0
        if snap_ids:
            tc_total = int(
                db.scalar(
                    select(func.count())
                    .select_from(TestCase)
                    .where(
                        TestCase.requirement_snapshot_id.in_(snap_ids),
                        _alive(TestCase),
                    )
                )
                or 0
            )
            tc_pending = int(
                db.scalar(
                    select(func.count())
                    .select_from(TestCase)
                    .where(
                        TestCase.requirement_snapshot_id.in_(snap_ids),
                        TestCase.review_status == "Draft",
                        _alive(TestCase),
                    )
                )
                or 0
            )
            tc_approved = int(
                db.scalar(
                    select(func.count())
                    .select_from(TestCase)
                    .where(
                        TestCase.requirement_snapshot_id.in_(snap_ids),
                        TestCase.review_status == "Approved",
                        _alive(TestCase),
                    )
                )
                or 0
            )
        kw = get_knowledge_row(db, ws.id)
        dto = workspace_dto(
            ws,
            file_count=int(file_count or 0),
            knowledge_status=(kw.status if kw else "empty"),
        )
        dto["knowledgeVersion"] = int(kw.version or 0) if kw else 0
        dto["snapshotCount"] = int(snap_count or 0)
        dto["tcTotal"] = tc_total
        dto["tcPending"] = tc_pending
        dto["tcApproved"] = tc_approved
        out.append(dto)
    return out


def create_workspace(
    db: Session,
    project_id: uuid.UUID,
    *,
    title: str | None = None,
) -> dict:
    ws = RequirementWorkspace(
        project_id=project_id,
        title=(title or "").strip() or "Requirement mới",
        status="draft",
    )
    db.add(ws)
    db.commit()
    db.refresh(ws)
    return workspace_dto(ws, file_count=0, knowledge_status="empty")


def update_workspace(
    db: Session,
    workspace_id: uuid.UUID,
    *,
    title: str | None = None,
) -> dict | None:
    """Rename Requirement workspace (title only)."""
    ws = get_workspace(db, workspace_id)
    if ws is None:
        return None
    if title is not None:
        cleaned = (title or "").strip()
        if not cleaned:
            raise ValueError("title is required")
        ws.title = cleaned[:300]
    db.commit()
    db.refresh(ws)
    file_count = db.scalar(
        select(func.count())
        .select_from(RequirementFile)
        .where(
            RequirementFile.workspace_id == workspace_id,
            _alive(RequirementFile),
        )
    )
    kw = get_knowledge_row(db, workspace_id)
    return workspace_dto(
        ws,
        file_count=int(file_count or 0),
        knowledge_status=(kw.status if kw else "empty"),
    )


def hard_delete_workspace(db: Session, workspace_id: uuid.UUID) -> dict | None:
    """Hard-delete Requirement workspace and all related DB rows."""
    ws = db.get(RequirementWorkspace, workspace_id)
    if ws is None:
        return None

    snap_ids = [
        row.id
        for row in db.query(RequirementSnapshot.id)
        .filter(RequirementSnapshot.workspace_id == workspace_id)
        .all()
    ]

    tc_ids: list[uuid.UUID] = []
    if snap_ids:
        tc_ids = [
            row.id
            for row in db.query(TestCase.id)
            .filter(TestCase.requirement_snapshot_id.in_(snap_ids))
            .all()
        ]

    deleted_tc = 0
    if tc_ids:
        db.query(GenerationTask).filter(GenerationTask.test_case_id.in_(tc_ids)).delete(
            synchronize_session=False
        )
        db.query(WorkspaceRun).filter(WorkspaceRun.test_case_id.in_(tc_ids)).update(
            {WorkspaceRun.test_case_id: None},
            synchronize_session=False,
        )
        deleted_tc = (
            db.query(TestCase)
            .filter(TestCase.id.in_(tc_ids))
            .delete(synchronize_session=False)
        )

    deleted_jobs = 0
    if snap_ids:
        deleted_jobs = (
            db.query(Job)
            .filter(Job.requirement_snapshot_id.in_(snap_ids))
            .delete(synchronize_session=False)
        )

    deleted_snaps = (
        db.query(RequirementSnapshot)
        .filter(RequirementSnapshot.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )

    deleted_msgs = (
        db.query(ChatMessage)
        .filter(ChatMessage.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )
    deleted_sessions = (
        db.query(ChatSession)
        .filter(ChatSession.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )

    deleted_files = (
        db.query(RequirementFile)
        .filter(RequirementFile.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )
    deleted_knowledge = (
        db.query(KnowledgeWorkspace)
        .filter(KnowledgeWorkspace.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )
    deleted_analysis = (
        db.query(RequirementAnalysisRecord)
        .filter(RequirementAnalysisRecord.workspace_id == workspace_id)
        .delete(synchronize_session=False)
    )

    db.delete(ws)
    db.commit()
    return {
        "status": "deleted",
        "id": str(workspace_id),
        "deletedTestCases": int(deleted_tc or 0),
        "deletedJobs": int(deleted_jobs or 0),
        "deletedSnapshots": int(deleted_snaps or 0),
        "deletedChatMessages": int(deleted_msgs or 0),
        "deletedChatSessions": int(deleted_sessions or 0),
        "deletedFiles": int(deleted_files or 0),
        "deletedKnowledge": int(deleted_knowledge or 0),
        "deletedAnalysisRecords": int(deleted_analysis or 0),
    }


def ensure_default_workspace(db: Session, project_id: uuid.UUID) -> dict:
    existing = list_workspaces(db, project_id)
    if existing:
        return existing[0]
    return create_workspace(db, project_id, title="Requirement chính")


def list_files(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(RequirementFile)
        .where(
            RequirementFile.workspace_id == workspace_id,
            _alive(RequirementFile),
        )
        .order_by(RequirementFile.created_at.asc())
    ).all()
    return [file_ref_dto(f) for f in rows]


def get_file_detail(db: Session, file_id: uuid.UUID) -> dict | None:
    row = get_file(db, file_id)
    if row is None:
        return None
    return file_ref_dto(row, include_text=True)


def soft_delete_file(db: Session, file_id: uuid.UUID) -> RequirementFile | None:
    row = get_file(db, file_id)
    if row is None:
        return None
    now = datetime.now(timezone.utc)
    wid = row.workspace_id
    row.deleted_at = now
    db.commit()
    mark_knowledge_stale(db, wid)
    return row


def ingest_upload(
    db: Session,
    workspace: RequirementWorkspace,
    *,
    file_name: str,
    raw: bytes,
    mime_type: str | None,
) -> dict:
    """Parse + persist FileRef when parse succeeds (R1)."""
    name = (file_name or "upload").strip() or "upload"
    sha = hashlib.sha256(raw).hexdigest()
    mime = (mime_type or "").strip() or None

    row = RequirementFile(
        workspace_id=workspace.id,
        file_name=name,
        mime_type=mime,
        byte_size=len(raw),
        content_sha256=sha,
        parse_status="pending",
        storage_kind="inline",
        # Skip storing raw bytes by default — Phân tích uses extracted_text only.
        # Keeping multi‑MB docx (+ base64 preview) was hanging first upload / DB commit.
        content_bytes=None,
    )

    try:
        parsed = parse_requirement_file(raw, name)
        text = (parsed.text or "").strip()
        if not text:
            row.parse_status = "error"
            row.parse_error = parsed.warning or "Không đọc được nội dung file"
            row.parser = parsed.parser
            row.parse_warning = parsed.warning or None
            # Keep raw only on failure for possible re-parse / support
            if len(raw) <= 2_000_000:
                row.content_bytes = raw
        else:
            row.parse_status = "ready"
            row.parser = parsed.parser
            row.parse_warning = parsed.warning or None
            row.extracted_text = truncate_extracted_text(parsed.text)
            row.preview_html = truncate_preview(parsed.html)
    except ValueError as e:
        row.parse_status = "error"
        row.parse_error = str(e)
        if len(raw) <= 2_000_000:
            row.content_bytes = raw
    except Exception as e:
        row.parse_status = "error"
        row.parse_error = f"Parse failed: {e}"
        if len(raw) <= 2_000_000:
            row.content_bytes = raw

    db.add(row)
    db.flush()
    db.commit()
    db.refresh(row)
    mark_knowledge_stale(db, workspace.id)
    return file_ref_dto(row, include_text=False)


def get_knowledge_row(
    db: Session, workspace_id: uuid.UUID
) -> KnowledgeWorkspace | None:
    return db.scalar(
        select(KnowledgeWorkspace).where(
            KnowledgeWorkspace.workspace_id == workspace_id,
            _alive(KnowledgeWorkspace),
        )
    )


def get_knowledge(db: Session, workspace_id: uuid.UUID) -> dict:
    row = get_knowledge_row(db, workspace_id)
    enrich = get_enrich_state(workspace_id)
    # Heal orphaned building rows: enrich task died / API restarted / hung past TTL.
    if row is not None and (row.status or "") == "building":
        pending = bool(enrich.get("enrichPending"))
        age_sec = 0.0
        if row.updated_at is not None:
            try:
                age_sec = (
                    datetime.now(timezone.utc) - row.updated_at.astimezone(timezone.utc)
                ).total_seconds()
            except Exception:
                age_sec = 0.0
        # No live enrich marker, or stuck > 4 minutes → surface heuristic as ready.
        if (not pending) or age_sec > 240:
            row.status = "ready"
            if not row.error:
                row.error = (
                    "LLM enrich timeout/interrupted — giữ bản heuristic."
                    if pending or age_sec > 240
                    else None
                )
            db.commit()
            db.refresh(row)
            set_enrich_state(
                workspace_id,
                enrich_pending=False,
                enrich_error=row.error,
            )
            enrich = get_enrich_state(workspace_id)
    return knowledge_dto(row, enrich=enrich)


def mark_knowledge_stale(db: Session, workspace_id: uuid.UUID) -> None:
    row = get_knowledge_row(db, workspace_id)
    if row is None:
        return
    if row.status in ("ready", "building"):
        row.status = "stale"
        clear_enrich_state(workspace_id)
        db.commit()


def analyze_coverage(db: Session, workspace_id: uuid.UUID) -> dict:
    """Recompute Requirement Coverage from current Knowledge + file text (R4)."""
    row = get_knowledge_row(db, workspace_id)
    if row is None or row.status not in ("ready", "stale"):
        raise ValueError("Cần Knowledge Ready trước khi phân tích Coverage")
    payload = None
    if row.payload_json:
        try:
            payload = json.loads(row.payload_json)
        except Exception:
            payload = None
    pairs, _, _, _ = load_chunk_pairs(db, workspace_id)
    coverage = analyze_requirement_coverage(
        payload, chunk_texts=[t for _, t in pairs]
    )
    row.coverage_json = json.dumps(coverage, ensure_ascii=False)
    replace_analysis_records(
        db,
        workspace_id=row.workspace_id,
        project_id=row.project_id,
        knowledge_id=row.id,
        knowledge_version=row.version,
        payload=payload,
    )
    db.commit()
    db.refresh(row)
    return knowledge_dto(row, enrich=get_enrich_state(workspace_id))


def coverage_summary(db: Session, workspace_id: uuid.UUID) -> dict:
    dto = get_knowledge(db, workspace_id)
    cov = dto.get("coverage")
    return {
        "status": dto.get("status"),
        "coverage": cov,
        "scorePct": coverage_score_pct(cov) if isinstance(cov, dict) else None,
    }


def list_analysis_records(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(RequirementAnalysisRecord)
        .where(
            RequirementAnalysisRecord.workspace_id == workspace_id,
            _alive(RequirementAnalysisRecord),
        )
        .order_by(RequirementAnalysisRecord.created_at.asc())
    ).all()
    out: list[dict] = []
    for r in rows:
        content = None
        if r.content_json:
            try:
                content = json.loads(r.content_json)
            except Exception:
                content = None
        out.append(
            {
                "id": r.id,
                "workspaceId": r.workspace_id,
                "projectId": r.project_id,
                "knowledgeId": r.knowledge_id,
                "knowledgeVersion": r.knowledge_version,
                "type": r.type,
                "title": r.title,
                "itemCount": r.item_count,
                "content": content,
                "createdAt": r.created_at,
            }
        )
    return out


def list_chat_sessions(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(ChatSession)
        .where(ChatSession.workspace_id == workspace_id, _alive(ChatSession))
        .order_by(ChatSession.updated_at.desc())
    ).all()
    return [chat_session_dto(s) for s in rows]


def get_chat_session(db: Session, session_id: uuid.UUID) -> ChatSession | None:
    return db.scalar(
        select(ChatSession).where(ChatSession.id == session_id, _alive(ChatSession))
    )


def create_chat_session(
    db: Session,
    workspace: RequirementWorkspace,
    *,
    title: str | None = None,
) -> dict:
    kw = get_knowledge_row(db, workspace.id)
    if kw is None or kw.status not in ("ready", "stale", "updating"):
        raise ValueError("Knowledge chưa Ready — dựng Knowledge trước khi Chat (BR-V2-17)")
    session = ChatSession(
        workspace_id=workspace.id,
        knowledge_id=kw.id,
        title=(title or "").strip() or "Chat Knowledge",
        status="open",
        knowledge_version=int(kw.version or 0),
    )
    db.add(session)
    db.commit()
    db.refresh(session)
    return chat_session_dto(session)


def ensure_chat_session(db: Session, workspace: RequirementWorkspace) -> dict:
    existing = list_chat_sessions(db, workspace.id)
    if existing:
        return existing[0]
    return create_chat_session(db, workspace)


def list_chat_messages(db: Session, session_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(ChatMessage)
        .where(ChatMessage.session_id == session_id, _alive(ChatMessage))
        .order_by(ChatMessage.created_at.asc())
    ).all()
    return [chat_message_dto(m) for m in rows]


async def post_chat_turn(
    db: Session,
    workspace: RequirementWorkspace,
    session: ChatSession,
    *,
    message: str,
    use_llm: bool = True,
) -> dict:
    """
    One chat turn on Knowledge only (BR-V2-17).
    May apply knowledgeDiff → bump Knowledge version + refresh Coverage.
    """
    text = (message or "").strip()
    if not text:
        raise ValueError("Tin nhắn trống")
    if len(text) > 8000:
        raise ValueError("Tin nhắn quá dài (tối đa 8000 ký tự)")

    kw = get_knowledge_row(db, workspace.id)
    if kw is None or kw.status not in ("ready", "stale", "updating"):
        raise ValueError("Knowledge chưa Ready — không thể Chat")

    payload = {}
    if kw.payload_json:
        try:
            payload = json.loads(kw.payload_json) or {}
        except Exception:
            payload = {}

    user_msg = ChatMessage(
        session_id=session.id,
        workspace_id=workspace.id,
        role="user",
        content=text,
        knowledge_version=int(kw.version or 0),
    )
    db.add(user_msg)
    db.flush()

    # Mark updating while applying
    prev_status = kw.status
    kw.status = "updating"
    db.commit()
    db.refresh(kw)

    turn = heuristic_chat_turn(text, payload)
    source = "heuristic"

    if use_llm:
        try:
            from app.services.ai_service import chat_for_connection

            conn = db.scalar(
                select(AiBackendConnection).where(
                    AiBackendConnection.project_id == workspace.project_id
                )
            )
            if conn is not None:
                knowledge_snip = json.dumps(payload, ensure_ascii=False)[:18_000]
                user_prompt = (
                    "Knowledge Workspace JSON (only source of truth):\n"
                    f"{knowledge_snip}\n\n"
                    f"User message:\n{text}\n\n"
                    "Return JSON {reply, knowledgeDiff}."
                )
                raw, meta = await chat_for_connection(
                    conn, chat_system_prompt(), user_prompt
                )
                parsed = parse_chat_llm_json(raw)
                if parsed:
                    turn = parsed
                    source = (
                        "llm-cli"
                        if meta.get("runnerUsed") == "AI_CLI"
                        else "llm"
                    )
        except Exception as e:
            # Keep heuristic; note in reply footer if needed
            if not turn.get("reply"):
                turn = heuristic_chat_turn(text, payload)
            err = str(e)
            hint = ""
            low = err.lower()
            if "all connection attempts failed" in low or "unreachable" in low or "connect" in low:
                hint = (
                    " Gợi ý: Cấu hình AI → Base URL trỏ tới bridge đang chạy "
                    "(vd. http://127.0.0.1:11435/v1), Lưu + Xác minh lại."
                )
            turn["reply"] = (
                turn.get("reply", "")
                + f"\n\n_(LLM không dùng được — trả lời heuristic. {e}.{hint})_"
            )

    diff = turn.get("knowledgeDiff") or empty_diff()
    new_payload, applied = apply_knowledge_diff(payload, diff)
    knowledge_changed = len(applied) > 0
    if knowledge_changed:
        diff = {
            "ops": applied,
            "summary": (diff.get("summary") or f"{len(applied)} thay đổi Knowledge").strip(),
        }
        kw.payload_json = json.dumps(new_payload, ensure_ascii=False)
        kw.summary = (new_payload.get("summary") or "")[:4000] or kw.summary
        kw.version = int(kw.version or 0) + 1
        pairs, _, _, _ = load_chunk_pairs(db, workspace.id)
        coverage = analyze_requirement_coverage(
            new_payload, chunk_texts=[t for _, t in pairs]
        )
        kw.coverage_json = json.dumps(coverage, ensure_ascii=False)
        kw.builder = kw.builder or "chat"
        session.knowledge_version = kw.version
        replace_analysis_records(
            db,
            workspace_id=workspace.id,
            project_id=workspace.project_id,
            knowledge_id=kw.id,
            knowledge_version=kw.version,
            payload=new_payload,
        )

    # Restore ready (chat is allowed on stale too; stay stale if was stale and no rebuild)
    if prev_status == "stale" and not knowledge_changed:
        kw.status = "stale"
    else:
        kw.status = "ready"

    assistant = ChatMessage(
        session_id=session.id,
        workspace_id=workspace.id,
        role="assistant",
        content=str(turn.get("reply") or "").strip() or "(empty reply)",
        knowledge_version=int(kw.version or 0),
        knowledge_diff_json=json.dumps(diff, ensure_ascii=False)
        if knowledge_changed
        else None,
        meta_json=json.dumps({"source": source, "knowledgeChanged": knowledge_changed}),
    )
    db.add(assistant)
    session.updated_at = datetime.now(timezone.utc)
    db.commit()
    db.refresh(assistant)
    db.refresh(kw)

    return {
        "session": chat_session_dto(session),
        "userMessage": chat_message_dto(user_msg),
        "assistantMessage": chat_message_dto(assistant),
        "knowledgeDiff": diff if knowledge_changed else empty_diff(),
        "knowledge": knowledge_dto(kw),
        "knowledgeChanged": knowledge_changed,
    }


def _coverage_freeze_warnings(coverage: dict | None) -> list[dict]:
    """Coverage UI removed — no freeze gates from coverage."""
    return []


MAX_FILE_CHARS_TOTAL = 140_000
MAX_FILE_CHARS_EACH = 60_000
MAX_CHAT_MESSAGES = 100
MAX_CHAT_MSG_CHARS = 6_000
MAX_EXISTING_TCS = 80


def _collect_uploaded_files_for_freeze(
    db: Session, workspace_id: uuid.UUID
) -> list[dict]:
    files = db.scalars(
        select(RequirementFile)
        .where(
            RequirementFile.workspace_id == workspace_id,
            _alive(RequirementFile),
        )
        .order_by(RequirementFile.created_at.asc())
    ).all()
    out: list[dict] = []
    remaining = MAX_FILE_CHARS_TOTAL
    for f in files:
        if remaining <= 0:
            break
        text = (f.extracted_text or "").strip()
        if not text:
            out.append({"fileName": f.file_name, "text": ""})
            continue
        budget = min(MAX_FILE_CHARS_EACH, remaining)
        clipped = text[:budget]
        if len(text) > budget:
            clipped += "\n…[truncated]"
        remaining -= len(clipped)
        out.append({"fileName": f.file_name, "text": clipped})
    return out


def _collect_chat_for_freeze(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(ChatMessage)
        .where(
            ChatMessage.workspace_id == workspace_id,
            _alive(ChatMessage),
            ChatMessage.role.in_(("user", "assistant")),
        )
        .order_by(ChatMessage.created_at.asc())
        .limit(MAX_CHAT_MESSAGES)
    ).all()
    out: list[dict] = []
    for m in rows:
        content = (m.content or "").strip()
        if not content:
            continue
        if len(content) > MAX_CHAT_MSG_CHARS:
            content = content[:MAX_CHAT_MSG_CHARS] + "\n…[truncated]"
        out.append({"role": m.role, "content": content})
    return out


def _workspace_snapshot_ids(db: Session, workspace_id: uuid.UUID) -> list[uuid.UUID]:
    return list(
        db.scalars(
            select(RequirementSnapshot.id).where(
                RequirementSnapshot.workspace_id == workspace_id,
                _alive(RequirementSnapshot),
            )
        ).all()
    )


def _collect_existing_tcs_for_workspace(
    db: Session, workspace_id: uuid.UUID
) -> list[dict]:
    """Inventory of TCs already linked to this workspace's snapshots (hidden synth)."""
    snap_ids = _workspace_snapshot_ids(db, workspace_id)
    if not snap_ids:
        return []
    rows = db.scalars(
        select(TestCase)
        .where(
            TestCase.requirement_snapshot_id.in_(snap_ids),
            _alive(TestCase),
        )
        .order_by(
            priority_order_expr(TestCase.priority).asc(),
            TestCase.created_at.desc(),
        )
        .limit(MAX_EXISTING_TCS * 2)
    ).all()
    seen: set[str] = set()
    out: list[dict] = []
    for t in rows:
        key = f"{(t.title or '').strip().lower()}|{(t.type or '').strip().lower()}"
        if key in seen:
            continue
        seen.add(key)
        out.append(
            {
                "title": t.title,
                "type": t.type,
                "module": t.module,
                "priority": t.priority,
                "reviewStatus": t.review_status,
            }
        )
        if len(out) >= MAX_EXISTING_TCS:
            break
    return out


def freeze_knowledge(
    db: Session,
    workspace: RequirementWorkspace,
    *,
    frozen_by: uuid.UUID | None = None,
    acknowledge_missing: bool = False,
    note: str | None = None,
) -> dict:
    """
    R6 — Freeze Snapshot: docs + Knowledge + existing TC inventory (immutable).
    Generate TC synthesizes this bundle only (chat optional if present).
    """
    del acknowledge_missing  # Coverage gate removed
    kw = get_knowledge_row(db, workspace.id)
    if kw is None or int(kw.version or 0) < 1:
        raise ValueError("Knowledge chưa có version — dựng Knowledge trước khi Freeze")
    if kw.status not in ("ready", "stale"):
        raise ValueError(f"Không Freeze khi Knowledge status={kw.status}")

    knowledge_payload = normalize_knowledge_payload(
        parse_json_field(kw.payload_json) or {}
    )
    uploaded = _collect_uploaded_files_for_freeze(db, workspace.id)
    chat = _collect_chat_for_freeze(db, workspace.id)
    existing_tcs = _collect_existing_tcs_for_workspace(db, workspace.id)
    if not uploaded and not knowledge_payload and not chat:
        raise ValueError("Không có nội dung để Freeze (file / Knowledge trống)")

    bundle = build_freeze_bundle(
        knowledge_payload=knowledge_payload,
        knowledge_summary=kw.summary,
        uploaded_files=uploaded,
        chat_transcript=chat,
        existing_test_cases=existing_tcs,
    )
    warnings: list[dict] = []
    if not uploaded:
        warnings.append(
            {
                "code": "no_files",
                "message": "Snapshot không có text file upload — chỉ dùng Phân tích (+ TC đã có).",
            }
        )

    snap = RequirementSnapshot(
        workspace_id=workspace.id,
        project_id=workspace.project_id,
        knowledge_id=kw.id,
        knowledge_version=int(kw.version or 0),
        title=f"{workspace.title} · v{kw.version}",
        summary=kw.summary,
        payload_json=json.dumps(bundle, ensure_ascii=False),
        coverage_json=None,
        source_file_count=len(uploaded) or int(kw.source_file_count or 0),
        source_chunk_count=int(kw.source_chunk_count or 0),
        frozen_by=frozen_by,
        freeze_note=(note or "").strip() or None,
    )
    db.add(snap)
    workspace.status = "frozen"
    db.commit()
    db.refresh(snap)

    return {
        "snapshot": snapshot_dto(snap),
        "warnings": warnings,
        "bundleStats": {
            "fileCount": len(uploaded),
            "chatTurns": len(chat),
            "existingTestCaseCount": len(existing_tcs),
            "knowledgeVersion": int(kw.version or 0),
        },
        "acknowledgedMissing": False,
    }


def get_snapshot(db: Session, snapshot_id: uuid.UUID) -> RequirementSnapshot | None:
    return db.scalar(
        select(RequirementSnapshot).where(
            RequirementSnapshot.id == snapshot_id,
            _alive(RequirementSnapshot),
        )
    )


def list_snapshots(db: Session, workspace_id: uuid.UUID) -> list[dict]:
    rows = db.scalars(
        select(RequirementSnapshot)
        .where(
            RequirementSnapshot.workspace_id == workspace_id,
            _alive(RequirementSnapshot),
        )
        .order_by(RequirementSnapshot.created_at.desc())
    ).all()
    return [snapshot_dto(s, include_payload=False) for s in rows]


def latest_snapshot(db: Session, workspace_id: uuid.UUID) -> RequirementSnapshot | None:
    return db.scalar(
        select(RequirementSnapshot)
        .where(
            RequirementSnapshot.workspace_id == workspace_id,
            _alive(RequirementSnapshot),
        )
        .order_by(RequirementSnapshot.created_at.desc())
        .limit(1)
    )


def snapshot_prompt_content(
    snap: RequirementSnapshot,
    *,
    slim_for_tc_gen: bool = False,
) -> str:
    return snapshot_payload_to_prompt(
        title=snap.title,
        summary=snap.summary,
        payload=parse_json_field(snap.payload_json),
        coverage=parse_json_field(snap.coverage_json),
        knowledge_version=int(snap.knowledge_version or 0),
        omit_docs_when_rich=slim_for_tc_gen,
        existing_titles_only=slim_for_tc_gen,
    )


def enqueue_generate_from_snapshot(
    db: Session,
    snap: RequirementSnapshot,
    *,
    mode: str = "append",
    preferred_engine: str | None = None,
    target_url: str | None = None,
    auth_hint: str | None = None,
    focus_modules: str | None = None,
    speed: str | None = None,
    max_per_module: int | None = None,
) -> Job:
    """R7 — create Job bound to snapshotId only (BR-V2-16)."""
    from app.services.job_context_stash import stash_job_engine_hint

    if mode not in ("append", "replace"):
        raise ValueError("mode must be append or replace")

    eng = (preferred_engine or "").strip().lower()
    if eng and eng not in ("unit", "e2e"):
        raise ValueError("preferredEngine must be unit or e2e when set")
    speed_n = (speed or "").strip().lower() or None
    if speed_n and speed_n not in ("fast", "full"):
        raise ValueError("speed must be fast or full when set")
    # Target URL optional for TC generation (used in precondition if provided).
    # Required only when running E2E codegen / headless on E2E Test page.

    conn = db.scalar(
        select(AiBackendConnection).where(
            AiBackendConnection.project_id == snap.project_id
        )
    )
    if conn is None or not C.is_ai_ready(conn.status):
        raise ValueError(
            "AI chưa Ready — vào Settings cấu hình AI CLI và Verify"
        )

    content = snapshot_prompt_content(snap)
    if not content.strip():
        raise ValueError("Snapshot content empty")

    job = Job(
        project_id=snap.project_id,
        source_id=None,
        requirement_snapshot_id=snap.id,
        status=C.JOB_QUEUED,
        backend_type=conn.backend_type,
        generate_strategy=mode,
        requirement_version=int(snap.knowledge_version or 0),
    )
    db.add(job)
    db.commit()
    db.refresh(job)
    if eng:
        hint: dict = {
            "preferredEngine": eng,
            "targetUrl": (target_url or "").strip() or None,
            "authHint": (auth_hint or "").strip() or None,
            "focusModules": (focus_modules or "").strip() or None,
        }
        if speed_n:
            hint["speed"] = speed_n
        if max_per_module is not None:
            hint["maxPerModule"] = int(max_per_module)
        stash_job_engine_hint(job.id, hint)
    return job

