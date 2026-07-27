from __future__ import annotations

import asyncio
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, Request
from sqlalchemy.orm import Session

from app import constants as C
from app.database import SessionLocal, get_db
from app.deps import get_current_user
from app.models.domain import (
    AiBackendConnection,
    Job,
    Project,
    RequirementSnapshot,
    Source,
    TestCase,
)
from app.responses import errors, ok, page, page_params
from app.serializers import connection_dto, job_dto, source_dto
from app.services.connection_service import (
    connection_api_key,
)
from app.llm.base import GenerateContext
from app.services.ai_service import (
    RUNNER_AI_CLI,
    connection_runner_mode,
    generate_test_cases_for_connection,
)
from app.services.requirement_content import (
    change_summary_from_description,
    content_meta_from_description,
    enrich_features_with_files,
    normalize_function_label,
    parse_features,
    source_content_hash,
)
from app.llm.tc_generation_rules import get_tc_generation_rules
from app.services.job_context_stash import (
    pop_job_extras,
    stash_job_context_packet,
    stash_job_topic_scope,
)
from app.services.requirement_topics import (
    format_topic_scope_for_prompt,
    tc_matches_module_scope,
)
from app.services.testcase_dedup import dup_key

GenerateMode = Literal["append", "replace"]

router = APIRouter(prefix="/api", tags=["jobs"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _fail_job(db: Session, job_id: uuid.UUID, msg: str) -> None:
    job = db.query(Job).filter(Job.id == job_id).first()
    if job:
        job.status = C.JOB_FAILED
        job.error = msg
        job.completed_at = datetime.now(timezone.utc)
        db.commit()


async def process_generate_job(job_id: uuid.UUID) -> None:
    """Async worker — generate test cases from requirement source."""
    db = SessionLocal()
    try:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job is None:
            return
        mode: GenerateMode = (job.generate_strategy or "append")  # type: ignore[assignment]
        job.status = C.JOB_RUNNING
        job.started_at = datetime.now(timezone.utc)
        db.commit()

        conn = (
            db.query(AiBackendConnection)
            .filter(AiBackendConnection.project_id == job.project_id)
            .first()
        )
        if conn is None:
            _fail_job(db, job_id, "connection not found")
            return
        try:
            api_key = connection_api_key(conn)
        except ValueError as exc:
            if connection_runner_mode(conn) != RUNNER_AI_CLI:
                _fail_job(db, job_id, str(exc))
                return
            api_key = ""

        title, content = "Requirement", ""
        doc_hash: str | None = None
        doc_version: int = 1
        change_summary: str | None = None
        src: Source | None = None
        snap: RequirementSnapshot | None = None
        snap_id = getattr(job, "requirement_snapshot_id", None)
        if snap_id:
            snap = (
                db.query(RequirementSnapshot)
                .filter(RequirementSnapshot.id == snap_id)
                .first()
            )
            if snap is None:
                _fail_job(db, job_id, "requirement snapshot not found")
                return
            from app.features.requirement_studio.application import snapshot_prompt_content

            title = snap.title or "Requirement Snapshot"
            content = snapshot_prompt_content(snap)
            doc_version = int(snap.knowledge_version or 0) or 1
            doc_hash = None
        elif job.source_id:
            src = db.query(Source).filter(Source.id == job.source_id).first()
            if src:
                title, content = src.title, src.content
                doc_hash = source_content_hash(src.content, src.description)
                _, doc_version = content_meta_from_description(src.description)
                change_summary = change_summary_from_description(src.description)
        if not content.strip():
            _fail_job(
                db,
                job_id,
                "snapshot content empty" if snap_id else "source content empty",
            )
            return

        extras = pop_job_extras(job_id)
        source_ctx = extras.get("context") if isinstance(extras.get("context"), str) else None
        topic_scope_text: str | None = None
        default_module: str | None = None
        scope_topic_notes: str | None = None
        raw_topic = extras.get("topicScope")
        if isinstance(raw_topic, dict) and raw_topic.get("title"):
            topic_scope_text = format_topic_scope_for_prompt(raw_topic)
            default_module = str(raw_topic.get("title") or "").strip() or None
            notes_raw = str(raw_topic.get("notes") or "").strip()
            scope_topic_notes = notes_raw or None

        existing_for_prompt: list[tuple[str, str]] = []
        if mode == "append" and (job.source_id or snap_id):
            prior_q = db.query(TestCase).filter(TestCase.project_id == job.project_id)
            if snap and snap.workspace_id:
                sibling_ids = [
                    row[0]
                    for row in db.query(RequirementSnapshot.id)
                    .filter(
                        RequirementSnapshot.workspace_id == snap.workspace_id,
                        RequirementSnapshot.deleted_at.is_(None),
                    )
                    .all()
                ]
                if sibling_ids:
                    prior_q = prior_q.filter(
                        TestCase.requirement_snapshot_id.in_(sibling_ids)
                    )
                else:
                    prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
            elif snap_id:
                prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
            else:
                prior_q = prior_q.filter(TestCase.source_id == job.source_id)
            prior = prior_q.all()
            if default_module:
                prior = [t for t in prior if tc_matches_module_scope(t.module, default_module)]
            existing_for_prompt = [(t.title, t.type) for t in prior]

        custom_rules = get_tc_generation_rules()
        feature_titles = [
            normalize_function_label(f.get("title") or "") or str(f.get("title") or "").strip()
            for f in enrich_features_with_files(
                parse_features(content), src.description if src else None
            )
            if (f.get("title") or f.get("content"))
        ]

        ctx = GenerateContext(
            mode=mode,
            content_version=doc_version,
            change_summary=change_summary,
            existing_cases=existing_for_prompt if mode == "append" else [],
            source_context=source_ctx,
            topic_scope=topic_scope_text,
            scope_topic_notes=scope_topic_notes,
            requirement_description=src.description if src else None,
            custom_rules=custom_rules,
            feature_titles=[t for t in feature_titles if t],
        )

        drafts: list = []
        fan_errors: list[str] = []
        runner_meta: dict = {"runnerUsed": "API_DIRECT", "cliSessionKey": None}
        try:
            # Nhiều Feature trong 1 lần gọi → JSON dễ bị cắt (Unterminated string).
            # Fan-out nội bộ: 1 LLM call / chức năng khi chưa có topicScope từ FE.
            titles_for_fan = [t for t in feature_titles if t]
            if len(titles_for_fan) > 1 and not topic_scope_text:
                for feat_title in titles_for_fan:
                    scoped = GenerateContext(
                        mode=mode,
                        content_version=doc_version,
                        change_summary=change_summary,
                        existing_cases=existing_for_prompt if mode == "append" else [],
                        source_context=source_ctx,
                        topic_scope=format_topic_scope_for_prompt(
                            {"title": feat_title, "notes": "", "items": []}
                        ),
                        scope_topic_notes=None,
                        requirement_description=src.description if src else None,
                        custom_rules=custom_rules,
                        feature_titles=[feat_title],
                    )
                    try:
                        part, meta = await generate_test_cases_for_connection(
                            conn, title, content, scoped, api_key=api_key
                        )
                        runner_meta = meta
                        for d in part:
                            if not d.module:
                                d.module = feat_title
                        drafts.extend(part)
                    except Exception as exc:  # noqa: BLE001
                        fan_errors.append(f"{feat_title}: {exc}")
                if not drafts:
                    _fail_job(
                        db,
                        job_id,
                        "Sinh TC thất bại mọi chức năng — "
                        + "; ".join(fan_errors[:5])
                        + ("…" if len(fan_errors) > 5 else ""),
                    )
                    return
            else:
                drafts, runner_meta = await generate_test_cases_for_connection(
                    conn, title, content, ctx, api_key=api_key
                )
        except Exception as exc:  # noqa: BLE001
            _fail_job(db, job_id, str(exc))
            return

        try:
            job.runner_used = runner_meta.get("runnerUsed")
            job.cli_session_key = runner_meta.get("cliSessionKey")
            db.commit()
        except Exception:
            db.rollback()
            job = db.query(Job).filter(Job.id == job_id).first()

        if mode == "replace" and (job.source_id or snap_id):
            q = db.query(TestCase).filter(
                TestCase.project_id == job.project_id,
                TestCase.review_status == C.REVIEW_DRAFT,
            )
            if snap_id:
                q = q.filter(TestCase.requirement_snapshot_id == snap_id)
            elif job.source_id:
                q = q.filter(TestCase.source_id == job.source_id)
            if default_module:
                scoped = q.all()
                for t in scoped:
                    if tc_matches_module_scope(t.module, default_module):
                        db.delete(t)
            else:
                q.delete(synchronize_session=False)
            db.commit()

        count = db.query(TestCase).filter(TestCase.project_id == job.project_id).count()

        existing_keys: set[str] = set()
        if mode == "append" and (job.source_id or snap_id):
            prior_q = db.query(TestCase).filter(TestCase.project_id == job.project_id)
            if snap and snap.workspace_id:
                sibling_ids = [
                    row[0]
                    for row in db.query(RequirementSnapshot.id)
                    .filter(
                        RequirementSnapshot.workspace_id == snap.workspace_id,
                        RequirementSnapshot.deleted_at.is_(None),
                    )
                    .all()
                ]
                if sibling_ids:
                    prior_q = prior_q.filter(
                        TestCase.requirement_snapshot_id.in_(sibling_ids)
                    )
                else:
                    prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
            elif snap_id:
                prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
            else:
                prior_q = prior_q.filter(TestCase.source_id == job.source_id)
            prior = prior_q.all()
            if default_module:
                prior = [t for t in prior if tc_matches_module_scope(t.module, default_module)]
            existing_keys = {dup_key(t.title, t.steps) for t in prior}

        for d in drafts:
            key = dup_key(d.title, d.steps)
            if key in existing_keys:
                continue
            existing_keys.add(key)
            count += 1
            mod = normalize_function_label(d.module or default_module or "") or default_module
            db.add(
                TestCase(
                    project_id=job.project_id,
                    source_id=job.source_id,
                    requirement_snapshot_id=snap_id,
                    job_id=job.id,
                    test_case_code=f"TC-{count:03d}",
                    title=d.title,
                    module=mod,
                    type=d.type,
                    priority=d.priority,
                    severity=d.severity,
                    precondition=d.precondition,
                    steps=d.steps,
                    expected_result=d.expected_result,
                    test_data=d.test_data,
                    automation_ready=d.automation_ready,
                    is_ai_generated=True,
                    review_status=C.REVIEW_DRAFT,
                    execution_status="Pending",
                    generated_from_hash=doc_hash,
                    generated_from_version=doc_version,
                )
            )
        job.status = C.JOB_COMPLETED
        job.completed_at = datetime.now(timezone.utc)
        # Partial fan-out: vẫn Completed nhưng ghi chú chức năng lỗi
        if fan_errors:
            job.error = (
                f"Hoàn tất một phần — lỗi {len(fan_errors)} chức năng: "
                + "; ".join(fan_errors[:4])
                + ("…" if len(fan_errors) > 4 else "")
            )
        else:
            job.error = None
        db.commit()
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        _fail_job(db, job_id, str(exc))
    finally:
        db.close()


@router.post("/jobs")
async def create_job(request: Request, db: Annotated[Session, Depends(get_db)]):
    body = await request.json()
    pid = _uuid(str(body.get("projectId") or ""))
    if pid is None:
        return errors(400, "projectId required")
    project = db.query(Project).filter(Project.id == pid, Project.deleted_at.is_(None)).first()
    if project is None:
        return errors(404, "Project not found")

    source_id = None
    src: Source | None = None
    if body.get("sourceId"):
        source_id = _uuid(str(body["sourceId"]))
        src = (
            db.query(Source)
            .filter(Source.id == source_id, Source.project_id == pid)
            .first()
        )
        if src is None:
            return errors(400, "source not found in project")

    mode_raw = (body.get("mode") or "append").strip().lower()
    if mode_raw not in ("append", "replace"):
        return errors(400, "mode must be append or replace")
    mode: GenerateMode = mode_raw  # type: ignore[assignment]

    req_version = 1
    if src:
        _, req_version = content_meta_from_description(src.description)

    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == pid)
        .first()
    )
    if conn is None or not C.is_ai_ready(conn.status):
        return errors(
            400, "AI chưa Ready — vào Settings cấu hình API Key hoặc AI CLI và Verify"
        )
    if connection_runner_mode(conn) != RUNNER_AI_CLI:
        try:
            connection_api_key(conn)
        except ValueError:
            return errors(400, "Chưa có API Key — vào Settings để lưu key")

    job = Job(
        project_id=pid,
        source_id=source_id,
        status=C.JOB_QUEUED,
        backend_type=conn.backend_type,
        generate_strategy=mode,
        requirement_version=req_version,
    )
    db.add(job)
    db.commit()
    db.refresh(job)

    packet = body.get("contextPacket") or body.get("repoContext")
    if body.get("useSourceContext") is True and isinstance(packet, dict) and packet.get("packetVersion") == 1:
        stash_job_context_packet(job.id, packet)

    topic = body.get("topicScope")
    if isinstance(topic, dict) and (topic.get("title") or "").strip():
        stash_job_topic_scope(job.id, topic)
    elif src and body.get("expandAllTopics") is not False:
        # No explicit topic → if multi-feature, stash is left empty;
        # FE should fan-out. Still ensure topics exist for coverage board.
        from app.services.requirement_topics import sync_topics_from_features
        from app.services.requirement_content import parse_features

        feats = parse_features(src.content or "")
        if feats:
            synced = sync_topics_from_features(src.description, feats)
            if synced != src.description:
                src.description = synced
                db.commit()

    asyncio.create_task(process_generate_job(job.id))
    return ok(job_dto(job))


