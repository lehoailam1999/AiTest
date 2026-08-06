"""Disk-backed cache for Knowledge LLM enrich payloads (hash → llm_payload).

Skips redundant Cursor CLI calls when SRS section pairs are unchanged.
Merge logic stays in ``merge_knowledge_payloads`` — cache stores LLM slice only.
"""

from __future__ import annotations

import json
import logging
import os
from pathlib import Path
from typing import Any

logger = logging.getLogger(__name__)

# In-process layer (tests may pop this dict — also clears disk via pop_enrich_payload_cache).
_enrich_payload_cache: dict[str, dict[str, Any]] = {}


def _cache_dir() -> Path:
    raw = (os.environ.get("AITEST_KNOWLEDGE_ENRICH_CACHE_DIR") or "").strip()
    if raw:
        return Path(raw)
    return Path.cwd() / ".aitest_workspace" / "knowledge_enrich_cache"


def _cache_path(workspace_id: str) -> Path:
    safe = workspace_id.replace("/", "_").replace("\\", "_")
    return _cache_dir() / f"{safe}.json"


def get_enrich_payload_cache(workspace_id: str) -> dict[str, Any] | None:
    key = str(workspace_id)
    hit = _enrich_payload_cache.get(key)
    if hit is not None:
        return hit
    path = _cache_path(key)
    if not path.is_file():
        return None
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
        if isinstance(raw, dict):
            _enrich_payload_cache[key] = raw
            return raw
    except Exception as exc:  # noqa: BLE001
        logger.warning("Knowledge enrich cache read failed %s: %s", path, exc)
    return None


def set_enrich_payload_cache(workspace_id: str, entry: dict[str, Any]) -> None:
    key = str(workspace_id)
    _enrich_payload_cache[key] = entry
    path = _cache_path(key)
    try:
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(json.dumps(entry, ensure_ascii=False), encoding="utf-8")
    except Exception as exc:  # noqa: BLE001
        logger.warning("Knowledge enrich cache write failed %s: %s", path, exc)


def pop_enrich_payload_cache(workspace_id: str) -> None:
    key = str(workspace_id)
    _enrich_payload_cache.pop(key, None)
    path = _cache_path(key)
    try:
        if path.is_file():
            path.unlink()
    except Exception as exc:  # noqa: BLE001
        logger.warning("Knowledge enrich cache delete failed %s: %s", path, exc)
