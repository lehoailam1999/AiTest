from __future__ import annotations

import asyncio
import json
import os
import re
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
    RequirementAnalysisRecord,
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
    connection_is_cursor_cli,
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
from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules
from app.services.job_context_stash import (
    pop_job_extras,
    stash_job_context_packet,
    stash_job_topic_scope,
)
from app.services.vietnamese_labels import normalize_engine_type
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
    from app.services.job_progress import clear_job_progress, set_job_progress

    job = db.query(Job).filter(Job.id == job_id).first()
    if job:
        job.status = C.JOB_FAILED
        job.error = msg
        job.progress_message = f"Thất bại: {(msg or '')[:500]}"
        job.completed_at = datetime.now(timezone.utc)
        db.commit()
    set_job_progress(job_id, f"Thất bại: {(msg or '')[:500]}", persist=True)
    clear_job_progress(job_id)


def _engine_bucket(tc_type: str | None) -> str:
    """unit | e2e — canonical buckets for Studio filtering."""
    canon = normalize_engine_type(tc_type)
    if canon == "E2E":
        return "e2e"
    return "unit"


def _tc_matches_preferred_engine(tc_type: str | None, preferred: str) -> bool:
    bucket = _engine_bucket(tc_type)
    if preferred == "e2e":
        return bucket == "e2e"
    if preferred == "unit":
        return bucket == "unit"
    return True


def _coerce_draft_type(raw: str | None, preferred: str | None) -> str:
    # DB persistence guard: when engine is selected, force exactly 2 buckets.
    if preferred == "e2e":
        return "E2E"
    if preferred == "unit":
        return "Unit"
    canon = normalize_engine_type(raw)
    if canon == "E2E":
        return "E2E"
    return "Unit"


def _load_existing_tc_keys(
    db: Session,
    *,
    project_id: uuid.UUID,
    mode: str,
    source_id: uuid.UUID | None,
    snap_id: uuid.UUID | None,
    snap: RequirementSnapshot | None,
    default_module: str | None,
    preferred_engine: str | None,
) -> set[str]:
    """Dedup keys for append mode (same scope filters as final persist)."""
    if mode != "append" or not (source_id or snap_id):
        return set()
    prior_q = db.query(TestCase).filter(TestCase.project_id == project_id)
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
            prior_q = prior_q.filter(TestCase.requirement_snapshot_id.in_(sibling_ids))
        else:
            prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
    elif snap_id:
        prior_q = prior_q.filter(TestCase.requirement_snapshot_id == snap_id)
    else:
        prior_q = prior_q.filter(TestCase.source_id == source_id)
    prior = prior_q.all()
    if default_module:
        prior = [t for t in prior if tc_matches_module_scope(t.module, default_module)]
    if preferred_engine:
        prior = [
            t
            for t in prior
            if _tc_matches_preferred_engine(t.type, preferred_engine)
        ]
    return {dup_key(t.title, t.steps) for t in prior}


def _replace_draft_tcs(
    db: Session,
    *,
    project_id: uuid.UUID,
    source_id: uuid.UUID | None,
    snap_id: uuid.UUID | None,
    default_module: str | None,
    preferred_engine: str | None,
) -> int:
    """Delete draft TCs in scope before replace-mode generate. Returns deleted count."""
    q = db.query(TestCase).filter(
        TestCase.project_id == project_id,
        TestCase.review_status == C.REVIEW_DRAFT,
    )
    if snap_id:
        q = q.filter(TestCase.requirement_snapshot_id == snap_id)
    elif source_id:
        q = q.filter(TestCase.source_id == source_id)
    to_remove = q.all()
    if default_module:
        to_remove = [
            t for t in to_remove if tc_matches_module_scope(t.module, default_module)
        ]
    if preferred_engine:
        to_remove = [
            t
            for t in to_remove
            if _tc_matches_preferred_engine(t.type, preferred_engine)
        ]
    n = len(to_remove)
    for t in to_remove:
        db.delete(t)
    if n:
        db.commit()
    return n


