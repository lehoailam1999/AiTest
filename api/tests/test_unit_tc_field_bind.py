"""Unit TC field bind + IR readiness — portable gates."""

from __future__ import annotations

from app.services.unit_tc_field_bind import bind_unit_tc_field
from app.services.unit_tc_ir_ready import (
    apply_unit_tc_ir_readiness,
    decide_unit_tc_ir_ready,
    decide_unit_tc_markers_ready,
)
from app.services.unit_tc_gen_guard import apply_unit_tc_readiness_to_draft
from types import SimpleNamespace


def test_bind_latin_field_sets_property():
    ir = {
        "primaryBucket": "VALIDATION_DATA",
        "trace": {"requirementIds": ["VAL-1"], "behaviorId": "VAL-1-B01"},
        "testData": {
            "input": {"SeizureLocation": ""},
            "target": {"field": "SeizureLocation", "constraint": "required"},
        },
        "expectedResult": {
            "type": "REJECT",
            "observable": "validate",
            "description": "Reject empty location",
        },
        "steps": {"prepare": ["Arrange"], "execute": ["Act"]},
        "status": "READY_FOR_CODEGEN",
    }
    out, reasons = bind_unit_tc_field(ir)
    assert not reasons
    assert out["testData"]["target"]["property"] == "SeizureLocation"
    hints = out.get("testDataHints") or {}
    assert hints.get("layerHint") == "dto"
    assert "SeizureLocation" in str(hints.get("sourceSignal"))


def test_bind_vi_input_without_property_not_ready():
    ir = {
        "primaryBucket": "VALIDATION_DATA",
        "trace": {"requirementIds": ["VAL-1"], "behaviorId": "VAL-1-B01"},
        "testData": {
            "input": {"diaDiemThuGiu": ""},
            "target": {"field": "Địa điểm thu giữ", "constraint": "required"},
        },
        "expectedResult": {
            "type": "REJECT",
            "observable": "validate",
            "description": "Reject",
        },
        "steps": {"prepare": ["A"], "execute": ["B"]},
    }
    out, reasons = bind_unit_tc_field(ir)
    assert "FAIL_FIELD_UNBOUND" in reasons or "FAIL_INPUT_PROPERTY_MISMATCH" in reasons


def test_bind_remaps_single_vi_key_with_alias():
    ir = {
        "primaryBucket": "VALIDATION_DATA",
        "trace": {"behaviorId": "VAL-1-B01"},
        "testData": {
            "input": {"diaDiemThuGiu": ""},
            "target": {"field": "Địa điểm thu giữ", "constraint": "required"},
        },
        "expectedResult": {"observable": "validate", "description": "x"},
        "steps": {"execute": ["act"]},
    }
    aliases = {"Địa điểm thu giữ": ["SeizureLocation"]}
    out, reasons = bind_unit_tc_field(ir, field_aliases=aliases)
    assert not reasons
    assert out["testData"]["input"] == {"SeizureLocation": ""}


def test_ir_ready_downgrades_incomplete_validation():
    ir = {
        "primaryBucket": "VALIDATION_DATA",
        "trace": {"behaviorId": "BR-12-B01"},
        "testData": {
            "input": {},
            "target": {"field": "[Chưa xác định trong Knowledge]", "constraint": "required"},
        },
        "expectedResult": {"observable": "validate", "description": "x"},
        "steps": {"execute": ["act"]},
        "status": "READY_FOR_CODEGEN",
    }
    apply_unit_tc_ir_readiness(ir)
    assert ir["status"] == "NOT_READY"
    assert ir["automationReady"] is False
    assert ir["_irReadyRefuse"]


def test_ir_ready_accepts_complete_br():
    ir = {
        "primaryBucket": "BUSINESS_RULES",
        "trace": {"requirementIds": ["BR-1"], "behaviorId": "BR-1-B01"},
        "testData": {"input": {"code": "X"}},
        "expectedResult": {
            "observable": "reject",
            "description": "Duplicate code rejected",
        },
        "steps": {"execute": ["Create with duplicate"]},
    }
    ready, reasons = decide_unit_tc_ir_ready(ir)
    assert ready is True
    assert not reasons


def test_markers_ready_blocks_placeholder_field():
    td = (
        "primaryBucket: VALIDATION_DATA\n"
        "behaviorId: BR-12-B01\n"
        "target.field: [Chưa xác định trong Knowledge]\n"
        "target.constraint: required\n"
        "status: READY_FOR_CODEGEN\n"
    )
    ready, reasons = decide_unit_tc_markers_ready(test_data=td)
    assert ready is False
    assert "FAIL_FIELD_PLACEHOLDER" in reasons


def test_apply_readiness_to_draft_downgrades():
    d = SimpleNamespace(
        title="TC",
        steps="1. Act",
        expected_result="REJECT",
        test_data=(
            "primaryBucket: VALIDATION_DATA\n"
            "target.field: [Chưa xác định]\n"
            "target.constraint: required\n"
            "status: READY_FOR_CODEGEN"
        ),
        automation_ready=True,
    )
    changed = apply_unit_tc_readiness_to_draft(d)
    assert changed is True
    assert d.automation_ready is False
    assert "status: NOT_READY" in d.test_data
