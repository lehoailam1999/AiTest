"""DTOs for Requirement Studio FileRefs + Chunks + Knowledge (R1–R3)."""

from __future__ import annotations

import json

from app.models.domain import (
    DocumentChunk,
    KnowledgeWorkspace,
    RequirementFile,
    RequirementSnapshot,
    RequirementWorkspace,
)

PREVIEW_HTML_MAX = 80_000


def workspace_dto(
    ws: RequirementWorkspace,
    *,
    file_count: int | None = None,
    chunk_count: int | None = None,
    knowledge_status: str | None = None,
) -> dict:
    out: dict = {
        "id": ws.id,
        "projectId": ws.project_id,
        "title": ws.title,
        "status": ws.status,
        "legacySourceId": ws.legacy_source_id,
        "createdAt": ws.created_at,
        "updatedAt": ws.updated_at,
    }
    if file_count is not None:
        out["fileCount"] = file_count
    if chunk_count is not None:
        out["chunkCount"] = chunk_count
    if knowledge_status is not None:
        out["knowledgeStatus"] = knowledge_status
    return out


def file_ref_dto(
    f: RequirementFile,
    *,
    include_text: bool = False,
    chunk_count: int | None = None,
) -> dict:
    """FileRef API shape — never expose content_bytes."""
    out: dict = {
        "id": f.id,
        "workspaceId": f.workspace_id,
        "fileName": f.file_name,
        "mimeType": f.mime_type,
        "byteSize": f.byte_size,
        "contentSha256": f.content_sha256,
        "parseStatus": f.parse_status,
        "parseError": f.parse_error,
        "parser": f.parser,
        "parseWarning": f.parse_warning,
        "chunkStatus": getattr(f, "chunk_status", None) or "none",
        "storageKind": f.storage_kind,
        "charCount": len(f.extracted_text) if f.extracted_text else 0,
        "hasPreview": bool(f.preview_html),
        "createdAt": f.created_at,
        "updatedAt": f.updated_at,
    }
    if chunk_count is not None:
        out["chunkCount"] = chunk_count
    if include_text:
        out["extractedText"] = f.extracted_text
        out["previewHtml"] = f.preview_html
    return out


def chunk_dto(c: DocumentChunk) -> dict:
    return {
        "id": c.id,
        "fileId": c.file_id,
        "workspaceId": c.workspace_id,
        "ordinal": c.ordinal,
        "text": c.text,
        "charCount": c.char_count,
        "heading": c.heading,
        "createdAt": c.created_at,
    }


def knowledge_dto(
    k: KnowledgeWorkspace | None,
    *,
    enrich: dict | None = None,
) -> dict:
    enrich = enrich or {}
    enrich_pending = bool(enrich.get("enrichPending"))
    enrich_error = enrich.get("enrichError")
    if k is None:
        return {
            "status": "empty",
            "version": 0,
            "summary": None,
            "payload": None,
            "coverage": None,
            "builder": None,
            "sourceFileCount": 0,
            "sourceChunkCount": 0,
            "error": None,
            "builtAt": None,
            "enrichPending": False,
            "enrichError": None,
            "enrichTiming": None,
            "enrichCacheHit": False,
        }
    payload = None
    if k.payload_json:
        try:
            from app.features.requirement_studio.knowledge_builder import (
                normalize_knowledge_payload,
            )

            raw = json.loads(k.payload_json)
            payload = (
                normalize_knowledge_payload(raw) if isinstance(raw, dict) else None
            )
        except Exception:
            payload = None
    coverage = None
    if getattr(k, "coverage_json", None):
        try:
            coverage = json.loads(k.coverage_json)
        except Exception:
            coverage = None
    return {
        "id": k.id,
        "workspaceId": k.workspace_id,
        "projectId": k.project_id,
        "status": "building" if enrich_pending else k.status,
        "version": k.version,
        "builder": k.builder,
        "summary": None if enrich_pending else k.summary,
        # Không trả payload heuristic ra UI khi đang enrich — tránh hiện bản tạm trước
        "payload": None if enrich_pending else payload,
        "coverage": None if enrich_pending else coverage,
        "sourceFileCount": k.source_file_count,
        "sourceChunkCount": k.source_chunk_count,
        "error": k.error,
        "builtAt": k.built_at,
        "updatedAt": k.updated_at,
        "enrichPending": enrich_pending,
        "enrichError": enrich_error,
        "enrichTiming": enrich.get("timing"),
        "enrichCacheHit": bool(enrich.get("cacheHit")),
    }


def chat_session_dto(s) -> dict:
    return {
        "id": s.id,
        "workspaceId": s.workspace_id,
        "knowledgeId": s.knowledge_id,
        "title": s.title,
        "status": s.status,
        "knowledgeVersion": s.knowledge_version,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
    }


def chat_message_dto(m) -> dict:
    diff = None
    if m.knowledge_diff_json:
        try:
            diff = json.loads(m.knowledge_diff_json)
        except Exception:
            diff = None
    return {
        "id": m.id,
        "sessionId": m.session_id,
        "workspaceId": m.workspace_id,
        "role": m.role,
        "content": m.content,
        "knowledgeVersion": m.knowledge_version,
        "knowledgeDiff": diff,
        "createdAt": m.created_at,
    }


def snapshot_dto(s: RequirementSnapshot, *, include_payload: bool = True) -> dict:
    payload = None
    coverage = None
    if include_payload:
        if s.payload_json:
            try:
                payload = json.loads(s.payload_json)
            except Exception:
                payload = None
        if s.coverage_json:
            try:
                coverage = json.loads(s.coverage_json)
            except Exception:
                coverage = None
    return {
        "id": s.id,
        "workspaceId": s.workspace_id,
        "projectId": s.project_id,
        "knowledgeId": s.knowledge_id,
        "knowledgeVersion": s.knowledge_version,
        "title": s.title,
        "summary": s.summary,
        "payload": payload,
        "coverage": coverage,
        "sourceFileCount": s.source_file_count,
        "sourceChunkCount": s.source_chunk_count,
        "frozenBy": s.frozen_by,
        "freezeNote": s.freeze_note,
        "createdAt": s.created_at,
        "updatedAt": s.updated_at,
    }


def truncate_preview(html: str | None) -> str | None:
    if not html:
        return None
    if len(html) <= PREVIEW_HTML_MAX:
        return html
    return html[:PREVIEW_HTML_MAX] + "\n<!-- truncated -->"
