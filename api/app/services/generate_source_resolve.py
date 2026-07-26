"""
P4 — Resolve sources for generate-unit / generate-api.

Rules:
- Valid contextPacket (v1 + primary content) is the only prompt source.
- workspaceId must NOT override packet (staging/audit only).
- body.sourceCode must NOT override packet primary content.
- Legacy workspace expand / raw body kept with deprecation logging.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any, Literal

from app.services.context_packet import primary_from_packet, related_sources_from_packet

log = logging.getLogger("aitest.generate")

SourceMode = Literal["packet", "workspace", "body"]


@dataclass
class ResolvedGenerateSources:
    source_file_name: str
    source_code: str
    related_sources: list[tuple[str, str]]
    source_mode: SourceMode
    ignored_workspace_id: bool = False
    ignored_body_source_code: bool = False
    notes: list[str] = field(default_factory=list)


def packet_is_usable(packet: Any) -> bool:
    if not isinstance(packet, dict) or packet.get("packetVersion") != 1:
        return False
    primary = primary_from_packet(packet)
    return bool(primary and (primary[1] or "").strip())


def resolve_from_context_packet(
    packet: dict,
    *,
    workspace_id: str | None = None,
    body_source_code: str | None = None,
    body_source_file_name: str | None = None,
) -> ResolvedGenerateSources:
    """
    Packet-only resolution (P4 DoD).
    Filename may use body hint only when body path equals packet primary path;
    content always comes from packet.
    """
    primary = primary_from_packet(packet)
    assert primary is not None
    path, content = primary
    related = related_sources_from_packet(packet)

    ignored_ws = bool(workspace_id)
    body_code = (body_source_code or "").strip()
    ignored_body = bool(body_code) and body_code != content.strip()

    # Prefer packet path; allow body filename only if it matches the same pathRel
    body_name = (body_source_file_name or "").strip().replace("\\", "/")
    if body_name and body_name.replace("\\", "/") == path.replace("\\", "/"):
        file_name = body_name
    else:
        file_name = path

    notes: list[str] = ["contextPacket"]
    if ignored_ws:
        notes.append(f"ignored_workspaceId={workspace_id}")
        log.info(
            "P4: contextPacket wins — ignoring workspaceId=%s (no disk expand)",
            workspace_id,
        )
    if ignored_body:
        notes.append("ignored_body_sourceCode")
        log.info("P4: contextPacket wins — ignoring body.sourceCode for prompt")

    return ResolvedGenerateSources(
        source_file_name=file_name,
        source_code=content,
        related_sources=related,
        source_mode="packet",
        ignored_workspace_id=ignored_ws,
        ignored_body_source_code=ignored_body,
        notes=notes,
    )


def related_from_body(body: dict) -> list[tuple[str, str]]:
    related_raw = body.get("relatedSources") or []
    out: list[tuple[str, str]] = []
    if not isinstance(related_raw, list):
        return out
    for row in related_raw:
        if not isinstance(row, dict):
            continue
        path = (row.get("path") or "").strip()
        content = (row.get("content") or "").strip()
        role = (row.get("role") or "").strip().lower()
        if path and content and role != "primary":
            out.append((path, content))
    return out


def resolve_from_body_legacy(body: dict) -> ResolvedGenerateSources:
    """Old clients: sourceCode (+ optional relatedSources) without packet."""
    log.warning(
        "P4 deprecation: generate without contextPacket — prefer Desktop IDE/FS Context Builder"
    )
    return ResolvedGenerateSources(
        source_file_name=str(body.get("sourceFileName") or ""),
        source_code=str(body.get("sourceCode") or ""),
        related_sources=related_from_body(body),
        source_mode="body",
        notes=["legacy_body"],
    )


def language_from_packet(packet: dict | None, fallback: str = "") -> str:
    if not isinstance(packet, dict):
        return fallback
    meta = packet.get("meta") if isinstance(packet.get("meta"), dict) else {}
    lang = (meta.get("language") or "").strip()
    return lang or fallback
