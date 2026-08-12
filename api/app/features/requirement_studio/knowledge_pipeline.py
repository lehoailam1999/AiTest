"""Requirement Studio — Phan tich pipeline (heuristic + oneshot enrich)."""

from __future__ import annotations

import asyncio
import json
import logging
import os
import uuid
from datetime import datetime, timezone
from typing import Any

from sqlalchemy import select
from sqlalchemy.orm import Session

from app import constants as C
from app.features.requirement_studio.analysis_records import replace_analysis_records
from app.features.requirement_studio.coverage_analyzer import analyze_requirement_coverage
from app.features.requirement_studio.dto import knowledge_dto
from app.features.requirement_studio.enrich_cache import (
    get_enrich_payload_cache,
    set_enrich_payload_cache,
)
from app.features.requirement_studio.knowledge_builder import (
    build_enrich_oneshot_prompt,
    build_knowledge_heuristic,
    chunks_input_hash,
    knowledge_enrich_oneshot_system_prompt,
    merge_knowledge_payloads,
    normalize_knowledge_payload,
    parse_knowledge_llm_json,
)
from app.features.requirement_studio.snapshot_prompt import parse_json_field
from app.llm.perf_timing import elapsed_ms, now_ms, timing_dict
from app.models.domain import (
    AiBackendConnection,
    KnowledgeWorkspace,
    RequirementFile,
    RequirementWorkspace,
)

logger = logging.getLogger(__name__)


def _alive(model):
    return model.deleted_at.is_(None)

# In-memory enrich progress (no migration). Key = workspace_id str.
_enrich_state: dict[str, dict[str, Any]] = {}


def get_enrich_state(workspace_id: uuid.UUID | str) -> dict[str, Any]:
    row = _enrich_state.get(str(workspace_id)) or {}
    return {
        "enrichPending": bool(row.get("enrichPending")),
        "enrichError": row.get("enrichError"),
        "timing": row.get("timing") if isinstance(row.get("timing"), dict) else None,
        "cacheHit": bool(row.get("cacheHit")),
    }


def set_enrich_state(
    workspace_id: uuid.UUID | str,
    *,
    enrich_pending: bool,
    enrich_error: str | None = None,
    timing: dict[str, Any] | None = None,
    cache_hit: bool | None = None,
) -> None:
    key = str(workspace_id)
    prev = _enrich_state.get(key) or {}
    _enrich_state[key] = {
        "enrichPending": enrich_pending,
        "enrichError": enrich_error,
        "timing": timing if timing is not None else prev.get("timing"),
        "cacheHit": bool(cache_hit) if cache_hit is not None else bool(prev.get("cacheHit")),
    }


def clear_enrich_state(workspace_id: uuid.UUID | str) -> None:
    _enrich_state.pop(str(workspace_id), None)


def knowledge_enrich_timeout_sec() -> float:
    """Oneshot enrich wall-clock budget — default matches Cursor CLI (360s)."""
    override = (os.environ.get("AITEST_KNOWLEDGE_ENRICH_TIMEOUT_SEC") or "").strip()
    if override:
        try:
            return max(45.0, float(override))
        except ValueError:
            pass
    try:
        cursor_t = int(os.environ.get("AITEST_CURSOR_ONESHOT_TIMEOUT", "360"))
    except ValueError:
        cursor_t = 360
    return float(max(60, min(600, cursor_t)))

def load_chunk_pairs(
    db: Session, workspace_id: uuid.UUID
) -> tuple[list[tuple[str | None, str]], list[str], int, int]:
    """Load SRS text for Knowledge build/enrich from RequirementFile.extracted_text.

    Expands each file into section-level (heading, body) pairs via document_model
    (heading / table / entity / prose index). Returns
    (pairs, file_names, file_count, section_count).
    """
    from app.features.requirement_studio.document_model import build_chunk_pairs_from_files

    files = db.scalars(
        select(RequirementFile).where(
            RequirementFile.workspace_id == workspace_id,
            _alive(RequirementFile),
            RequirementFile.parse_status == "ready",
        )
    ).all()
    file_names = [f.file_name for f in files]
    file_texts: list[tuple[str, str]] = []
    for f in files:
        text = (f.extracted_text or "").strip()
        if text:
            file_texts.append((f.file_name, text))
    pairs = build_chunk_pairs_from_files(file_texts)
    return pairs, file_names, len(files), len(pairs)


