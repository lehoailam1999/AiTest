"""Live job progress + CLI transcript for generate TC."""

from __future__ import annotations

import logging
import time
import uuid
from datetime import datetime, timezone

logger = logging.getLogger(__name__)

_MAX_LOG_LINES = 800

# Job id → latest progress line
_progress: dict[str, str] = {}
_last_persist_at: dict[str, float] = {}
# Job id → transcript lines (conversation-like)
_logs: dict[str, list[str]] = {}


def append_job_log(job_id: uuid.UUID | str, line: str) -> None:
    text = (line or "").rstrip()
    if not text:
        return
    key = str(job_id)
    bucket = _logs.setdefault(key, [])
    # Collapse exact consecutive duplicates
    if bucket and bucket[-1] == text[:4000]:
        return
    bucket.append(text[:4000])
    if len(bucket) > _MAX_LOG_LINES:
        del bucket[: len(bucket) - _MAX_LOG_LINES]
    _progress[key] = text[:2000]


def set_job_progress(job_id: uuid.UUID | str, message: str, *, persist: bool = True) -> None:
    text = (message or "").strip()
    if not text:
        return
    key = str(job_id)
    append_job_log(key, text)
    if not persist:
        return
    now = time.monotonic()
    last = _last_persist_at.get(key, 0.0)
    if now - last < 2.0 and not text.startswith(("Module ", "Hoàn tất", "Thất bại", "---")):
        return
    _last_persist_at[key] = now
    try:
        from app.database import SessionLocal
        from app.models.domain import Job

        db = SessionLocal()
        try:
            job = db.query(Job).filter(Job.id == uuid.UUID(key)).first()
            if job is None:
                return
            job.progress_message = text[:2000]
            job.updated_at = datetime.now(timezone.utc)
            db.commit()
        finally:
            db.close()
    except Exception as exc:  # noqa: BLE001
        logger.debug("set_job_progress persist skipped: %s", exc)


def get_job_progress(job_id: uuid.UUID | str) -> str | None:
    return _progress.get(str(job_id))


def get_job_log(job_id: uuid.UUID | str) -> list[str]:
    return list(_logs.get(str(job_id), []))


def clear_job_progress(job_id: uuid.UUID | str) -> None:
    key = str(job_id)
    _progress.pop(key, None)
    _last_persist_at.pop(key, None)
    # Keep log until cleared explicitly so FE can show final transcript briefly
    # Callers that want wipe use clear_job_log.


def clear_job_log(job_id: uuid.UUID | str) -> None:
    _logs.pop(str(job_id), None)


def clear_job_progress_and_log(job_id: uuid.UUID | str) -> None:
    clear_job_progress(job_id)
    clear_job_log(job_id)
