"""Cooperative pause/resume for TC generate jobs (fan-out between modules).

Pause does NOT cancel the in-flight module LLM call — that module finishes and
persists TCs. Remaining modules stay pending until resume. Already-saved drafts
are never wiped on pause/resume (append-only continuation).

Checkpoint is kept in-memory and mirrored to disk so API reload still resumes
only pending modules (does not restart from the first module).
"""

from __future__ import annotations

import json
import threading
import uuid
from pathlib import Path
from typing import Any

_lock = threading.Lock()
# job_id → True when FE requested pause
_pause_requested: dict[str, bool] = {}
# Durable-enough for process lifetime: pending modules + extras to resume
_checkpoints: dict[str, dict[str, Any]] = {}


def _key(job_id: uuid.UUID | str) -> str:
    return str(job_id)


def _checkpoint_dir() -> Path:
    d = Path.cwd() / ".aitest_workspace" / "job_checkpoints"
    d.mkdir(parents=True, exist_ok=True)
    return d


def _checkpoint_path(job_id: uuid.UUID | str) -> Path:
    return _checkpoint_dir() / f"{_key(job_id)}.json"


def request_pause(job_id: uuid.UUID | str) -> None:
    with _lock:
        _pause_requested[_key(job_id)] = True


def clear_pause_request(job_id: uuid.UUID | str) -> None:
    with _lock:
        _pause_requested.pop(_key(job_id), None)


def is_pause_requested(job_id: uuid.UUID | str) -> bool:
    with _lock:
        return bool(_pause_requested.get(_key(job_id)))


def save_checkpoint(job_id: uuid.UUID | str, state: dict[str, Any]) -> None:
    """
    state keys:
      pendingModules: list[str]
      doneModules: list[str]
      allModules: list[str]  (optional — original fan-out order)
      engineHint: dict
      preferredEngine: str | None
      savedCount: int
      mode: str
    """
    payload = dict(state or {})
    with _lock:
        _checkpoints[_key(job_id)] = payload
    try:
        _checkpoint_path(job_id).write_text(
            json.dumps(payload, ensure_ascii=False, indent=0),
            encoding="utf-8",
        )
    except OSError:
        pass


def load_checkpoint(job_id: uuid.UUID | str) -> dict[str, Any] | None:
    with _lock:
        raw = _checkpoints.get(_key(job_id))
        if isinstance(raw, dict):
            return dict(raw)
    # Fall back to disk (API process restarted after pause)
    path = _checkpoint_path(job_id)
    if not path.is_file():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    with _lock:
        _checkpoints[_key(job_id)] = dict(data)
    return dict(data)


def pop_checkpoint(job_id: uuid.UUID | str) -> dict[str, Any] | None:
    with _lock:
        raw = _checkpoints.pop(_key(job_id), None)
    path = _checkpoint_path(job_id)
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass
    return dict(raw) if isinstance(raw, dict) else None


def clear_job_control(job_id: uuid.UUID | str) -> None:
    with _lock:
        _pause_requested.pop(_key(job_id), None)
        _checkpoints.pop(_key(job_id), None)
    path = _checkpoint_path(job_id)
    try:
        if path.is_file():
            path.unlink()
    except OSError:
        pass


def pending_modules_after_claim(
    titles: list[str],
    next_claim_index: int,
    *,
    done: list[str] | None = None,
) -> list[str]:
    """Modules not yet claimed (and not already done) — used for pause checkpoint."""
    done_set = set(done or [])
    out: list[str] = []
    for t in titles[max(0, int(next_claim_index)) :]:
        if t and t not in done_set and t not in out:
            out.append(t)
    return out


def remaining_modules(titles: list[str], done: list[str] | None = None) -> list[str]:
    """Stable remaining list: preserve original order, skip completed titles."""
    done_set = set(done or [])
    out: list[str] = []
    for t in titles:
        if t and t not in done_set and t not in out:
            out.append(t)
    return out
