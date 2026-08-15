"""Tests for grounded pick-unit-primary / pick-unit-field helpers."""

from __future__ import annotations

import asyncio
import json
import types
import uuid
from unittest.mock import AsyncMock, patch

from app.routers.agent_pick_unit import (
    accept_field_shortlist_pick,
    accept_shortlist_pick,
    parse_pick_field_json,
    parse_pick_unit_json,
    pick_unit_field_batch,
    pick_unit_grounding_batch,
    pick_unit_field,
    pick_unit_primary,
)


def test_parse_pick_unit_json_plain():
    raw = '{"path":"src/A/FooHandler.cs","code":"FooHandler","confidence":0.85}'
    got = parse_pick_unit_json(raw)
    assert got["path"] == "src/A/FooHandler.cs"
    assert got["code"] == "FooHandler"
    assert got["confidence"] == 0.85


def test_parse_pick_unit_json_fenced():
    raw = '```json\n{"path":null,"code":null,"confidence":0}\n```'
    got = parse_pick_unit_json(raw)
    assert got["path"] is None
    assert got["confidence"] == 0


def test_accept_shortlist_pick_ok():
    cands = [
        {"path": "src/App/Commands/Widget/WidgetCreateCommandHandler.cs", "code": "WidgetCreateCommandHandler"},
        {"path": "src/App/Commands/Order/OrderCreateCommandHandler.cs", "code": "OrderCreateCommandHandler"},
    ]
    pick = {
        "path": "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        "code": "WidgetCreateCommandHandler",
        "confidence": 0.9,
    }
    got = accept_shortlist_pick(pick, cands)
    assert got is not None
    assert "WidgetCreate" in got["path"]


def test_accept_shortlist_pick_rejects_invented():
    cands = [
        {"path": "src/App/Commands/Widget/WidgetCreateCommandHandler.cs", "code": "WidgetCreateCommandHandler"},
    ]
    pick = {"path": "src/Hack/Evil.cs", "code": "Evil", "confidence": 0.99}
    assert accept_shortlist_pick(pick, cands) is None


def test_accept_shortlist_pick_low_confidence():
    cands = [
        {"path": "src/App/Commands/Widget/WidgetCreateCommandHandler.cs", "code": "WidgetCreateCommandHandler"},
    ]
    pick = {
        "path": "src/App/Commands/Widget/WidgetCreateCommandHandler.cs",
        "code": "WidgetCreateCommandHandler",
        "confidence": 0.4,
    }
    assert accept_shortlist_pick(pick, cands) is None


def test_accept_shortlist_pick_requires_owned_evidence():
    path = "src/App/Commands/Widget/WidgetCreateCommandHandler.cs"
    cands = [{
        "path": path,
        "code": "WidgetCreateCommandHandler",
        "symbols": ["WidgetCreateCommandHandler"],
        "excerpt": "public Task Handle() => Save();",
        "properties": [{"name": "CaseFileId", "ownerPath": "src/App/WidgetCommand.cs"}],
    }]
    accepted = accept_shortlist_pick(
        {
            "path": path,
            "code": "WidgetCreateCommandHandler",
            "property": "CaseFileId",
            "evidence": "Task Handle() => Save()",
            "confidence": 0.91,
        },
        cands,
    )
    assert accepted is not None
    assert accepted["property"] == "CaseFileId"
    assert accept_shortlist_pick(
        {
            "path": path,
            "code": "WidgetCreateCommandHandler",
            "property": "InventedField",
            "evidence": "Task Handle() => Save()",
            "confidence": 0.99,
        },
        cands,
    ) is None


def test_parse_pick_field_json_plain():
    raw = '{"property":"EvidenceCode","confidence":0.91}'
    got = parse_pick_field_json(raw)
    assert got["property"] == "EvidenceCode"
    assert got["confidence"] == 0.91


def test_accept_field_shortlist_pick_ok():
    cands = ["EvidenceCode", "Name", "CaseCode"]
    pick = {"property": "EvidenceCode", "confidence": 0.88}
    got = accept_field_shortlist_pick(pick, cands)
    assert got is not None
    assert got["property"] == "EvidenceCode"


def test_accept_field_shortlist_pick_rejects_invented():
    cands = ["EvidenceCode", "Name"]
    pick = {"property": "HackField", "confidence": 0.99}
    assert accept_field_shortlist_pick(pick, cands) is None


def test_accept_field_shortlist_pick_low_confidence():
    cands = ["EvidenceCode"]
    pick = {"property": "EvidenceCode", "confidence": 0.5}
    assert accept_field_shortlist_pick(pick, cands) is None


class _FakeRequest:
    def __init__(self, body: dict):
        self._body = body

    async def json(self):
        return self._body


def _ready_conn(project_id: uuid.UUID):
    return types.SimpleNamespace(
        project_id=project_id,
        status="Ready",
        cli_type="cursor-cli",
        cli_path="agent",
        model_name=None,
    )


def _db_for(project, conn):
    class _Q:
        def __init__(self, rows):
            self._rows = rows

        def filter(self, *a, **k):
            return self

        def first(self):
            return self._rows[0] if self._rows else None

    def query(model):
        name = getattr(model, "__name__", str(model))
        if "Project" in name:
            return _Q([project])
        return _Q([conn])

    db = types.SimpleNamespace()
    db.query = query
    return db


def _payload(resp):
    if isinstance(resp, dict):
        return resp
    return json.loads(resp.body.decode())


