from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from app.llm.perf_timing import elapsed_ms, now_ms

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
from app.llm.base import GenerateContext, cursor_tc_hidden_chat_enabled
from app.services.ai_service import (
    RUNNER_AI_CLI,
    connection_is_cursor_cli,
    generate_test_cases_for_connection,
)
from app.services.unit_tc_gen_guard import filter_unit_tc_drafts
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
    stash_job_engine_hint,
    stash_job_topic_scope,
)
from app.services.job_pause import (
    clear_job_control,
    clear_pause_request,
    is_pause_requested,
    load_checkpoint,
    pending_modules_after_claim,
    remaining_modules,
    request_pause,
    save_checkpoint,
)
from app.services.vietnamese_labels import normalize_engine_type
from app.services.requirement_topics import (
    format_topic_scope_for_prompt,
    tc_matches_module_scope,
)
from app.services.testcase_dedup import dup_key

logger = logging.getLogger(__name__)

GenerateMode = Literal["append", "replace"]

router = APIRouter(prefix="/api", tags=["jobs"], dependencies=[Depends(get_current_user)])


def _uuid(value: str) -> uuid.UUID | None:
    try:
        return uuid.UUID(value)
    except (ValueError, TypeError):
        return None


def _fail_job(db: Session, job_id: uuid.UUID, msg: str) -> None:
    from app.services.job_progress import clear_job_progress, set_job_progress

    clear_job_control(job_id)
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
    When preferred_engine=unit: drop UI/wizard drafts; strip Class.Method from title.
    Returns number of rows inserted.
    """
    if not drafts:
        return 0
    work = list(drafts)
    if (preferred_engine or "").strip().lower() == "unit":
        work, dropped_n, sanitized_n = filter_unit_tc_drafts(work)
        if dropped_n or sanitized_n:
            logger.info(
                "Unit TC guard job=%s dropped=%s title_sanitized=%s kept=%s",
                job_id,
                dropped_n,
                sanitized_n,
                len(work),
            )
            try:
                from app.services.job_progress import set_job_progress

                set_job_progress(
                    job_id,
                    f"[unit-guard] loại {dropped_n} TC UI/wizard · gỡ Class.Method title={sanitized_n} · giữ {len(work)}",
                    persist=True,
                )
            except Exception:  # noqa: BLE001
                pass
    if not work:
        return 0
    count = db.query(TestCase).filter(TestCase.project_id == project_id).count()
    inserted = 0
    for d in work:
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
    features = knowledge.get("features") if isinstance(knowledge.get("features"), list) else []
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
        # Soft: FEATURES look UI-only (wizard/form/page) without BE verbs
        feat_blob = " ".join(
            str(
                (f.get("name") if isinstance(f, dict) else None)
                or (f.get("title") if isinstance(f, dict) else None)
                or f
            )
            for f in features
        ).lower()
        if features and re.search(
            r"form|popup|wizard|màn\s*hình|giao\s*diện|click|bước\s*\d+",
            feat_blob,
        ) and not re.search(
            r"handler|service|api|validation|rule|auth|quy\s*tắc|backend",
            feat_blob,
        ):
            warns.append(
                "FEATURES nghiêng UI/wizard — Unit chỉ cover logic BE; UI-only → E2E"
            )
    if preferred == "e2e":
        use_cases = (
            knowledge.get("useCases") if isinstance(knowledge.get("useCases"), list) else []
        )
        if not use_cases and not acceptance:
            warns.append(
                "Output Completeness: thiếu BUSINESS_FLOWS và ACCEPTANCE "
                "(E2E vẫn chạy — coverage journey/expected có thể mỏng)"
            )
        elif not use_cases:
            warns.append("thiếu BUSINESS_FLOWS / useCases (E2E vẫn chạy — thiếu xương sống journey)")
        if not actors:
            warns.append("thiếu actor/role (E2E vẫn chạy — precondition auth có thể chung)")
        if not validations:
            warns.append("thiếu validation UI (E2E vẫn chạy)")
        if not acceptance and use_cases:
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
    preferred_engine: str | None = None,
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
    eng = (preferred_engine or "").strip().lower()
    parts: list[str] = [
        "## KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB (NGUỒN CHÍNH ĐỂ SINH TEST CASE)",
        "Output Phân tích đã persist — bám itemCount>0; [] → bỏ (không invent). "
        + (
            "Unit UNIVERSAL BE: classify BE|FE|BE_FE|UNKNOWN (behavior+outcome). "
            "PRIMARY: BUSINESS_RULES · VALIDATION · ERROR_HANDLING · ACCEPTANCE (BE only). "
            "Categories A–I + coverage/trace → khối UNIT ← PHÂN TÍCH."
            if eng == "unit"
            else "Mọi TC truy vết ≥1 mục bên dưới."
        ),
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
    prefer_ui: bool = False,
    prefer_logic: bool = False,
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
    ui_hints = (
        "page",
        "pages",
        "component",
        "components",
        "route",
        "routes",
        "view",
        "views",
        "screen",
        "ui",
        "frontend",
        "web",
    )
    # Portable logic-layer stems (Unit) — no product nouns
    logic_bonus_stems = (
        "handler",
        "service",
        "usecase",
        "use-case",
        "validator",
        "command",
        "application",
        "domain",
    )
    logic_demote_stems = (
        "clientapp",
        "client-app",
        "/components/",
        "/pages/",
        "/views/",
        ".dto.",
        "/dto/",
    )

    def _ui_bonus(path_l: str) -> int:
        if not prefer_ui:
            return 0
        return sum(1 for h in ui_hints if h in path_l)

    def _logic_bonus(path_l: str) -> int:
        if not prefer_logic:
            return 0
        bonus = sum(2 for h in logic_bonus_stems if h in path_l)
        demote = sum(2 for h in logic_demote_stems if h in path_l)
        return bonus - demote

    if tokens or prefer_ui or prefer_logic:
        scored: list[tuple[int, object]] = []
        for f in candidates:
            path_l = (f.relative_path or "").lower().replace("\\", "/")
            score = (
                sum(1 for t in tokens if t in path_l)
                + _ui_bonus(path_l)
                + _logic_bonus(path_l)
            )
            scored.append((score, f))
        scored.sort(key=lambda x: (-x[0], x[1].relative_path or ""))
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
    if prefer_logic:
        blocks.append(
            "Bắt buộc (Unit): chỉ sinh reject/validate/persist khi excerpts có nhánh "
            "quan sát được (throw/guard/persist/query). "
            "BR/field chỉ attribute hoặc lớp trình bày — không sinh Unit (ghi gaps nếu cần)."
        )
    else:
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
    """Async worker — generate test cases from requirement source.

    Supports cooperative pause between fan-out modules: already-persisted TCs stay;
    resume continues only pending modules (append) — same prompts/rules, no wipe.
    """
    db = SessionLocal()
    t0 = now_ms()
    t_prep = now_ms()
    prepare_ms = 0
    llm_ms = 0
    persist_ms = 0
    prompt_chars = 0
    try:
        job = db.query(Job).filter(Job.id == job_id).first()
        if job is None:
            return
        checkpoint = load_checkpoint(job_id)
        is_resume = bool(
            checkpoint
            and isinstance(checkpoint.get("pendingModules"), list)
            and len(checkpoint.get("pendingModules") or []) > 0
        )
        mode: GenerateMode = (job.generate_strategy or "append")  # type: ignore[assignment]
        if is_resume:
            # Continuation must not wipe drafts; always append onto saved TCs.
            mode = "append"
        job.status = C.JOB_RUNNING
        if job.started_at is None:
            job.started_at = datetime.now(timezone.utc)
        job.completed_at = None
        job.error = None
        job.progress_message = (
            "Tiếp tục sinh TC (bổ sung module còn lại)…"
            if is_resume
            else "Đang chuẩn bị ngữ cảnh (phân tích DB + source)…"
        )
        db.commit()
        from app.services.job_progress import (
            clear_job_progress,
            clear_job_log,
            set_job_progress,
        )

        clear_pause_request(job_id)
        if not is_resume:
            clear_job_log(job_id)
            set_job_progress(job_id, "--- Bắt đầu job sinh test case ---")
            set_job_progress(
                job_id,
                "Đang chuẩn bị ngữ cảnh (phân tích DB + source)…",
            )
        else:
            set_job_progress(
                job_id,
                f"--- Tiếp tục job (còn {len(checkpoint.get('pendingModules') or [])} module) "
                f"— không chạy lại module đã xong ---",
            )
            set_job_progress(
                job_id,
                "Đang nạp lại ngữ cảnh để sinh bổ sung module còn lại…",
            )

        conn = (
            db.query(AiBackendConnection)
            .filter(AiBackendConnection.project_id == job.project_id)
            .first()
        )
        if conn is None:
            _fail_job(db, job_id, "connection not found")
            return
        # AI CLI only — no API key required
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
            content = snapshot_prompt_content(snap, slim_for_tc_gen=True)
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
        if is_resume and checkpoint:
            # Restore engine hint / topic if FE resume re-stashed or checkpoint has them
            if not extras.get("engineHint") and isinstance(checkpoint.get("engineHint"), dict):
                extras["engineHint"] = checkpoint["engineHint"]
            if not extras.get("topicScope") and isinstance(checkpoint.get("topicScope"), dict):
                extras["topicScope"] = checkpoint["topicScope"]
            if not extras.get("context") and isinstance(checkpoint.get("context"), str):
                extras["context"] = checkpoint["context"]
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

        from app.llm.tc_speed import (
            knowledge_enough_skip_source_scan,
            resolve_fanout_batch_size,
            resolve_max_tc_per_module,
            resolve_tc_speed_mode,
        )

        speed_mode = resolve_tc_speed_mode(preferred_engine, engine_hint)
        max_tc_per_module = resolve_max_tc_per_module(
            preferred_engine, speed_mode, engine_hint
        )
        # Keep resolved speed on hint for checkpoint / resume
        engine_hint = {
            **engine_hint,
            "speed": speed_mode,
            "maxPerModule": max_tc_per_module,
        }

        # Source scan: tighter budgets (token/speed). Prefer UI paths for E2E.
        # Skip entirely for E2E when freeze Knowledge already has enough UI/AC signals.
        skip_source_scan = False
        snap_bundle_early = None
        if snap is not None:
            from app.features.requirement_studio.snapshot_prompt import parse_json_field

            snap_bundle_early = parse_json_field(snap.payload_json)
            skip_source_scan = knowledge_enough_skip_source_scan(
                snap_bundle_early, preferred_engine
            )

        scan_files, scan_budget = (24, 28_000)
        if preferred_engine == "e2e":
            scan_files, scan_budget = (16, 18_000)
        elif preferred_engine == "unit":
            scan_files, scan_budget = (24, 28_000)

        if skip_source_scan:
            source_scan_ctx = ""
            eng_label = (preferred_engine or "").upper() or "TC"
            if preferred_engine == "e2e":
                force_env = "AITEST_TC_E2E_FORCE_SOURCE_SCAN"
                set_job_progress(
                    job_id,
                    f"[hệ thống] Bỏ qua source scan ({eng_label}) — Knowledge freeze đủ feature/rule "
                    f"({force_env}=1 để ép scan)",
                )
            else:
                set_job_progress(
                    job_id,
                    f"[hệ thống] Bỏ qua source scan ({eng_label}) — "
                    "AITEST_TC_UNIT_SKIP_SOURCE_SCAN=1",
                )
        else:
            # File scan can read dozens of files — keep event loop free for parallel fan-out.
            source_scan_ctx = await asyncio.to_thread(
                _source_scan_prompt_block,
                job.project_id,
                max_files=scan_files,
                module_hint=default_module or focus_modules or None,
                char_budget=scan_budget,
                prefer_ui=preferred_engine == "e2e",
                prefer_logic=preferred_engine == "unit",
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
                preferred_engine=preferred_engine,
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

            bundle = snap_bundle_early if snap_bundle_early is not None else parse_json_field(snap.payload_json)
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

        custom_rules = get_tc_generation_rules(
            preferred_engine=preferred_engine,
            speed=speed_mode,
        )
        engine_rules = (
            engine_generation_rules(
                preferred_engine,
                target_url=target_url,
                auth_hint=auth_hint,
                focus_modules=focus_modules,
                speed=speed_mode,
                max_per_module=max_tc_per_module,
            )
            if preferred_engine
            else ""
        )
        if engine_rules:
            # Unit/E2E: analysis SoT is prepended inside engine_rules — put engine first
            # so truncate(eng_cap) never drops the map/trace/completeness contract.
            if preferred_engine in ("unit", "e2e"):
                custom_rules = f"{engine_rules}\n\n{custom_rules}".strip()
            else:
                custom_rules = f"{custom_rules}\n\n{engine_rules}".strip()

        from app.llm.ai_rules import parse_project_meta, rules_pair_from_meta

        proj_row = (
            db.query(Project)
            .filter(Project.id == job.project_id, Project.deleted_at.is_(None))
            .first()
        )
        proj_meta = parse_project_meta(getattr(proj_row, "meta", None) if proj_row else None)
        project_rules, user_rules = rules_pair_from_meta(
            proj_meta,
            language=getattr(proj_row, "language", None) if proj_row else None,
        )

        feature_titles = _resolve_fan_out_titles(content, snap=snap, src=src)
        # topicScope: hẹp danh sách module trước khi quyết định fan-out (tránh 1 call full SRS).
        if (
            not is_resume
            and topic_scope_text
            and default_module
            and len(feature_titles) > 1
        ):
            dm = default_module.strip().lower()
            matched = [
                t
                for t in feature_titles
                if dm in t.lower() or t.lower() in dm
            ]
            if matched:
                feature_titles = matched
                set_job_progress(
                    job_id,
                    f"[hệ thống] topicScope «{default_module}» → "
                    f"{len(feature_titles)} module khớp "
                    f"({', '.join(feature_titles[:6])}{'…' if len(feature_titles) > 6 else ''})",
                )
            else:
                set_job_progress(
                    job_id,
                    f"[hệ thống] topicScope «{default_module}» không khớp title — "
                    f"fan-out toàn bộ {len(feature_titles)} module",
                )
        if is_resume and checkpoint:
            pending = [
                str(t).strip()
                for t in (checkpoint.get("pendingModules") or [])
                if str(t).strip()
            ]
            already_done = {
                str(t).strip()
                for t in (checkpoint.get("doneModules") or [])
                if str(t).strip()
            }
            # Never re-run modules marked done in the pause checkpoint.
            pending = [t for t in pending if t not in already_done]
            if pending:
                feature_titles = pending
                set_job_progress(
                    job_id,
                    f"[hệ thống] Resume: chỉ sinh bổ sung {len(pending)} module còn lại "
                    f"({', '.join(pending[:6])}{'…' if len(pending) > 6 else ''}) "
                    f"— đã xong {len(already_done)} module, TC đã lưu giữ nguyên",
                )
            else:
                set_job_progress(
                    job_id,
                    "[hệ thống] Resume: không còn module pending — hoàn tất.",
                )
                job.status = C.JOB_COMPLETED
                job.completed_at = datetime.now(timezone.utc)
                job.progress_message = "Không còn module chờ sinh (đã đủ)."
                db.commit()
                clear_job_control(job_id)
                clear_job_progress(job_id)
                return
        set_job_progress(
            job_id,
            f"[hệ thống] Engine={preferred_engine or 'auto'} | speed={speed_mode}"
            + (f" | max/module={max_tc_per_module}" if max_tc_per_module else "")
            + f" | mode={mode} | "
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
            project_rules=project_rules or None,
            user_rules=user_rules or None,
            feature_titles=[t for t in feature_titles if t],
            preferred_engine=preferred_engine,
            speed_mode=speed_mode,
            max_tc_per_module=max_tc_per_module,
        )

        prepare_ms = elapsed_ms(t_prep)
        prompt_chars = (
            len(content)
            + len(merged_source_context or "")
            + len(custom_rules or "")
        )
        set_job_progress(
            job_id,
            f"[timing] prepare_ms={prepare_ms} prompt_chars={prompt_chars:,} "
            f"modules={len(feature_titles)} provider_prep=ok",
        )
        drafts: list = []
        fan_errors: list[str] = []
        runner_meta: dict = {"runnerUsed": RUNNER_AI_CLI, "cliSessionKey": None}
        saved_total = [
            int(checkpoint.get("savedCount") or 0) if is_resume and checkpoint else 0
        ]
        persist_lock = asyncio.Lock()
        used_fanout = False

        # Replace-mode wipe once before any progressive insert (Unit/E2E same).
        # Never wipe on resume — keep TC đã lưu khi tạm dừng.
        if mode == "replace" and not is_resume and (job.source_id or snap_id):
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

        t_llm = now_ms()
        try:
            # Nhiều Feature → fan-out (batch 2–3 modules/call khi cấu hình).
            # Cursor: per-module create-chat + 2-turn (seed→gen); không resume chung job.
            # CLI khác: song song + warm interactive session pool.
            titles_for_fan = [t for t in feature_titles if t]
            is_cursor = connection_is_cursor_cli(conn)
            cursor_hidden = bool(is_cursor and cursor_tc_hidden_chat_enabled())
            # Fan-out when many modules. topicScope no longer blocks fan-out when
            # multiple modules remain after filter (see above). Resume always fans out.
            if len(titles_for_fan) > 1:
                used_fanout = True
                total = len(titles_for_fan)
                # Absolute progress: prior done modules + current batch
                prior_done = (
                    list(checkpoint.get("doneModules") or [])
                    if is_resume and checkpoint
                    else []
                )
                all_modules = (
                    list(checkpoint.get("allModules") or [])
                    if is_resume and checkpoint and checkpoint.get("allModules")
                    else (prior_done + titles_for_fan)
                )
                # Dedupe preserve order
                _seen_all: set[str] = set()
                all_modules_ordered: list[str] = []
                for _t in all_modules:
                    if _t and _t not in _seen_all:
                        _seen_all.add(_t)
                        all_modules_ordered.append(_t)
                all_modules = all_modules_ordered
                global_total = max(len(all_modules), total + len(prior_done))
                done_offset = len(prior_done)
                if is_cursor:
                    # Parallel per-module (hidden 2-turn hoặc oneshot). Default concurrency 4.
                    try:
                        concurrency = max(
                            1,
                            min(
                                4,
                                int(
                                    os.environ.get(
                                        "AITEST_TC_FANOUT_CONCURRENCY_CURSOR",
                                        "4",
                                    )
                                ),
                            ),
                        )
                    except ValueError:
                        concurrency = 4
                    # Slimmer per-module budgets (module-scoped freeze slice)
                    content_soft_max = 12_000
                    source_soft_max = 8_000 if preferred_engine != "e2e" else 6_000
                    analysis_soft_max = 6_000
                else:
                    try:
                        concurrency = max(
                            1, min(4, int(os.environ.get("AITEST_TC_FANOUT_CONCURRENCY", "3")))
                        )
                    except ValueError:
                        concurrency = 3
                    content_soft_max = 12_000
                    source_soft_max = 8_000 if preferred_engine != "e2e" else 6_000
                    analysis_soft_max = 6_000

                from app.features.requirement_studio.snapshot_prompt import (
                    parse_json_field,
                    slice_freeze_content_for_module,
                )

                snap_bundle = parse_json_field(snap.payload_json) if snap else None
                snap_title = (snap.title if snap else None) or title
                snap_summary = getattr(snap, "summary", None) if snap else None
                snap_kv = int(getattr(snap, "knowledge_version", 0) or 0) if snap else 0

                sem = asyncio.Semaphore(concurrency)
                warm_key = f"tc-job-{job_id}"
                batch_size = resolve_fanout_batch_size(is_cursor=is_cursor)

                if is_cursor:
                    cursor_mode_label = (
                        "cursor-hidden-chat (2-turn/batch, chậm hơn — bật AITEST_TC_CURSOR_HIDDEN_CHAT=1)"
                        if cursor_hidden
                        else "cursor-oneshot (batch modules/call — nhanh)"
                    )
                else:
                    cursor_mode_label = "oneshot-parallel (batched modules/call)"
                set_job_progress(
                    job_id,
                    (
                        f"Tiếp tục fan-out {total} module còn lại"
                        f" (đã xong {done_offset}/{global_total})"
                        if is_resume and done_offset
                        else f"Fan-out {total} module"
                    )
                    + f" · concurrency={concurrency}"
                    + f" · batch={batch_size}"
                    + f" · speed={speed_mode}"
                    + f" · {cursor_mode_label}"
                    + " — bắt đầu…",
                )

                # Claim-index pool (not gather-all): pause stops claiming new modules.
                # In-flight modules finish + persist; unclaimed titles become pendingModules.
                claim_lock = asyncio.Lock()
                next_claim = [0]
                done_mods: list[str] = []
                done_lock = asyncio.Lock()

                async def _run_claimed(idx: int, feat_titles: list[str]):
                    nonlocal runner_meta
                    label = ", ".join(feat_titles)
                    abs_idx = done_offset + idx
                    set_job_progress(
                        job_id,
                        f"Batch {abs_idx}/{global_total}: {label} — đang gọi AI CLI…",
                    )
                    per_budget = max(
                        6_000,
                        min(
                            content_soft_max,
                            (min(20_000, content_soft_max + 4_000 * (len(feat_titles) - 1)))
                            // max(1, len(feat_titles)),
                        ),
                    )
                    slices: list[str] = []
                    for feat_title in feat_titles:
                        scoped_one = slice_freeze_content_for_module(
                            content,
                            feat_title,
                            soft_max=per_budget,
                            snap_payload=snap_bundle,
                            title=snap_title,
                            summary=snap_summary,
                            knowledge_version=snap_kv,
                        )
                        if not scoped_one.strip():
                            scoped_one = _filter_text_for_module(
                                content, feat_title, soft_max=per_budget
                            )
                        if scoped_one.strip():
                            slices.append(scoped_one.strip())
                    scoped_content = "\n\n---\n\n".join(slices)
                    batch_soft = min(20_000, content_soft_max + 4_000 * (len(feat_titles) - 1))
                    if len(scoped_content) > batch_soft:
                        scoped_content = scoped_content[: batch_soft - 20] + "\n...[truncated]"
                    src_budget = min(
                        source_soft_max + 2_000 * (len(feat_titles) - 1),
                        12_000,
                    )
                    scoped_src = _filter_text_for_module(
                        merged_source_context or "",
                        " ".join(feat_titles),
                        soft_max=src_budget,
                    )
                    if not scoped_src.strip() and analysis_ctx:
                        scoped_src = _filter_text_for_module(
                            analysis_ctx,
                            " ".join(feat_titles),
                            soft_max=analysis_soft_max,
                        )
                    set_job_progress(
                        job_id,
                        f"[hệ thống] Batch «{label}»: "
                        f"content_slice={len(scoped_content):,} chars | "
                        f"source_ctx={len(scoped_src):,} chars — build prompt…",
                    )
                    scoped = GenerateContext(
                        mode=mode,
                        content_version=doc_version,
                        change_summary=change_summary,
                        existing_cases=existing_for_prompt if mode == "append" else [],
                        source_context=scoped_src or None,
                        topic_scope=(
                            "Sinh TC cho đúng các module sau "
                            "(mỗi TC.module = đúng một tên trong danh sách):\n"
                            + "\n".join(f"- {t}" for t in feat_titles)
                            + "\nKhông sinh TC ngoài danh sách này. "
                            "Cover đủ tín hiệu Knowledge của từng module."
                        ),
                        scope_topic_notes=None,
                        requirement_description=src.description if src else None,
                        custom_rules=custom_rules,
                        project_rules=project_rules or None,
                        user_rules=user_rules or None,
                        feature_titles=list(feat_titles),
                        preferred_engine=preferred_engine,
                        speed_mode=speed_mode,
                        max_tc_per_module=max_tc_per_module,
                    )
                    try:
                        part, meta = await generate_test_cases_for_connection(
                            conn,
                            title,
                            scoped_content,
                            scoped,
                            api_key=api_key,
                            on_progress=_cli_progress,
                            prefer_oneshot=True,
                            session_topic_key=f"{warm_key}-{idx}",
                            create_chat=cursor_hidden if is_cursor else False,
                        )
                        title_map = {t.lower(): t for t in feat_titles}
                        for d in part:
                            if not d.module:
                                d.module = feat_titles[0]
                            else:
                                key = str(d.module).strip().lower()
                                if key in title_map:
                                    d.module = title_map[key]
                        await _persist_module_drafts(label, part)
                        set_job_progress(
                            job_id,
                            f"Batch {abs_idx}/{global_total}: {label} — xong (+{len(part)} TC)"
                            + (
                                f" · tổng đã lưu {saved_total[0]}"
                                if saved_total[0]
                                else ""
                            ),
                        )
                        async with done_lock:
                            done_mods.extend(feat_titles)
                            drafts.extend(part)
                            if meta:
                                runner_meta = meta
                    except Exception as exc:  # noqa: BLE001
                        set_job_progress(
                            job_id,
                            f"Batch {abs_idx}/{global_total}: {label} — lỗi: {exc}",
                        )
                        async with done_lock:
                            done_mods.extend(feat_titles)
                            fan_errors.append(f"{label}: {exc}")

                async def _claim_next() -> tuple[int, list[str]] | None:
                    async with claim_lock:
                        if is_pause_requested(job_id):
                            return None
                        i = next_claim[0]
                        if i >= total:
                            return None
                        end = min(i + batch_size, total)
                        batch = titles_for_fan[i:end]
                        next_claim[0] = end
                        return i + 1, batch

                async def _worker():
                    while True:
                        if is_pause_requested(job_id):
                            return
                        async with sem:
                            if is_pause_requested(job_id):
                                return
                            claimed = await _claim_next()
                            if claimed is None:
                                return
                            idx, feat_titles = claimed
                            await _run_claimed(idx, feat_titles)

                await asyncio.gather(
                    *[_worker() for _ in range(min(concurrency, total))]
                )

                # Modules never claimed stay pending for resume (never re-queue done).
                paused_mods = pending_modules_after_claim(
                    titles_for_fan, next_claim[0], done=done_mods
                )
                prior_done_set = set(prior_done)
                paused_mods = [t for t in paused_mods if t not in prior_done_set]

                if paused_mods or is_pause_requested(job_id):
                    merged_done = list(prior_done)
                    for t in done_mods:
                        if t and t not in merged_done:
                            merged_done.append(t)
                    save_checkpoint(
                        job_id,
                        {
                            "pendingModules": paused_mods,
                            "doneModules": merged_done,
                            "allModules": all_modules
                            if all_modules
                            else (merged_done + list(paused_mods)),
                            "engineHint": engine_hint if isinstance(engine_hint, dict) else {},
                            "preferredEngine": preferred_engine,
                            "savedCount": saved_total[0],
                            "mode": mode,
                            "topicScope": raw_topic if isinstance(raw_topic, dict) else None,
                            "context": source_ctx,
                        },
                    )
                    if paused_mods:
                        job = db.query(Job).filter(Job.id == job_id).first()
                        if job:
                            job.status = C.JOB_PAUSED
                            job.completed_at = None
                            job.error = None
                            db.commit()
                        set_job_progress(
                            job_id,
                            f"Tạm dừng — đã lưu {saved_total[0]} TC · còn {len(paused_mods)} module "
                            f"({', '.join(paused_mods[:6])}{'…' if len(paused_mods) > 6 else ''}). "
                            "Bấm Tiếp tục để sinh bổ sung (không chạy lại từ đầu).",
                            persist=True,
                        )
                        clear_job_progress(job_id)
                        return
                    # pause requested but nothing left pending → fall through to complete

                set_job_progress(
                    job_id,
                    f"Fan-out xong — {len(drafts)} TC từ {total} module"
                    + (f" · {len(fan_errors)} lỗi" if fan_errors else ""),
                )
                if not drafts and not saved_total[0]:
                    _fail_job(
                        db,
                        job_id,
                        "Sinh TC thất bại mọi chức năng — "
                        + "; ".join(fan_errors[:5])
                        + ("…" if len(fan_errors) > 5 else ""),
                    )
                    clear_job_control(job_id)
                    clear_job_progress(job_id)
                    return
            else:
                if is_pause_requested(job_id):
                    save_checkpoint(
                        job_id,
                        {
                            "pendingModules": [t for t in feature_titles if t]
                            or ["(all)"],
                            "doneModules": list(
                                checkpoint.get("doneModules") or [] if checkpoint else []
                            ),
                            "engineHint": engine_hint if isinstance(engine_hint, dict) else {},
                            "preferredEngine": preferred_engine,
                            "savedCount": saved_total[0],
                            "mode": mode,
                            "topicScope": raw_topic if isinstance(raw_topic, dict) else None,
                            "context": source_ctx,
                        },
                    )
                    job = db.query(Job).filter(Job.id == job_id).first()
                    if job:
                        job.status = C.JOB_PAUSED
                        job.completed_at = None
                        job.error = None
                        db.commit()
                    set_job_progress(
                        job_id,
                        f"Tạm dừng trước khi gọi AI — đã lưu {saved_total[0]} TC. "
                        "Bấm Tiếp tục để sinh bổ sung.",
                        persist=True,
                    )
                    clear_job_progress(job_id)
                    return
                if is_cursor and cursor_hidden:
                    set_job_progress(
                        job_id,
                        "Đang gọi AI CLI sinh test case (cursor-hidden-chat, 2-turn)…",
                    )
                elif is_cursor:
                    set_job_progress(
                        job_id,
                        "Đang gọi AI CLI sinh test case (cursor-oneshot, 1 lần gọi)…",
                    )
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
                    create_chat=cursor_hidden,
                )
        except Exception as exc:  # noqa: BLE001
            _fail_job(db, job_id, str(exc))
            clear_job_progress(job_id)
            return
        llm_ms = elapsed_ms(t_llm)

        try:
            job.runner_used = runner_meta.get("runnerUsed")
            job.cli_session_key = runner_meta.get("cliSessionKey")
            db.commit()
        except Exception:
            db.rollback()
            job = db.query(Job).filter(Job.id == job_id).first()

        # Single-call path: persist once. Fan-out already persisted per module.
        t_persist = now_ms()
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
        persist_ms = elapsed_ms(t_persist)
        total_ms = elapsed_ms(t0)
        provider = str(runner_meta.get("runnerUsed") or "unknown")
        logger.info(
            "TC gen timing job=%s prepare_ms=%s llm_ms=%s persist_ms=%s "
            "prompt_chars=%s modules=%s provider=%s total_ms=%s fanout=%s",
            job_id,
            prepare_ms,
            llm_ms,
            persist_ms,
            prompt_chars,
            len(feature_titles),
            provider,
            total_ms,
            used_fanout,
        )
        set_job_progress(
            job_id,
            f"[timing] prepare_ms={prepare_ms} llm_ms={llm_ms} persist_ms={persist_ms} "
            f"prompt_chars={prompt_chars:,} modules={len(feature_titles)} "
            f"provider={provider} total_ms={total_ms}",
            persist=True,
        )

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
        clear_job_control(job_id)
        clear_job_progress(job_id)
    except Exception as exc:  # noqa: BLE001
        db.rollback()
        clear_job_control(job_id)
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
            400, "AI chưa Ready — vào Settings cấu hình AI CLI và Verify"
        )

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


@router.post("/jobs/{job_id}/pause")
def pause_generate_job(job_id: str, db: Annotated[Session, Depends(get_db)]):
    """
    Cooperative pause: modules đang chạy vẫn hoàn tất + lưu TC;
    module chưa bắt đầu sẽ chờ resume (không regenerate từ đầu).
    """
    from app.services.job_progress import set_job_progress

    jid = _uuid(job_id)
    if jid is None:
        return errors(400, "invalid id")
    job = db.query(Job).filter(Job.id == jid).first()
    if job is None:
        return errors(404, "not found")
    if job.status != C.JOB_RUNNING:
        return errors(400, f"Chỉ tạm dừng khi job Running (hiện tại: {job.status})")
    request_pause(jid)
    set_job_progress(
        jid,
        "Đã yêu cầu tạm dừng — đợi module đang chạy xong, giữ TC đã lưu…",
        persist=True,
    )
    db.refresh(job)
    return ok(job_dto(job))


@router.post("/jobs/{job_id}/resume")
async def resume_generate_job(job_id: str, db: Annotated[Session, Depends(get_db)]):
    """
    Tiếp tục job Paused: chỉ sinh bổ sung module còn lại (append).
    Không xóa TC đã gen; cùng engine/rules — không ảnh hưởng chất lượng output.
    """
    from app.services.job_progress import set_job_progress

    jid = _uuid(job_id)
    if jid is None:
        return errors(400, "invalid id")
    job = db.query(Job).filter(Job.id == jid).first()
    if job is None:
        return errors(404, "not found")
    if job.status != C.JOB_PAUSED:
        return errors(400, f"Chỉ tiếp tục khi job Paused (hiện tại: {job.status})")
    cp = load_checkpoint(jid)
    pending = [
        str(t).strip()
        for t in ((cp or {}).get("pendingModules") or [])
        if str(t).strip()
    ]
    if not pending:
        return errors(
            400,
            "Không còn module chờ sinh (checkpoint trống — có thể API đã restart). "
            "Hãy tạo job mới ở chế độ append để bổ sung.",
        )
    # Re-stash extras so process_generate_job nhận engineHint / context
    hint = (cp or {}).get("engineHint")
    if isinstance(hint, dict) and hint:
        stash_job_engine_hint(jid, hint)
    topic = (cp or {}).get("topicScope")
    if isinstance(topic, dict) and topic.get("title"):
        stash_job_topic_scope(jid, topic)
    ctx = (cp or {}).get("context")
    if isinstance(ctx, str) and ctx.strip():
        from app.services.job_context_stash import stash_job_context

        stash_job_context(jid, ctx)

    clear_pause_request(jid)
    # Keep checkpoint on disk/memory until process_generate_job finishes pending
    # (do not pop here — resume worker loads it).
    job.status = C.JOB_QUEUED
    job.completed_at = None
    job.error = None
    job.progress_message = (
        f"Đã xếp hàng tiếp tục — còn {len(pending)} module "
        f"({', '.join(pending[:4])}{'…' if len(pending) > 4 else ''})"
    )
    db.commit()
    db.refresh(job)
    set_job_progress(jid, job.progress_message or "Tiếp tục…", persist=True)
    asyncio.create_task(process_generate_job(jid))
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
