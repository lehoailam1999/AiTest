"""Tests for grounded pick-unit-primary / pick-unit-field helpers."""

from __future__ import annotations

from app.routers.agent_pick_unit import (
    accept_field_shortlist_pick,
    accept_shortlist_pick,
    parse_pick_field_json,
    parse_pick_unit_json,
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
