"""Phase 1 — progressive Knowledge + merge / enrich state."""

from __future__ import annotations

import uuid
from unittest.mock import AsyncMock, MagicMock, patch

from app.features.requirement_studio import application as app_svc
from app.features.requirement_studio import knowledge_pipeline as pipe_svc
from app.features.requirement_studio.enrich_cache import pop_enrich_payload_cache
from app.features.requirement_studio.knowledge_builder import merge_knowledge_payloads


def test_knowledge_dto_keeps_ready_while_enrich_pending():
    """Do not mask status=building during enrich — Freeze needs ready+heuristic."""
    from types import SimpleNamespace

    from app.features.requirement_studio.dto import knowledge_dto

    row = SimpleNamespace(
        id=uuid.uuid4(),
        workspace_id=uuid.uuid4(),
        project_id=uuid.uuid4(),
        status="ready",
        version=3,
        builder="heuristic-v1",
        summary="sum",
        payload_json='{"summary":"sum","features":[{"name":"X"}]}',
        coverage_json=None,
        source_file_count=1,
        source_chunk_count=2,
        error=None,
        built_at=None,
        updated_at=None,
    )
    dto = knowledge_dto(
        row,
        enrich={"enrichPending": True, "enrichError": None, "cacheHit": False},
    )
    assert dto["status"] == "ready"
    assert dto["enrichPending"] is True
    assert dto["payload"] is not None


def test_enrich_state_roundtrip():
    wid = uuid.uuid4()
    pipe_svc.clear_enrich_state(wid)
    assert pipe_svc.get_enrich_state(wid)["enrichPending"] is False
    pipe_svc.set_enrich_state(wid, enrich_pending=True)
    st = pipe_svc.get_enrich_state(wid)
    assert st["enrichPending"] is True
    pipe_svc.set_enrich_state(wid, enrich_pending=False, enrich_error="boom")
    st2 = pipe_svc.get_enrich_state(wid)
    assert st2["enrichPending"] is False
    assert st2["enrichError"] == "boom"
    pipe_svc.clear_enrich_state(wid)


def test_merge_keeps_heuristic_when_overlay_empty_list():
    base = {
        "summary": "H",
        "features": [{"name": "Login", "description": "FR-01 email password login"}],
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
        "features": [{"name": "Auth", "description": "FR-02 session check"}],
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
    pipe_svc.clear_enrich_state(wid)

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
            pipe_svc,
            "load_chunk_pairs",
            return_value=([("Feature: X", "must login")], ["a.md"], 1, 1),
        ),
        patch.object(app_svc, "get_knowledge_row", side_effect=[None, row, row]),
        patch.object(
            pipe_svc,
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
        patch.object(pipe_svc, "persist_knowledge_payload"),
        patch.object(pipe_svc, "enrich_knowledge_background", enrich_mock),
        patch(
            "app.features.requirement_studio.knowledge_pipeline.KnowledgeWorkspace",
            return_value=row,
        ),
    ):
        conn = MagicMock()
        conn.status = "Ready"
        db.scalar = MagicMock(return_value=conn)
        db.add = MagicMock()
        db.commit = MagicMock()

        def _refresh(obj):
            obj.version = 1
            obj.status = "ready"

        db.refresh.side_effect = _refresh

        dto = asyncio.run(pipe_svc.build_knowledge(db, workspace, use_llm=True))

    assert dto.get("enrichPending") is True
    assert enrich_mock.await_count == 1