def persist_knowledge_payload(
    db: Session,
    row: KnowledgeWorkspace,
    workspace: RequirementWorkspace,
    payload: dict,
    *,
    builder: str,
    file_count: int,
    chunk_count: int,
    bump_version: bool = True,
    enrich_input_hash: str | None = None,
    enrich_timing: dict | None = None,
) -> None:
    payload = normalize_knowledge_payload(payload)
    row.payload_json = json.dumps(payload, ensure_ascii=False)
    row.summary = (payload.get("summary") or "")[:4000] or None
    row.builder = builder
    row.status = "ready"
    if bump_version:
        row.version = int(row.version or 0) + 1
    row.source_file_count = file_count
    row.source_chunk_count = chunk_count
    row.error = None
    row.built_at = datetime.now(timezone.utc)
    pairs_text = []
    try:
        pairs, _, _, _ = load_chunk_pairs(db, workspace.id)
        pairs_text = [t for _, t in pairs]
    except Exception:
        pairs_text = []
    coverage = analyze_requirement_coverage(payload, chunk_texts=pairs_text)
    if enrich_input_hash or enrich_timing:
        perf = dict(coverage.get("perf") or {}) if isinstance(coverage, dict) else {}
        if enrich_input_hash:
            perf["enrichInputHash"] = enrich_input_hash
        if enrich_timing:
            perf["timing"] = enrich_timing
        if isinstance(coverage, dict):
            coverage["perf"] = perf
    row.coverage_json = json.dumps(coverage, ensure_ascii=False)
    replace_analysis_records(
        db,
        workspace_id=workspace.id,
        project_id=workspace.project_id,
        knowledge_id=row.id,
        knowledge_version=row.version,
        payload=payload,
    )


