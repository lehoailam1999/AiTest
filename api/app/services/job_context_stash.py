from __future__ import annotations

import uuid
from typing import Any

# Ephemeral job extras — không persist DB.
_pending: dict[str, dict[str, Any]] = {}


def stash_job_context(job_id: uuid.UUID, formatted_prompt: str) -> None:
    entry = _pending.setdefault(str(job_id), {})
    entry["context"] = formatted_prompt


def stash_job_topic_scope(job_id: uuid.UUID, topic_scope: dict[str, Any]) -> None:
    entry = _pending.setdefault(str(job_id), {})
    entry["topicScope"] = topic_scope


def stash_job_context_packet(job_id: uuid.UUID, packet: dict[str, Any]) -> None:
    from app.services.context_packet import format_context_packet_for_prompt

    text = format_context_packet_for_prompt(packet)
    if text:
        stash_job_context(job_id, text)


def stash_job_engine_hint(job_id: uuid.UUID, hint: dict[str, Any]) -> None:
    """R1 Studio — preferredEngine unit|e2e + optional E2E inputs."""
    entry = _pending.setdefault(str(job_id), {})
    entry["engineHint"] = hint


def pop_job_extras(job_id: uuid.UUID) -> dict[str, Any]:
    return _pending.pop(str(job_id), {})


def pop_job_context(job_id: uuid.UUID) -> str | None:
    extras = pop_job_extras(job_id)
    ctx = extras.get("context")
    return ctx if isinstance(ctx, str) else None
