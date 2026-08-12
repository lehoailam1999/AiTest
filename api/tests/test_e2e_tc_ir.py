"""E2E TC IR flatten — Universal spec aligned adapter tests."""

from __future__ import annotations

from app.llm.base import parse_test_cases_json
from app.llm.e2e_tc_ir import build_e2e_ir_test_data, flatten_e2e_tc_ir, looks_like_e2e_tc_ir


def test_looks_like_e2e_ir_detects_new_spec_fields():
    assert looks_like_e2e_tc_ir({"primaryCriterion": "BUSINESS_FLOWS"})
    assert looks_like_e2e_tc_ir({"criteria": ["BUSINESS_FLOWS", "ACCEPTANCE"]})
    assert looks_like_e2e_tc_ir({"primaryBucket": "BUSINESS_FLOWS"})
    assert not looks_like_e2e_tc_ir({"title": "plain"})


def test_flatten_with_primaryCriterion_and_criteria():
    ir = {
        "title": "[Tạo mới vật chứng] - Nhập mã đã tồn tại - Từ chối tạo",
        "type": "E2E",
        "primaryCriterion": "BUSINESS_FLOWS",
        "criteria": ["BUSINESS_FLOWS", "BUSINESS_RULES", "ERROR_HANDLING"],
        "scenario": "EXCEPTION_FLOW",
        "trace": {
            "requirementIds": ["FLOW-01", "BR-25", "ERR-01"],
            "journeyId": "FLOW-01-J03",
            "behaviorId": "DUPLICATE-EVIDENCE-CODE",
        },
        "authContext": {"authRequired": True, "authRole": None, "multiRole": False},
        "featurePath": "/evidence/create",
        "preconditions": ["Đã đăng nhập"],
        "testData": {
            "field": "Mã vật chứng",
            "value": "EV001",
            "constraint": "Mã phải duy nhất",
            "boundary": None,
            "existingState": "EV001 already exists",
        },
        "steps": [
            {"phase": "Prepare", "action": "Mở form tạo vật chứng", "target": "Form tạo mới", "data": None},
            {"phase": "Execute", "action": "Nhập mã EV001 đã tồn tại", "target": "Trường Mã vật chứng", "data": "EV001"},
            {"phase": "Execute", "action": "Bấm Lưu", "target": "Nút Lưu", "data": None},
        ],
        "expectedResult": {
            "ui": ["Hiển thị trạng thái lỗi trùng mã"],
            "system": ["Không cho phép tạo vật chứng có mã đã tồn tại"],
            "data": ["Không phát sinh vật chứng mới"],
        },
        "testDataHints": {"landmark": "Form tạo vật chứng", "sourceSignal": None},
        "status": "READY_FOR_GROUNDING",
    }
    flat = flatten_e2e_tc_ir(ir)
    td = flat["testData"]
    assert "primaryCriterion: BUSINESS_FLOWS" in td
    assert "criteria: BUSINESS_FLOWS,BUSINESS_RULES,ERROR_HANDLING" in td
    assert "journeyId: FLOW-01-J03" in td
    assert "behaviorId: DUPLICATE-EVIDENCE-CODE" in td
    assert "requirementIds: FLOW-01, BR-25, ERR-01" in td
    assert "scenario: EXCEPTION_FLOW" in td
    assert "authRequired: true" in td
    assert "featurePath: /evidence/create" in td
    assert "field: Mã vật chứng" in td
    assert "value: EV001" in td
    assert "constraint: Mã phải duy nhất" in td
    assert "existingState: EV001 already exists" in td
    assert "landmark: Form tạo vật chứng" in td

    assert "1. [Prepare] Mở form tạo vật chứng" in flat["steps"]
    assert "2. [Execute] Nhập mã EV001" in flat["steps"]
    assert "3. [Execute] Bấm Lưu" in flat["steps"]

    assert "UI: Hiển thị trạng thái lỗi trùng mã" in flat["expectedResult"]
    assert "System:" in flat["expectedResult"]
    assert "Data:" in flat["expectedResult"]


