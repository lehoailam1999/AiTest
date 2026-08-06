"""Disk-backed Knowledge enrich cache (output-neutral perf)."""

from __future__ import annotations

import json

from app.features.requirement_studio.enrich_cache import (
    get_enrich_payload_cache,
    pop_enrich_payload_cache,
    set_enrich_payload_cache,
)


def test_enrich_payload_cache_persists_across_memory_clear(tmp_path, monkeypatch):
    monkeypatch.chdir(tmp_path)
    wid = "ws-test-1"
    entry = {
        "hash": "abc123",
        "payload": {"features": [{"name": "Login"}]},
        "builder": "llm-cli",
    }
    set_enrich_payload_cache(wid, entry)
    from app.features.requirement_studio.enrich_cache import _enrich_payload_cache

    _enrich_payload_cache.pop(wid, None)
    loaded = get_enrich_payload_cache(wid)
    assert loaded is not None
    assert loaded["hash"] == "abc123"
    assert loaded["payload"]["features"][0]["name"] == "Login"

    cache_file = tmp_path / ".aitest_workspace" / "knowledge_enrich_cache" / f"{wid}.json"
    assert cache_file.is_file()
    on_disk = json.loads(cache_file.read_text(encoding="utf-8"))
    assert on_disk["builder"] == "llm-cli"

    pop_enrich_payload_cache(wid)
    assert get_enrich_payload_cache(wid) is None
    assert not cache_file.is_file()