@router.get("/jobs")
def list_jobs(request: Request, db: Annotated[Session, Depends(get_db)]):
    page_number, size = page_params(
        request.query_params.get("page"), request.query_params.get("pageSize")
    )
    q = db.query(Job)
    project_q = request.query_params.get("projectId")
    if project_q:
        pid = _uuid(project_q)
        if pid is not None:
            q = q.filter(Job.project_id == pid)
    total = q.count()
    items = (
        q.order_by(Job.created_at.desc())
        .offset((page_number - 1) * size)
        .limit(size)
        .all()
    )
    return ok(page([job_dto(j) for j in items], total, page_number, size))


@router.get("/jobs/{job_id}")
def get_job(job_id: str, db: Annotated[Session, Depends(get_db)]):
    jid = _uuid(job_id)
    if jid is None:
        return errors(400, "invalid id")
    job = db.query(Job).filter(Job.id == jid).first()
    if job is None:
        return errors(404, "not found")
    return ok(job_dto(job))


@router.get("/jobs/{job_id}/context")
def get_job_context(job_id: str, db: Annotated[Session, Depends(get_db)]):
    jid = _uuid(job_id)
    if jid is None:
        return errors(400, "invalid id")
    job = db.query(Job).filter(Job.id == jid).first()
    if job is None:
        return errors(404, "not found")
    out: dict = {"job": job_dto(job)}
    if job.source_id:
        src = db.query(Source).filter(Source.id == job.source_id).first()
        if src:
            out["source"] = source_dto(src)
    conn = (
        db.query(AiBackendConnection)
        .filter(AiBackendConnection.project_id == job.project_id)
        .first()
    )
    if conn:
        out["connection"] = connection_dto(conn)
    return ok(out)


@router.patch("/jobs/{job_id}")
async def patch_job(job_id: str, request: Request, db: Annotated[Session, Depends(get_db)]):
    jid = _uuid(job_id)
    if jid is None:
        return errors(400, "invalid id")
    job = db.query(Job).filter(Job.id == jid).first()
    if job is None:
        return errors(404, "not found")
    body = await request.json()
    status_val = body.get("status")
    if not status_val:
        return errors(400, "status required")
    if status_val not in (
        C.JOB_RUNNING,
        C.JOB_COMPLETED,
        C.JOB_FAILED,
        C.JOB_QUEUED,
        C.JOB_PENDING_WORKER,
    ):
        return errors(400, "invalid status")
    job.status = status_val
    job.error = body.get("error")
    now = datetime.now(timezone.utc)
    if status_val == C.JOB_RUNNING and job.started_at is None:
        job.started_at = now
    if status_val in (C.JOB_COMPLETED, C.JOB_FAILED):
        job.completed_at = now
    db.commit()
    db.refresh(job)
    return ok(job_dto(job))