async def enrich_knowledge_background(
    workspace_id: uuid.UUID,
    project_id: uuid.UUID,
    *,
    expected_version: int,
) -> None:
    """Background LLM enrich after heuristic ready. Own DB session.

    Single oneshot CLI call — merge onto heuristic; prefer richer useCases on collision.
    """
    from app.database import SessionLocal
    from app.services.ai_service import RUNNER_AI_CLI, chat_for_connection

    t0 = now_ms()
    set_enrich_state(workspace_id, enrich_pending=True, enrich_error=None, cache_hit=False)
    db = SessionLocal()
    try:
        from app.features.requirement_studio.application import get_knowledge_row, get_workspace

        workspace = get_workspace(db, workspace_id)
        row = get_knowledge_row(db, workspace_id)
        if workspace is None or row is None:
            set_enrich_state(
                workspace_id,
                enrich_pending=False,
                enrich_error="Knowledge/workspace missing",
            )
            return
        if int(row.version or 0) != int(expected_version):
            set_enrich_state(workspace_id, enrich_pending=False, enrich_error=None)
            return

        t_prep = now_ms()
        pairs, file_names, file_count, chunk_count = load_chunk_pairs(db, workspace_id)
        input_hash = chunks_input_hash(pairs, file_names)
        heuristic = normalize_knowledge_payload(
            parse_json_field(row.payload_json) or {}
        )
        cached_payload = get_enrich_payload_cache(str(workspace_id))
        if (
            cached_payload
            and cached_payload.get("hash") == input_hash
            and isinstance(cached_payload.get("payload"), dict)
        ):
            prepare_ms = elapsed_ms(t_prep)
            merged = merge_knowledge_payloads(heuristic, cached_payload["payload"])
            timing = timing_dict(
                prepare_ms=prepare_ms,
                llm_ms=0,
                persist_ms=0,
                prompt_chars=0,
                provider="cache",
                total_ms=elapsed_ms(t0),
                cache_hit=1,
            )
            t_persist = now_ms()
            persist_knowledge_payload(
                db,
                row,
                workspace,
                merged,
                builder=str(cached_payload.get("builder") or "llm"),
                file_count=file_count,
                chunk_count=chunk_count,
                bump_version=True,
                enrich_input_hash=input_hash,
                enrich_timing=timing,
            )
            timing["persist_ms"] = elapsed_ms(t_persist)
            timing["total_ms"] = elapsed_ms(t0)
            db.commit()
            set_enrich_state(
                workspace_id,
                enrich_pending=False,
                enrich_error=None,
                timing=timing,
                cache_hit=True,
            )
            logger.info(
                "Knowledge enrich CACHE HIT workspace=%s hash=%s prepare_ms=%s total_ms=%s",
                workspace_id,
                input_hash[:12],
                prepare_ms,
                timing["total_ms"],
            )
            return

        conn = db.scalar(
            select(AiBackendConnection).where(
                AiBackendConnection.project_id == project_id
            )
        )
        if conn is None or not C.is_ai_ready(getattr(conn, "status", "")):
            set_enrich_state(
                workspace_id,
                enrich_pending=False,
                enrich_error="AI connection missing or not ready",
            )
            return

        prepare_ms = elapsed_ms(t_prep)

        t_llm = now_ms()
        enrich_timeout_sec = knowledge_enrich_timeout_sec()

        llm_payload: dict[str, Any] = {}
        runner_used = RUNNER_AI_CLI
        prompt_chars = 0
        oneshot_fail_detail: str | None = None

        try:
            oneshot_sys = knowledge_enrich_oneshot_system_prompt()
            oneshot_user = build_enrich_oneshot_prompt(
                pairs, file_names=file_names
            )
            prompt_chars = len(oneshot_sys) + len(oneshot_user)
            raw_one, meta_one = await asyncio.wait_for(
                chat_for_connection(
                    conn,
                    oneshot_sys,
                    oneshot_user,
                    resume_chat_id=None,
                    create_chat=True,
                ),
                timeout=max(45.0, enrich_timeout_sec),
            )
            runner_used = meta_one.get("runnerUsed") or runner_used
            parsed_one = parse_knowledge_llm_json(raw_one) or {}
            if parsed_one:
                llm_payload = normalize_knowledge_payload(parsed_one)
            else:
                preview = (raw_one or "").strip().replace("\n", " ")[:180]
                oneshot_fail_detail = (
                    "CLI trả text nhưng không parse được JSON Knowledge"
                    + (f": {preview}" if preview else " (output rỗng)")
                )
                logger.warning(
                    "Knowledge oneshot empty/unparseable workspace=%s preview=%r",
                    workspace_id,
                    preview,
                )
        except TimeoutError:
            oneshot_fail_detail = (
                f"Oneshot timeout sau {enrich_timeout_sec}s "
                "(tăng AITEST_KNOWLEDGE_ENRICH_TIMEOUT_SEC nếu cần)"
            )
            logger.warning(
                "Knowledge oneshot enrich timeout workspace=%s sec=%s",
                workspace_id,
                enrich_timeout_sec,
            )
        except Exception as oneshot_exc:  # noqa: BLE001
            oneshot_fail_detail = f"Oneshot CLI lỗi: {oneshot_exc}"
            logger.warning(
                "Knowledge oneshot enrich failed: %s",
                oneshot_exc,
            )

        llm_ms = elapsed_ms(t_llm)
        useful = bool(
            llm_payload
            and (
                llm_payload.get("summary")
                or any(
                    llm_payload.get(k)
                    for k in (
                        "features",
                        "businessRules",
                        "actors",
                        "useCases",
                        "validationRules",
                        "apiSummary",
                        "exceptions",
                        "acceptanceCriteria",
                        "constraints",
                        "executionContexts",
                    )
                )
            )
        )
        provider = "llm-cli" if runner_used == RUNNER_AI_CLI else "llm"
        if not useful:
            gaps = list(heuristic.get("gaps") or [])
            gaps.insert(
                0,
                {
                    "text": "LLM enrich không trả JSON hữu ích — giữ bản heuristic.",
                },
            )
            heuristic["gaps"] = gaps
            timing = timing_dict(
                prepare_ms=prepare_ms,
                llm_ms=llm_ms,
                persist_ms=0,
                prompt_chars=prompt_chars,
                provider=provider,
                total_ms=elapsed_ms(t0),
                enrich_mode="oneshot",
            )
            t_persist = now_ms()
            persist_knowledge_payload(
                db,
                row,
                workspace,
                heuristic,
                builder="heuristic-v1",
                file_count=file_count,
                chunk_count=chunk_count,
                bump_version=False,
                enrich_input_hash=input_hash,
                enrich_timing=timing,
            )
            timing["persist_ms"] = elapsed_ms(t_persist)
            timing["total_ms"] = elapsed_ms(t0)
            db.commit()
            set_enrich_state(
                workspace_id,
                enrich_pending=False,
                enrich_error=oneshot_fail_detail or "LLM enrich empty",
                timing=timing,
                cache_hit=False,
            )
            logger.info(
                "Knowledge enrich EMPTY workspace=%s prepare_ms=%s llm_ms=%s "
                "prompt_chars=%s",
                workspace_id,
                prepare_ms,
                llm_ms,
                prompt_chars,
            )
            return

        merged = merge_knowledge_payloads(heuristic, llm_payload)
        builder = provider if llm_payload else "heuristic-v1"
        db.refresh(row)
        if int(row.version or 0) != int(expected_version):
            if (row.status or "") == "building":
                row.status = "ready"
                db.commit()
            set_enrich_state(workspace_id, enrich_pending=False)
            return
        timing = timing_dict(
            prepare_ms=prepare_ms,
            llm_ms=llm_ms,
            persist_ms=0,
            prompt_chars=prompt_chars,
            provider=provider if llm_payload else "heuristic",
            total_ms=0,
            enrich_mode="oneshot",
            passes="oneshot",
        )
        t_persist = now_ms()
        persist_knowledge_payload(
            db,
            row,
            workspace,
            merged,
            builder=builder,
            file_count=file_count,
            chunk_count=chunk_count,
            bump_version=True,
            enrich_input_hash=input_hash,
            enrich_timing=timing,
        )
        timing["persist_ms"] = elapsed_ms(t_persist)
        timing["total_ms"] = elapsed_ms(t0)
        db.commit()
        if llm_payload:
            set_enrich_payload_cache(
                str(workspace_id),
                {
                    "hash": input_hash,
                    "payload": llm_payload,
                    "builder": builder,
                },
            )
        set_enrich_state(
            workspace_id,
            enrich_pending=False,
            enrich_error=None,
            timing=timing,
            cache_hit=False,
        )
        logger.info(
            "Knowledge enrich OK workspace=%s v%s→%s builder=%s "
            "prepare_ms=%s llm_ms=%s persist_ms=%s prompt_chars=%s total_ms=%s",
            workspace_id,
            expected_version,
            row.version,
            builder,
            prepare_ms,
            llm_ms,
            timing["persist_ms"],
            prompt_chars,
            timing["total_ms"],
        )
    except Exception as e:  # noqa: BLE001
        logger.exception("Knowledge enrich failed workspace=%s: %s", workspace_id, e)
        try:
            row = get_knowledge_row(db, workspace_id)
            workspace = get_workspace(db, workspace_id)
            if row is not None and workspace is not None:
                payload = normalize_knowledge_payload(
                    parse_json_field(row.payload_json) or {}
                )
                gaps = list(payload.get("gaps") or [])
                gaps.insert(
                    0,
                    {"text": f"LLM enrich lỗi — giữ heuristic. ({e})"},
                )
                payload["gaps"] = gaps
                row.payload_json = json.dumps(payload, ensure_ascii=False)
                row.summary = (payload.get("summary") or "")[:4000] or None
                row.status = "ready"
                row.error = str(e)[:500]
                db.commit()
        except Exception:
            db.rollback()
        set_enrich_state(
            workspace_id,
            enrich_pending=False,
            enrich_error=str(e)[:500],
            timing=timing_dict(total_ms=elapsed_ms(t0), error=1),
        )
    finally:
        db.close()