def test_pick_unit_primary_uses_configured_cli_chat():
    project_id = uuid.uuid4()
    path = "src/App/Commands/Widget/WidgetCreateCommandHandler.cs"
    body = {
        "projectId": str(project_id),
        "requirementTitle": "Create widget",
        "module": "Create",
        "title": "Create widget happy path",
        "steps": "1. Create",
        "expectedResult": "Created",
        "candidates": [{"path": path, "code": "WidgetCreateCommandHandler", "score": 10}],
    }
    project = types.SimpleNamespace(id=project_id, deleted_at=None)
    conn = _ready_conn(project_id)
    db = _db_for(project, conn)

    with patch(
        "app.routers.agent_pick_unit.chat_for_connection",
        new=AsyncMock(
            return_value=(
                f'{{"path":"{path}","code":"WidgetCreateCommandHandler","confidence":0.92}}',
                {"runnerUsed": "AI_CLI"},
            )
        ),
    ) as chat_mock:
        resp = asyncio.run(pick_unit_primary(_FakeRequest(body), db))  # type: ignore[arg-type]

    assert chat_mock.await_count == 1
    payload = _payload(resp)
    assert payload["path"] == path
    assert payload["source"] == "llm"


def test_pick_unit_grounding_batch_uses_one_cli_call():
    project_id = uuid.uuid4()
    path = "src/App/Commands/Widget/WidgetCreateCommandHandler.cs"
    source = "public Task Handle() => Save();"
    body = {
        "projectId": str(project_id),
        "items": [
            {
                "title": f"Create widget {index}",
                "candidates": [{
                    "path": path,
                    "code": "WidgetCreateCommandHandler",
                    "symbols": ["WidgetCreateCommandHandler"],
                    "excerpt": source,
                    "properties": [{"name": "CaseFileId", "ownerPath": "src/App/WidgetCommand.cs"}],
                }],
            }
            for index in range(2)
        ],
    }
    project = types.SimpleNamespace(id=project_id, deleted_at=None)
    db = _db_for(project, _ready_conn(project_id))
    result_json = json.dumps({
        "results": [
            {
                "id": index,
                "path": path,
                "code": "WidgetCreateCommandHandler",
                "property": "CaseFileId",
                "evidence": "Task Handle() => Save()",
                "confidence": 0.91,
            }
            for index in range(2)
        ]
    })
    with patch(
        "app.routers.agent_pick_unit.chat_for_connection",
        new=AsyncMock(return_value=(result_json, {"runnerUsed": "AI_CLI"})),
    ) as chat_mock:
        resp = asyncio.run(pick_unit_grounding_batch(_FakeRequest(body), db))  # type: ignore[arg-type]
    assert chat_mock.await_count == 1
    payload = _payload(resp)
    assert len(payload["results"]) == 2
    assert all(item["property"] == "CaseFileId" for item in payload["results"])


def test_pick_unit_field_batch_accepts_numeric_string_ids():
    project_id = uuid.uuid4()
    body = {
        "projectId": str(project_id),
        "items": [
            {
                "fieldLabel": "tenVatChung",
                "inputKeys": ["tenVatChung"],
                "title": "Required evidence name",
                "candidates": [{"property": "Name"}, {"property": "EvidenceCode"}],
            },
            {
                "fieldLabel": "hoSoVuAn",
                "inputKeys": ["hoSoVuAn"],
                "title": "Case records",
                "candidates": [{"property": "CaseRecords"}, {"property": "Name"}],
            },
        ],
    }
    project = types.SimpleNamespace(id=project_id, deleted_at=None)
    db = _db_for(project, _ready_conn(project_id))
    result_json = json.dumps(
        {
            "results": [
                {"id": "0", "property": "Name", "confidence": 0.97},
                {"id": "1", "property": "CaseRecords", "confidence": 0.91},
            ]
        }
    )
    with patch(
        "app.routers.agent_pick_unit.chat_for_connection",
        new=AsyncMock(return_value=(result_json, {"runnerUsed": "AI_CLI"})),
    ) as chat_mock:
        resp = asyncio.run(pick_unit_field_batch(_FakeRequest(body), db))  # type: ignore[arg-type]

    assert chat_mock.await_count == 1
    payload = _payload(resp)
    assert [item["property"] for item in payload["results"]] == [
        "Name",
        "CaseRecords",
    ]


def test_pick_unit_field_uses_chat_for_connection():
    project_id = uuid.uuid4()
    body = {
        "projectId": str(project_id),
        "fieldLabel": "hoSoVuAn",
        "inputKeys": ["hoSoVuAn"],
        "title": "Required case records",
        "steps": "1. Leave empty",
        "primaryPath": "src/App/EvidenceCreateCommandHandler.cs",
        "candidates": ["CaseRecords", "EvidenceCode", "Name"],
    }
    project = types.SimpleNamespace(id=project_id, deleted_at=None)
    conn = _ready_conn(project_id)
    db = _db_for(project, conn)

    with patch(
        "app.routers.agent_pick_unit.chat_for_connection",
        new=AsyncMock(
            return_value=(
                '{"property":"CaseRecords","confidence":0.9}',
                {"runnerUsed": "AI_CLI"},
            )
        ),
    ) as chat_mock:
        resp = asyncio.run(pick_unit_field(_FakeRequest(body), db))  # type: ignore[arg-type]

    assert chat_mock.await_count == 1
    payload = _payload(resp)
    assert payload["property"] == "CaseRecords"
    assert payload["source"] == "llm"
