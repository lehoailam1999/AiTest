"""Phase 1 — progressive Knowledge + merge / enrich state."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from app.features.requirement_studio import application as app_svc
from app.features.requirement_studio.knowledge_builder import merge_knowledge_payloads


def test_enrich_state_roundtrip():
    wid = uuid.uuid4()
    app_svc.clear_enrich_state(wid)
    assert app_svc.get_enrich_state(wid)["enrichPending"] is False
    app_svc.set_enrich_state(wid, enrich_pending=True, cursor_chat_id="chat-abc")
    st = app_svc.get_enrich_state(wid)
    assert st["enrichPending"] is True
    assert st["cursorChatId"] == "chat-abc"
    app_svc.set_enrich_state(wid, enrich_pending=False, enrich_error="boom")
    st2 = app_svc.get_enrich_state(wid)
    assert st2["enrichPending"] is False
    assert st2["enrichError"] == "boom"
    assert st2["cursorChatId"] == "chat-abc"
    app_svc.clear_enrich_state(wid)


def test_merge_keeps_heuristic_when_overlay_empty_list():
    base = {
        "summary": "H",
        "features": [{"name": "Login"}],
        "apiSummary": [{"method": "GET", "path": "/x", "note": ""}],
        "actors": [],
        "useCases": [],
        "businessRules": [],
        "validationRules": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "gaps": [{"text": "g1"}],
    }
    over = {
        "summary": "L",
        "features": [{"name": "Auth"}],
        "apiSummary": [],
        "actors": [{"name": "User"}],
        "useCases": [],
        "businessRules": [],
        "validationRules": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "gaps": [],
    }
    m = merge_knowledge_payloads(base, over)
    assert m["summary"] == "L"
    # LLM first, then heuristic extras (không wipe Login)
    assert [f["name"] for f in m["features"]] == ["Auth", "Login"]
    assert m["actors"][0]["name"] == "User"
    assert m["apiSummary"][0]["path"] == "/x"
    # empty gaps overlay keeps heuristic gaps
    assert m["gaps"][0]["text"] == "g1"


def test_build_knowledge_returns_heuristic_before_enrich():
    import asyncio

    wid = uuid.uuid4()
    pid = uuid.uuid4()
    app_svc.clear_enrich_state(wid)

    workspace = MagicMock()
    workspace.id = wid
    workspace.project_id = pid

    row = MagicMock()
    row.id = uuid.uuid4()
    row.workspace_id = wid
    row.project_id = pid
    row.status = "ready"
    row.version = 1
    row.builder = "heuristic-v1"
    row.summary = "sum"
    row.payload_json = (
        '{"summary":"sum","features":[],"actors":[],"useCases":[],'
        '"businessRules":[],"validationRules":[],"apiSummary":[],'
        '"exceptions":[],"acceptanceCriteria":[],"constraints":[],"gaps":[]}'
    )
    row.coverage_json = None
    row.source_file_count = 1
    row.source_chunk_count = 1
    row.error = None
    row.built_at = None
    row.updated_at = None

    db = MagicMock()
    enrich_mock = AsyncMock()

    with (
        patch.object(
            app_svc,
            "_load_chunk_pairs",
            return_value=([("Feature: X", "must login")], ["a.md"], 1, 1),
        ),
        patch.object(app_svc, "get_knowledge_row", side_effect=[None, row, row]),
        patch.object(
            app_svc,
            "build_knowledge_heuristic",
            return_value={
                "summary": "sum",
                "features": [{"name": "X"}],
                "actors": [],
                "useCases": [],
                "businessRules": [],
                "validationRules": [],
                "apiSummary": [],
                "exceptions": [],
                "acceptanceCriteria": [],
                "constraints": [],
                "gaps": [],
            },
        ),
        patch.object(app_svc, "_persist_knowledge_payload"),
        patch.object(app_svc, "enrich_knowledge_background", enrich_mock),
        patch(
            "app.features.requirement_studio.application.KnowledgeWorkspace",
            return_value=row,
        ),
    ):
        conn = MagicMock()
        db.scalar = MagicMock(return_value=conn)
        db.add = MagicMock()
        db.commit = MagicMock()

        def _refresh(obj):
            obj.version = 1
            obj.status = "ready"

        db.refresh.side_effect = _refresh

        dto = asyncio.run(app_svc.build_knowledge(db, workspace, use_llm=True))

    assert dto.get("enrichPending") is True
    assert enrich_mock.await_count == 1