def test_backward_compat_primaryBucket_input():
    ir = {
        "title": "[Test] - Action - Result",
        "type": "E2E",
        "primaryBucket": "ACCEPTANCE",
        "scenario": "HAPPY_PATH",
        "trace": {"requirementIds": ["AC-01"], "journeyId": "AC-01-J01"},
        "authContext": {"authRequired": False},
        "steps": ["Step 1"],
        "expectedResult": {"type": "SUCCESS", "description": "OK"},
    }
    flat = flatten_e2e_tc_ir(ir)
    td = flat["testData"]
    assert "primaryCriterion: ACCEPTANCE" in td
    assert "journeyId: AC-01-J01" in td


def test_legacy_flat_tc_passthrough():
    tc = {
        "title": "[Login] - Đăng nhập - Thành công",
        "type": "E2E",
        "steps": "1. Nhập username\n2. Nhập password\n3. Bấm Login",
        "expectedResult": "Đăng nhập thành công",
        "testData": "username: admin",
    }
    assert not looks_like_e2e_tc_ir(tc)
    flat = flatten_e2e_tc_ir(tc)
    assert flat["steps"] == tc["steps"]
    assert flat["expectedResult"] == tc["expectedResult"]


def test_parse_test_cases_json_accepts_new_spec_format():
    raw = """
    {
      "testCases": [{
        "title": "[Phân quyền] - Từ chối truy cập khi không có quyền Admin",
        "type": "E2E",
        "primaryCriterion": "ACTORS_EXEC_CONTEXT",
        "criteria": ["ACTORS_EXEC_CONTEXT", "ERROR_HANDLING"],
        "scenario": "PERMISSION_DENY",
        "trace": {"requirementIds": ["BR-AUTH-1"], "journeyId": "BR-AUTH-1-J01", "behaviorId": "DENY-ADMIN-ACCESS"},
        "authContext": {"authRequired": true, "authRole": "User", "multiRole": false},
        "featurePath": "/admin/settings",
        "preconditions": ["Đã đăng nhập tài khoản User thường"],
        "testData": {
          "field": "",
          "value": "",
          "constraint": "",
          "boundary": null,
          "existingState": ""
        },
        "steps": [
          {"phase": "Execute", "action": "Truy cập trang cài đặt", "target": "/admin/settings", "data": null}
        ],
        "expectedResult": {
          "ui": ["Thông báo không có quyền truy cập"],
          "system": ["Chặn truy cập trang quản trị"],
          "data": []
        },
        "testDataHints": {"landmark": "Trang 403", "sourceSignal": null},
        "status": "READY_FOR_GROUNDING",
        "priority": "Nghiêm trọng",
        "severity": "Nghiêm trọng"
      }],
      "coverage": {"ACTORS_EXEC_CONTEXT": {"totalBehaviors": 1, "coveredBehaviors": 1, "missingBehaviors": 0}},
      "gaps": [],
      "unknownBehaviors": [],
      "conflicts": []
    }
    """
    drafts = parse_test_cases_json(raw)
    assert len(drafts) == 1
    d = drafts[0]
    assert d.title.startswith("[Phân quyền]")
    td = d.test_data or ""
    assert "primaryCriterion: ACTORS_EXEC_CONTEXT" in td
    assert "criteria: ACTORS_EXEC_CONTEXT,ERROR_HANDLING" in td
    assert "journeyId: BR-AUTH-1-J01" in td
    assert "behaviorId: DENY-ADMIN-ACCESS" in td
    assert "authRole: User" in td
    assert d.type == "E2E" or "E2E" in str(d.type)


def test_parse_test_cases_json_backward_compat_primaryBucket():
    raw = """
    {
      "testCases": [{
        "title": "[Test] - Action - Result",
        "type": "E2E",
        "primaryBucket": "BUSINESS_FLOWS",
        "scenario": "HAPPY_PATH",
        "trace": {"requirementIds": ["FLOW-01"], "journeyId": "FLOW-01-J01"},
        "authContext": {"authRequired": false},
        "steps": ["1. Do something"],
        "expectedResult": {"type": "SUCCESS", "description": "Done"},
        "priority": "Cao",
        "severity": "Nặng"
      }]
    }
    """
    drafts = parse_test_cases_json(raw)
    assert len(drafts) == 1
    assert "primaryCriterion: BUSINESS_FLOWS" in (drafts[0].test_data or "")