def test_enrich_oneshot_single_cli_call():
    """Default enrich mode = oneshot → 1 CLI call, merge onto heuristic."""
    import asyncio
    import json

    wid = uuid.uuid4()
    pid = uuid.uuid4()
    pipe_svc.clear_enrich_state(wid)
    pop_enrich_payload_cache(str(wid))

    workspace = MagicMock()
    workspace.id = wid
    workspace.project_id = pid

    heuristic = {
        "summary": "H",
        "features": [{"name": "Login", "description": "FR-01 POST /login"}],
        "actors": [],
        "useCases": [
            {
                "name": "Đăng nhập",
                "steps": "1. Mở form\n2. Submit",
                "mermaid": "flowchart TD\nS-->E",
            }
        ],
        "businessRules": [],
        "validationRules": [],
        "apiSummary": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "executionContexts": [],
        "gaps": [],
    }
    row = MagicMock()
    row.id = uuid.uuid4()
    row.workspace_id = wid
    row.project_id = pid
    row.status = "building"
    row.version = 2
    row.payload_json = json.dumps(heuristic)
    row.builder = "heuristic-v1"
    row.summary = "H"
    row.coverage_json = None
    row.source_file_count = 1
    row.source_chunk_count = 2
    row.error = None
    row.built_at = None

    chat_calls: list[dict] = []

    async def fake_chat(conn, sys, user, resume_chat_id=None, create_chat=False):
        chat_calls.append({"resume": resume_chat_id, "create": create_chat})
        body = json.dumps(
            {
                "summary": "S",
                "features": [{"name": "Login", "description": "FR-01 POST /login"}],
                "actors": [{"name": "User"}],
                "useCases": [
                    {
                        "name": "Đăng nhập",
                        "steps": "1. Mở form\n2. Nhập email\n3. Submit",
                        "mermaid": "flowchart TD\nS-->A-->E",
                    }
                ],
                "businessRules": [{"id": "BR-1", "text": "User must login"}],
                "validationRules": [
                    {"field": "email", "rule": "required", "module": "Login"}
                ],
                "apiSummary": [{"method": "POST", "path": "/login", "note": ""}],
                "exceptions": [],
                "acceptanceCriteria": [],
                "constraints": [],
                "executionContexts": [],
                "gaps": [],
            }
        )
        return body, {"runnerUsed": "AI_CLI"}

    db = MagicMock()
    db.scalar = MagicMock(return_value=MagicMock(status="ready"))
    db.commit = MagicMock()
    db.refresh = MagicMock()
    db.close = MagicMock()

    persisted: list[dict] = []

    def fake_persist(_db, _row, _ws, payload, **kwargs):
        persisted.append({"payload": payload, **kwargs})

    with (
        patch("app.database.SessionLocal", return_value=db),
        patch.object(app_svc, "get_workspace", return_value=workspace),
        patch.object(app_svc, "get_knowledge_row", return_value=row),
        patch.object(
            pipe_svc,
            "load_chunk_pairs",
            return_value=(
                [("Features", "Login module"), ("API", "POST /login")],
                ["srs.md"],
                1,
                2,
            ),
        ),
        patch.object(pipe_svc, "persist_knowledge_payload", side_effect=fake_persist),
        patch("app.services.ai_service.chat_for_connection", side_effect=fake_chat),
        patch(
            "app.features.requirement_studio.knowledge_pipeline.C.is_ai_ready",
            return_value=True,
        ),
    ):
        asyncio.run(
            pipe_svc.enrich_knowledge_background(wid, pid, expected_version=2)
        )

    assert len(chat_calls) == 1
    assert chat_calls[0]["resume"] is None
    assert chat_calls[0]["create"] is False  # oneshot thuần — không create-chat
    assert persisted
    final = persisted[-1]["payload"]
    assert final.get("summary") == "S"
    assert any(a.get("name") == "User" for a in final.get("actors") or [])
    assert any(v.get("field") == "email" for v in final.get("validationRules") or [])
    st = pipe_svc.get_enrich_state(wid)
    assert st["enrichPending"] is False
    assert st["enrichError"] is None
    pipe_svc.clear_enrich_state(wid)


def test_knowledge_enrich_timeout_defaults_match_cursor_cli():
    import os

    with patch.dict(os.environ, {}, clear=True):
        assert pipe_svc.knowledge_enrich_timeout_sec() == 360.0
    with patch.dict(
        os.environ,
        {"AITEST_CURSOR_ONESHOT_TIMEOUT": "420"},
        clear=True,
    ):
        assert pipe_svc.knowledge_enrich_timeout_sec() == 420.0
    with patch.dict(
        os.environ,
        {"AITEST_KNOWLEDGE_ENRICH_TIMEOUT_SEC": "240"},
        clear=True,
    ):
        assert pipe_svc.knowledge_enrich_timeout_sec() == 240.0