def _persist_generated_drafts(
    db: Session,
    *,
    project_id: uuid.UUID,
    job_id: uuid.UUID,
    source_id: uuid.UUID | None,
    snap_id: uuid.UUID | None,
    drafts: list,
    existing_keys: set[str],
    default_module: str | None,
    preferred_engine: str | None,
    doc_hash: str | None,
    doc_version: int,
) -> int:
    """
    Insert new TestCase rows from drafts (dedupe via existing_keys, mutated in-place).
    Same mapping rules as legacy end-of-job persist — Unit/E2E type coerce unchanged.
    Returns number of rows inserted.
    """
    if not drafts:
        return 0
    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    inserted = 0
    for d in drafts:
        key = dup_key(d.title, d.steps)
        if key in existing_keys:
            continue
        existing_keys.add(key)
        count += 1
        inserted += 1
        mod = normalize_function_label(d.module or default_module or "") or default_module
        tc_type = _coerce_draft_type(d.type, preferred_engine)
        db.add(
            TestCase(
                project_id=project_id,
                source_id=source_id,
                requirement_snapshot_id=snap_id,
                job_id=job_id,
                test_case_code=f"TC-{count:03d}",
                title=d.title,
                module=mod,
                type=tc_type,
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
    if inserted:
        db.commit()
    return inserted


def _engine_readiness_issues(bundle: dict | None, preferred: str | None) -> list[str]:
    """
    Soft readiness for Studio TC gen — same bar for Unit and E2E.
    Only hard-block when completely missing features/useCases.
    Extra gaps become warnings (logged), not job failures.
    """
    if not preferred or not isinstance(bundle, dict):
        return []
    knowledge = bundle.get("knowledge") if isinstance(bundle.get("knowledge"), dict) else bundle
    features = knowledge.get("features") if isinstance(knowledge.get("features"), list) else []
    use_cases = knowledge.get("useCases") if isinstance(knowledge.get("useCases"), list) else []
    issues: list[str] = []
    if not features and not use_cases:
        issues.append("thiếu feature/use case để chia module")
    return issues[:3]


def _engine_readiness_warnings(bundle: dict | None, preferred: str | None) -> list[str]:
    """Non-blocking gaps — logged into AI CLI nhật ký."""
    if not preferred or not isinstance(bundle, dict):
        return []
    knowledge = bundle.get("knowledge") if isinstance(bundle.get("knowledge"), dict) else bundle
    gaps = knowledge.get("gaps") if isinstance(knowledge.get("gaps"), list) else []
    actors = knowledge.get("actors") if isinstance(knowledge.get("actors"), list) else []
    rules = knowledge.get("businessRules") if isinstance(knowledge.get("businessRules"), list) else []
    validations = (
        knowledge.get("validationRules")
        if isinstance(knowledge.get("validationRules"), list)
        else []
    )
    acceptance = (
        knowledge.get("acceptanceCriteria")
        if isinstance(knowledge.get("acceptanceCriteria"), list)
        else []
    )
    apis = knowledge.get("apiSummary") if isinstance(knowledge.get("apiSummary"), list) else []
    entities = (
        knowledge.get("databaseSummary")
        if isinstance(knowledge.get("databaseSummary"), list)
        else []
    )
    warns: list[str] = []
    if preferred == "unit":
        if not rules:
            warns.append("thiếu business rules (Unit vẫn chạy — coverage có thể mỏng)")
        if not validations and not apis and not entities:
            warns.append("thiếu validation/API/entity (Unit vẫn chạy)")
    if preferred == "e2e":
        if not actors:
            warns.append("thiếu actor/role (E2E vẫn chạy — precondition auth có thể chung)")
        if not validations:
            warns.append("thiếu validation UI (E2E vẫn chạy)")
        if not acceptance:
            warns.append("thiếu acceptance criteria (E2E vẫn chạy)")
    for row in gaps[:5]:
        text = str(row.get("text") if isinstance(row, dict) else row).strip()
        if text:
            warns.append(f"gap: {text[:160]}")
    seen: set[str] = set()
    out: list[str] = []
    for item in warns:
        key = item.strip().lower()
        if not key or key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out[:6]


def _analysis_records_prompt_block(
    db: Session,
    *,
    workspace_id: uuid.UUID | None,
    knowledge_version: int | None,
) -> str:
    if workspace_id is None:
        return ""
    q = db.query(RequirementAnalysisRecord).filter(
        RequirementAnalysisRecord.workspace_id == workspace_id,
        RequirementAnalysisRecord.deleted_at.is_(None),
    )
    if knowledge_version and int(knowledge_version) > 0:
        q = q.filter(RequirementAnalysisRecord.knowledge_version == int(knowledge_version))
    rows = q.order_by(RequirementAnalysisRecord.created_at.asc()).all()
    if not rows:
        return ""
    parts: list[str] = [
        "## KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB (NGUỒN CHÍNH ĐỂ SINH TEST CASE)",
        "Bắt buộc bám sát các mục sau, không bỏ sót tiêu chí nào:",
    ]
    for r in rows:
        content = ""
        if r.content_json:
            try:
                parsed = json.loads(r.content_json)
                content = json.dumps(parsed, ensure_ascii=False)
            except Exception:
                content = r.content_json
        parts.append(
            f"- [{r.type}] {r.title} | itemCount={int(r.item_count or 0)}\n"
            f"{content[:5000]}"
        )
    parts.append(
        "Quy tắc coverage: mọi test case phải truy vết được về ít nhất một mục phân tích ở trên."
    )
    return "\n\n".join(parts)


def _module_tokens(module: str) -> list[str]:
    raw = (module or "").strip().lower()
    if not raw:
        return []
    parts = re.split(r"[\s/|_,.;:()\[\]{}+\-]+", raw)
    out: list[str] = []
    seen: set[str] = set()
    for p in parts:
        t = p.strip()
        if len(t) < 3 or t in seen:
            continue
        # skip very common Vietnamese/English glue words
        if t in {
            "qua",
            "với",
            "các",
            "của",
            "and",
            "the",
            "for",
            "via",
            "rest",
            "api",
            "requirements",
            "frontend",
            "backend",
        }:
            continue
        seen.add(t)
        out.append(t)
    # keep useful short domain tokens
    for keep in ("todo", "auth", "login", "ui", "user"):
        if keep in raw and keep not in seen:
            out.append(keep)
            seen.add(keep)
    return out[:12]


def _filter_text_for_module(text: str, module: str, *, soft_max: int = 18_000) -> str:
    """
    Keep paragraphs relevant to one module so fan-out prompts stay smaller.
    Falls back to head truncate if filter is too aggressive (quality-safe).
    """
    block = (text or "").strip()
    if not block:
        return ""
    tokens = _module_tokens(module)
    if not tokens:
        return block if len(block) <= soft_max else block[: soft_max - 20] + "\n...[truncated]"
    paras = re.split(r"\n{2,}", block)
    head = paras[:3]
    matched = [p for p in paras if any(tok in p.lower() for tok in tokens)]
    merged: list[str] = []
    seen: set[str] = set()
    for p in head + matched:
        key = p[:120]
        if key in seen:
            continue
        seen.add(key)
        merged.append(p)
    out = "\n\n".join(merged).strip()
    # Too aggressive → keep original head (still bounded)
    if len(out) < max(1200, soft_max // 8):
        out = block
    if len(out) <= soft_max:
        return out
    return out[: soft_max - 20] + "\n...[truncated]"


def _source_scan_prompt_block(
    project_id: uuid.UUID,
    *,
    max_files: int = 36,
    module_hint: str | None = None,
    char_budget: int = 55_000,
) -> str:
    """
    Build compact source context from bound workspace root.
    Reads many files (bounded) before sending to AI CLI.
    """
    from app.features.workspace.di import get_workspace_adapter

    adapter = get_workspace_adapter()
    getter = getattr(adapter, "get_active_workspace_id", None)
    if not callable(getter):
        return ""
    wid = getter(str(project_id))
    if not wid:
        return ""
    session = adapter.get_session(wid)
    if session is None:
        return ""
    try:
        items, _total = adapter.list_files(wid, limit=400, cursor=0)
    except Exception:
        return ""
    allowed_ext = {
        ".py", ".ts", ".tsx", ".js", ".jsx", ".java", ".kt", ".cs", ".go", ".rs",
        ".sql", ".yaml", ".yml", ".json", ".md",
    }
    candidates = [f for f in items if (f.extension or "").lower() in allowed_ext]
    tokens = _module_tokens(module_hint or "")
    if tokens:
        scored: list[tuple[int, object]] = []
        for f in candidates:
            path_l = (f.relative_path or "").lower()
            score = sum(1 for t in tokens if t in path_l)
            scored.append((score, f))
        scored.sort(key=lambda x: (-x[0], x[1].relative_path or ""))
        # Prefer matching paths, then fill remaining slots
        matched = [f for s, f in scored if s > 0][:max_files]
        if len(matched) < max(8, max_files // 3):
            rest = [f for s, f in scored if s == 0]
            matched.extend(rest[: max_files - len(matched)])
        picked = matched[:max_files]
    else:
        picked = candidates[:max_files]
    if not picked:
        return ""
    rel_paths = [f.relative_path for f in picked]
    try:
        read_rows = adapter.read_files(wid, rel_paths, max_bytes_per_file=4500)
    except Exception:
        return ""
    blocks: list[str] = [
        "## NGỮ CẢNH SOURCE CODE TỪ PROJECT ROOT ĐÃ BIND",
        f"workspaceId={wid} | root={session.root_path}",
        "Dùng phần này để tránh miss flow/validation/rule theo code thực tế.",
    ]
    total_chars = 0
    per_file = 2800
    budget = max(8_000, int(char_budget or 55_000))
    for row in read_rows:
        if row.error:
            continue
        text = (row.content or "").strip()
        if not text:
            continue
        clip = text[:per_file]
        if len(text) > per_file:
            clip += "\n...[truncated]"
        frag = f"### FILE: {row.relative_path}\n{clip}"
        if total_chars + len(frag) > budget:
            break
        blocks.append(frag)
        total_chars += len(frag)
    if len(blocks) <= 3:
        return ""
    blocks.append(
        "Bắt buộc: map test case theo hành vi thực tế trong code (API/validation/state transition), "
        "không chỉ dựa vào mô tả tổng quát."
    )
    return "\n\n".join(blocks)


def _resolve_fan_out_titles(
    content: str,
    *,
    snap: RequirementSnapshot | None,
    src: Source | None,
) -> list[str]:
    """Module titles for per-feature LLM fan-out."""
    from app.features.requirement_studio.snapshot_prompt import (
        module_titles_from_snapshot_payload,
        parse_json_field,
    )

    feats = enrich_features_with_files(
        parse_features(content), src.description if src else None
    )
    titles = [
        normalize_function_label(f.get("title") or "") or str(f.get("title") or "").strip()
        for f in feats
        if (f.get("title") or f.get("content"))
    ]
    titles = [t for t in titles if t]
    if len(titles) > 1:
        return titles

    if snap is not None:
        bundle = parse_json_field(snap.payload_json)
        from_knowledge = module_titles_from_snapshot_payload(bundle)
        if len(from_knowledge) > 1:
            return from_knowledge
    return titles


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
        job.progress_message = "Đang chuẩn bị ngữ cảnh (phân tích DB + source)…"
        db.commit()
        from app.services.job_progress import (
            clear_job_progress,
            clear_job_log,
            set_job_progress,
        )

        clear_job_log(job_id)
        set_job_progress(job_id, "--- Bắt đầu job sinh test case ---")
        set_job_progress(job_id, "Đang chuẩn bị ngữ cảnh (phân tích DB + source)…")

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
        analysis_ctx = ""
        topic_scope_text: str | None = None
        default_module: str | None = None
        scope_topic_notes: str | None = None
        raw_topic = extras.get("topicScope")
        if isinstance(raw_topic, dict) and raw_topic.get("title"):
            topic_scope_text = format_topic_scope_for_prompt(raw_topic)
            default_module = str(raw_topic.get("title") or "").strip() or None
            notes_raw = str(raw_topic.get("notes") or "").strip()
            scope_topic_notes = notes_raw or None

        engine_hint = extras.get("engineHint") if isinstance(extras.get("engineHint"), dict) else {}
        preferred_engine = str(engine_hint.get("preferredEngine") or "").strip().lower() or None
        if preferred_engine not in ("unit", "e2e"):
            preferred_engine = None
        target_url = str(engine_hint.get("targetUrl") or "").strip()
        auth_hint = str(engine_hint.get("authHint") or "").strip()
        focus_modules = str(engine_hint.get("focusModules") or "").strip()

        # Source scan: keep full for Unit; slightly tighter for E2E (UI journey needs less code dump)
        scan_files, scan_budget = (36, 55_000)
        if preferred_engine == "e2e":
            scan_files, scan_budget = (24, 36_000)
        elif preferred_engine == "unit":
            scan_files, scan_budget = (36, 55_000)
        source_scan_ctx = _source_scan_prompt_block(
            job.project_id,
            max_files=scan_files,
            module_hint=default_module or focus_modules or None,
            char_budget=scan_budget,
        )

        from app.features.requirement_studio.snapshot_prompt import (
            freeze_prompt_has_knowledge,
            is_freeze_snapshot_prompt,
        )

        freeze_mode = bool(snap) and is_freeze_snapshot_prompt(content)
        skip_analysis_dup = freeze_mode and freeze_prompt_has_knowledge(content)

        if snap and not skip_analysis_dup:
            analysis_ctx = _analysis_records_prompt_block(
                db,
                workspace_id=getattr(snap, "workspace_id", None),
                knowledge_version=int(getattr(snap, "knowledge_version", 0) or 0),
            )
            set_job_progress(
                job_id,
                f"[hệ thống] Đã nạp phân tích DB: {len(analysis_ctx):,} chars"
                + (f" (knowledge v{int(getattr(snap, 'knowledge_version', 0) or 0)})" if analysis_ctx else " — trống"),
            )
        elif skip_analysis_dup:
            set_job_progress(
                job_id,
                "[hệ thống] Bỏ qua analysis DB trùng — Knowledge đã có trong freeze snapshot (tiết kiệm token)",
            )
        set_job_progress(
            job_id,
            f"[hệ thống] Source scan: {len(source_scan_ctx):,} chars"
            + (" — có ngữ cảnh code" if source_scan_ctx else " — chưa gắn / không đọc được source"),
        )
        set_job_progress(
            job_id,
            f"[hệ thống] Snapshot/content: {len(content):,} chars | title={title[:80]}",
        )
        if snap and preferred_engine:
            from app.features.requirement_studio.snapshot_prompt import parse_json_field

            bundle = parse_json_field(snap.payload_json)
            issues = _engine_readiness_issues(bundle, preferred_engine)
            if issues:
                _fail_job(
                    db,
                    job_id,
                    "Snapshot chưa đủ dữ liệu để sinh "
                    + preferred_engine.upper()
                    + ": "
                    + "; ".join(issues),
                )
                return
            for w in _engine_readiness_warnings(bundle, preferred_engine):
                set_job_progress(job_id, f"[cảnh báo] {w}")
            if preferred_engine == "e2e" and not target_url:
                set_job_progress(
                    job_id,
                    "[cảnh báo] Chưa có Target URL — TC E2E vẫn sinh; "
                    "bổ sung URL vào precondition khi chạy code E2E sau.",
                )
        if focus_modules and not default_module:
            # Soft scope hint when FE did not send topicScope
            scope_topic_notes = (
                f"{scope_topic_notes}\nƯu tiên module: {focus_modules}".strip()
                if scope_topic_notes
                else f"Ưu tiên module: {focus_modules}"
            )
        # Dedup: FE context packet often overlaps workspace scan — keep scan; only
        # append packet when it is not already covered by the scan text.
        merged_parts: list[str] = []
        if analysis_ctx and analysis_ctx.strip():
            merged_parts.append(analysis_ctx.strip())
        if source_scan_ctx and source_scan_ctx.strip():
            merged_parts.append(source_scan_ctx.strip())
        if source_ctx and source_ctx.strip():
            packet = source_ctx.strip()
            scan = (source_scan_ctx or "").strip()
            probe = packet[: min(500, len(packet))]
            if scan and probe and probe in scan:
                set_job_progress(
                    job_id,
                    "[hệ thống] Bỏ qua context packet trùng source scan (tiết kiệm token)",
                )
            else:
                merged_parts.append(packet)
        merged_source_context = "\n\n".join(merged_parts) or None

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
            if preferred_engine:
                prior = [
                    t
                    for t in prior
                    if _tc_matches_preferred_engine(t.type, preferred_engine)
                ]
            existing_for_prompt = [(t.title, t.type) for t in prior]

        custom_rules = get_tc_generation_rules(preferred_engine=preferred_engine)
        engine_rules = (
            engine_generation_rules(
                preferred_engine,
                target_url=target_url,
                auth_hint=auth_hint,
                focus_modules=focus_modules,
            )
            if preferred_engine
            else ""
        )
        if engine_rules:
            custom_rules = f"{custom_rules}\n\n{engine_rules}".strip()
        feature_titles = _resolve_fan_out_titles(content, snap=snap, src=src)
        set_job_progress(
            job_id,
            f"[hệ thống] Engine={preferred_engine or 'auto'} | mode={mode} | "
            f"modules={len(feature_titles)}: {', '.join(feature_titles[:8]) or '(single call)'}"
            + (f" | focus={focus_modules}" if focus_modules else "")
            + (f" | existing_tc={len(existing_for_prompt)}" if existing_for_prompt else ""),
        )

        ctx = GenerateContext(
            mode=mode,
            content_version=doc_version,
            change_summary=change_summary,
            existing_cases=existing_for_prompt if mode == "append" else [],
            source_context=merged_source_context,
            topic_scope=topic_scope_text,
            scope_topic_notes=scope_topic_notes,
            requirement_description=src.description if src else None,
            custom_rules=custom_rules,
            feature_titles=[t for t in feature_titles if t],
            preferred_engine=preferred_engine,
        )

        drafts: list = []
        fan_errors: list[str] = []
        runner_meta: dict = {"runnerUsed": "API_DIRECT", "cliSessionKey": None}
        saved_total = [0]
        persist_lock = asyncio.Lock()
        used_fanout = False

        # Replace-mode wipe once before any progressive insert (Unit/E2E same)
        if mode == "replace" and (job.source_id or snap_id):
            deleted = _replace_draft_tcs(
                db,
                project_id=job.project_id,
                source_id=job.source_id,
                snap_id=snap_id,
                default_module=default_module,
                preferred_engine=preferred_engine,
            )
            if deleted:
                set_job_progress(
                    job_id,
                    f"[hệ thống] Replace: đã xóa {deleted} draft TC trong phạm vi",
                )

        existing_keys = _load_existing_tc_keys(
            db,
            project_id=job.project_id,
            mode=mode,
            source_id=job.source_id,
            snap_id=snap_id,
            snap=snap,
            default_module=default_module,
            preferred_engine=preferred_engine,
        )

        def _cli_progress(msg: str) -> None:
            set_job_progress(job_id, msg, persist=True)

        async def _persist_module_drafts(feat_title: str, part: list) -> int:
            if not part:
                return 0
            async with persist_lock:
                n = _persist_generated_drafts(
                    db,
                    project_id=job.project_id,
                    job_id=job.id,
                    source_id=job.source_id,
                    snap_id=snap_id,
                    drafts=part,
                    existing_keys=existing_keys,
                    default_module=default_module,
                    preferred_engine=preferred_engine,
                    doc_hash=doc_hash,
                    doc_version=doc_version,
                )
                saved_total[0] += n
                if n:
                    set_job_progress(
                        job_id,
                        f"[progressive] «{feat_title}» đã lưu +{n} TC · tổng đã lưu {saved_total[0]}",
                        persist=True,
                    )
                return n

        try:
            # Nhiều Feature → fan-out 1 LLM call / module.
            # Cursor CLI: oneshot độc lập / module (không --resume chung — resume từng thiếu TC).
            # CLI khác: song song + warm interactive session pool.
            titles_for_fan = [t for t in feature_titles if t]
            is_cursor = connection_is_cursor_cli(conn)
            if len(titles_for_fan) > 1 and not topic_scope_text:
                used_fanout = True
                total = len(titles_for_fan)
                if is_cursor:
                    # Parallel oneshot độc lập (không --resume chung). Default 2 ≈ ~½ wall time.
                    try:
                        concurrency = max(
                            1,
                            min(
                                2,
                                int(
                                    os.environ.get(
                                        "AITEST_TC_FANOUT_CONCURRENCY_CURSOR",
                                        "2",
                                    )
                                ),
                            ),
                        )
                    except ValueError:
                        concurrency = 2
                    # Budget đủ SRS/analysis (~6–15 TC/module); progressive persist vẫn giữ.
                    content_soft_max = 20_000
                    source_soft_max = 14_000
                    analysis_soft_max = 10_000
                else:
                    try:
                        concurrency = max(
                            1, min(4, int(os.environ.get("AITEST_TC_FANOUT_CONCURRENCY", "3")))
                        )
                    except ValueError:
                        concurrency = 3
                    content_soft_max = 20_000
                    source_soft_max = 14_000
                    analysis_soft_max = 10_000

                sem = asyncio.Semaphore(concurrency)
                warm_key = f"tc-job-{job_id}"
                warm_lock = asyncio.Lock()
                warm_ready = asyncio.Event()

                set_job_progress(
                    job_id,
                    f"Fan-out {total} module · concurrency={concurrency}"
                    + (" · cursor-oneshot" if is_cursor else " · warm-pool")
                    + " — bắt đầu…",
                )

                async def _gen_one(idx: int, feat_title: str):
                    async with sem:
                        set_job_progress(
                            job_id,
                            f"Module {idx}/{total}: {feat_title} — đang gọi AI CLI…",
                        )
                        scoped_content = _filter_text_for_module(
                            content, feat_title, soft_max=content_soft_max
                        )
                        # Prefer module-filtered source; fall back to analysis-only if empty
                        scoped_src = _filter_text_for_module(
                            merged_source_context or "",
                            feat_title,
                            soft_max=source_soft_max,
                        )
                        if not scoped_src.strip() and analysis_ctx:
                            scoped_src = _filter_text_for_module(
                                analysis_ctx, feat_title, soft_max=analysis_soft_max
                            )
                        set_job_progress(
                            job_id,
                            f"[hệ thống] Module «{feat_title}»: "
                            f"content_slice={len(scoped_content):,} chars | "
                            f"source_ctx={len(scoped_src):,} chars — build prompt…",
                        )
                        scoped = GenerateContext(
                            mode=mode,
                            content_version=doc_version,
                            change_summary=change_summary,
                            existing_cases=existing_for_prompt if mode == "append" else [],
                            source_context=scoped_src or None,
                            topic_scope=format_topic_scope_for_prompt(
                                {"title": feat_title, "notes": "", "items": []}
                            ),
                            scope_topic_notes=None,
                            requirement_description=src.description if src else None,
                            custom_rules=custom_rules,
                            feature_titles=[feat_title],
                            preferred_engine=preferred_engine,
                        )
                        try:
                            if is_cursor:
                                # Oneshot độc lập / module — đủ context, không resume chung
                                # (resume chung từng làm thiếu TC so với Phân tích).
                                part, meta = await generate_test_cases_for_connection(
                                    conn,
                                    title,
                                    scoped_content,
                                    scoped,
                                    api_key=api_key,
                                    on_progress=_cli_progress,
                                    prefer_oneshot=True,
                                    session_topic_key=f"{warm_key}-{idx}",
                                    create_chat=False,
                                )
                            else:
                                # First module(s): cold oneshot. After one success: warm interactive
                                prefer_oneshot = not warm_ready.is_set()

                                async def _call():
                                    return await generate_test_cases_for_connection(
                                        conn,
                                        title,
                                        scoped_content,
                                        scoped,
                                        api_key=api_key,
                                        on_progress=_cli_progress,
                                        prefer_oneshot=prefer_oneshot,
                                        session_topic_key=warm_key,
                                    )

                                if prefer_oneshot:
                                    part, meta = await _call()
                                else:
                                    async with warm_lock:
                                        part, meta = await _call()
                            for d in part:
                                if not d.module:
                                    d.module = feat_title
                            warm_ready.set()
                            await _persist_module_drafts(feat_title, part)
                            set_job_progress(
                                job_id,
                                f"Module {idx}/{total}: {feat_title} — xong (+{len(part)} TC)"
                                + (
                                    f" · tổng đã lưu {saved_total[0]}"
                                    if saved_total[0]
                                    else ""
                                ),
                            )
                            return idx, feat_title, part, meta, None
                        except Exception as exc:  # noqa: BLE001
                            set_job_progress(
                                job_id,
                                f"Module {idx}/{total}: {feat_title} — lỗi: {exc}",
                            )
                            return idx, feat_title, [], None, str(exc)

                # Cursor & other CLI: semaphore giới hạn concurrency; persist có lock.
                gathered = await asyncio.gather(
                    *[_gen_one(i, t) for i, t in enumerate(titles_for_fan, 1)]
                )
                for _idx, feat_title, part, meta, err in sorted(gathered, key=lambda r: r[0]):
                    if meta:
                        runner_meta = meta
                    if err:
                        fan_errors.append(f"{feat_title}: {err}")
                    drafts.extend(part)
                set_job_progress(
                    job_id,
                    f"Fan-out xong — {len(drafts)} TC từ {total} module"
                    + (f" · {len(fan_errors)} lỗi" if fan_errors else ""),
                )
                if not drafts:
                    _fail_job(
                        db,
                        job_id,
                        "Sinh TC thất bại mọi chức năng — "
                        + "; ".join(fan_errors[:5])
                        + ("…" if len(fan_errors) > 5 else ""),
                    )
                    clear_job_progress(job_id)
                    return
            else:
                set_job_progress(job_id, "Đang gọi AI CLI sinh test case…")
                drafts, runner_meta = await generate_test_cases_for_connection(
                    conn,
                    title,
                    content,
                    ctx,
                    api_key=api_key,
                    on_progress=_cli_progress,
                    prefer_oneshot=True if is_cursor else None,
                    create_chat=bool(is_cursor),
                )
        except Exception as exc:  # noqa: BLE001
            _fail_job(db, job_id, str(exc))
            clear_job_progress(job_id)
            return

        try:
            job.runner_used = runner_meta.get("runnerUsed")
            job.cli_session_key = runner_meta.get("cliSessionKey")
            db.commit()
        except Exception:
            db.rollback()
            job = db.query(Job).filter(Job.id == job_id).first()

        # Single-call path: persist once. Fan-out already persisted per module.
        if not used_fanout:
            n = _persist_generated_drafts(
                db,
                project_id=job.project_id,
                job_id=job.id,
                source_id=job.source_id,
                snap_id=snap_id,
                drafts=drafts,
                existing_keys=existing_keys,
                default_module=default_module,
                preferred_engine=preferred_engine,
                doc_hash=doc_hash,
                doc_version=doc_version,
            )
            saved_total[0] += n

        job.status = C.JOB_COMPLETED
        job.completed_at = datetime.now(timezone.utc)
        job.progress_message = (
            f"Hoàn tất — {len(drafts)} test case"
            + (f" · tổng đã lưu {saved_total[0]}" if saved_total[0] else "")
        )
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
        set_job_progress(
            job_id,
            f"Hoàn tất — {len(drafts)} test case · tổng đã lưu {saved_total[0]}",
            persist=True,
        )
        clear_job_progress(job_id)
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
