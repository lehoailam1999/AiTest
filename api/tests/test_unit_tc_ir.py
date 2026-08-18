"""Unit TC IR flatten — portable adapter tests."""

from __future__ import annotations

from app.llm.base import parse_test_cases_json
from app.llm.unit_tc_ir import flatten_unit_tc_ir, looks_like_unit_tc_ir


def test_looks_like_ir_and_flattens_portable_markers():
    ir = {
        "title": "[Tạo mới vật chứng] - Từ chối tên vượt quá giới hạn ký tự",
        "type": "Unit",
        "primaryBucket": "VALIDATION_DATA",
        "scenario": "BOUNDARY",
        "trace": {"requirementIds": ["VAL-25"], "behaviorId": "VAL-25-B04"},
        "preconditions": [],
        "testData": {
            "input": {"name": "x" * 10},
            "target": {
                "field": "Tên",
                "constraint": "maxLength",
                "boundary": "N+1",
                "value": "N+1 characters",
            },
            "existingState": {},
        },
        "steps": {
            "prepare": ["Chuẩn bị tên dài hơn giới hạn Knowledge"],
            "execute": ["Thực hiện tạo mới"],
        },
        "expectedResult": {
            "type": "REJECT",
            "observable": "create operation",
            "description": "Từ chối vì vượt giới hạn độ dài",
        },
        "testDataHints": {"layerHint": None, "sourceSignal": None},
        "status": "READY_FOR_CODEGEN",
        "priority": "Cao",
        "severity": "Nặng",
    }
    assert looks_like_unit_tc_ir(ir)
    flat = flatten_unit_tc_ir(ir)
    assert "1. Chuẩn bị" in flat["steps"]
    assert "2. Thực hiện" in flat["steps"]
    assert "REJECT" in flat["expectedResult"]
    td = flat["testData"]
    assert "primaryBucket: VALIDATION_DATA" in td
    assert "behaviorId: VAL-25-B04" in td
    assert "target.constraint: maxLength" in td
    assert "trace: VALIDATION_DATA/VAL-25" in td
    assert "target.field: Tên" in td
    assert "target.property:" not in td
    assert "status: READY_FOR_GROUNDING" in td
    assert "READY_FOR_CODEGEN" not in td
    assert flat["automationReady"] is False
    assert "sourceSignal:" not in td


def test_parse_test_cases_json_accepts_ir_wrapper():
    raw = """
    {
      "testCases": [{
        "title": "[Feature] - Từ chối mã trùng",
        "type": "Unit",
        "primaryBucket": "BUSINESS_RULES",
        "scenario": "DUPLICATE",
        "trace": {"requirementIds": ["BR-1"], "behaviorId": "BR-1-B01"},
        "preconditions": ["Mã CODE-1 đã tồn tại"],
        "testData": {
          "input": {"code": "CODE-1"},
          "target": {"field": "code", "constraint": "unique", "boundary": "", "value": "CODE-1"},
          "existingState": {"code": "CODE-1"}
        },
        "steps": {
          "prepare": ["Chuẩn bị bản ghi mã đã tồn tại"],
          "execute": ["Thực hiện tạo mới với cùng mã"]
        },
        "expectedResult": {
          "type": "REJECT",
          "observable": "create operation",
          "description": "Không cho phép mã trùng"
        },
        "testDataHints": {"layerHint": null, "sourceSignal": null},
        "status": "READY_FOR_CODEGEN",
        "priority": "Cao",
        "severity": "Nặng"
      }],
      "coverage": {"BUSINESS_RULES": {"totalBehaviors": 1, "coveredBehaviors": 1, "missingBehaviors": 0}},
      "gaps": [],
      "unknownBehaviors": [],
      "conflicts": []
    }
    """
    drafts = parse_test_cases_json(raw)
    assert len(drafts) == 1
    d = drafts[0]
    assert d.title.startswith("[Feature]")
    assert "behaviorId: BR-1-B01" in (d.test_data or "")
    assert "primaryBucket: BUSINESS_RULES" in (d.test_data or "")
    assert "Mã CODE-1 đã tồn tại" in (d.precondition or "")
    assert d.type == "Unit" or "Unit" in str(d.type)
    assert "status: READY_FOR_GROUNDING" in (d.test_data or "")
    assert d.automation_ready is False


def test_legacy_flat_tc_still_parses():
    raw = """
    {"testCases":[{
      "title":"[Feature] - Hành động BE - Kết quả",
      "type":"Unit",
      "module":"Feature",
      "steps":"1. Chuẩn bị\\n2. Thực hiện\\n3. Assert",
      "expectedResult":"Kết quả đúng",
      "testData":"trace: BUSINESS_RULES/BR-1",
      "priority":"Cao","severity":"Nặng","automationReady":true
    }]}
    """
    drafts = parse_test_cases_json(raw)
    assert len(drafts) == 1
    assert "trace: BUSINESS_RULES/BR-1" in (drafts[0].test_data or "")