async def build_knowledge(
    db: Session,
    workspace: RequirementWorkspace,
    *,
    use_llm: bool = True,
) -> dict:
    """
    Progressive Knowledge build:
    1) Heuristic → status=ready immediately (enrichPending if LLM scheduled)
    2) Background Cursor/LLM enrich merges + bumps version
    """
    from app.features.requirement_studio.application import get_knowledge_row

    pairs, file_names, file_count, chunk_count = load_chunk_pairs(db, workspace.id)
    if chunk_count == 0:
        raise ValueError(
            "Chưa có nội dung SRS — upload và parse file thành công trước khi Phân tích"
        )

    row = get_knowledge_row(db, workspace.id)
    if row is None:
        row = KnowledgeWorkspace(
            workspace_id=workspace.id,
            project_id=workspace.project_id,
            status="building",
            version=0,
        )
        db.add(row)
    else:
        row.status = "building"
        row.error = None
    db.commit()
    db.refresh(row)

    payload = build_knowledge_heuristic(pairs, file_names=file_names)
    persist_knowledge_payload(
        db,
        row,
        workspace,
        payload,
        builder="heuristic-v1",
        file_count=file_count,
        chunk_count=chunk_count,
        bump_version=True,
    )
    db.commit()
    db.refresh(row)
    expected_version = int(row.version or 0)

    schedule_enrich = False
    if use_llm:
        conn = db.scalar(
            select(AiBackendConnection).where(
                AiBackendConnection.project_id == workspace.project_id
            )
        )
        schedule_enrich = conn is not None and C.is_ai_ready(getattr(conn, "status", ""))

    if schedule_enrich:
        # Keep status=ready so UI can render Heuristic v1 immediately while background AI enrich runs
        row.status = "ready"
        db.commit()
        db.refresh(row)
        set_enrich_state(workspace.id, enrich_pending=True, enrich_error=None)
        try:
            asyncio.get_running_loop().create_task(
                enrich_knowledge_background(
                    workspace.id,
                    workspace.project_id,
                    expected_version=expected_version,
                )
            )
        except RuntimeError:
            # No running loop — enrich inline (tests / sync context)
            await enrich_knowledge_background(
                workspace.id,
                workspace.project_id,
                expected_version=expected_version,
            )
            db.refresh(row)
    else:
        clear_enrich_state(workspace.id)

    return knowledge_dto(row, enrich=get_enrich_state(workspace.id))
