from __future__ import annotations

from types import SimpleNamespace

from app.routers.testcases import (
    _split_e2e_readiness_issues,
    _validate_e2e_approve_readiness,
)
from app.services.e2e_tc_pre_approve_enrich import (
    enrich_e2e_tc_before_approve,
    infer_e2e_route_path,
    infer_scenario_type,
    is_usable_feature_path,
    normalize_e2e_steps,
    normalize_feature_path,
    strip_missing_context_markers,
)


def _tc(**overrides):
    base = dict(
        test_case_code="TC-201",
        title="Tạo vật chứng trùng mã — phủ định",
        module="evidence-create",
        type="E2E",
        priority="High",
        severity="Major",
        precondition="User logged in as role: Investigator; Requirement: BR-01",
        steps=(
            "1. Mở trang /evidence/create\n"
            "2. Nhập mã vật chứng EVD-EXIST-001\n"
            "3. Nhấn nút Lưu\n"
            "4. Kiểm tra thông báo lỗi"
        ),
        expected_result="Hiện lỗi trùng mã, không tạo dữ liệu mới",
        test_data="evidenceCode: EVD-EXIST-001\n[MISSING CONTEXT] thiếu path",
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_infer_route_from_inline_ascii_path():
    tc = _tc()
    assert infer_e2e_route_path(tc) == "/evidence/create"


def test_infer_rejects_module_slug_and_vn_path():
    tc = _tc(steps="1. Mở trang", test_data="", module="Tạo mới vật chứng")
    assert infer_e2e_route_path(tc) is None
    assert not is_usable_feature_path("/tạo-mới-vật-chứng")
    assert not is_usable_feature_path("/BR-4")
    assert not is_usable_feature_path("/FR-12")
    assert normalize_feature_path("http://localhost:4200") is None
    assert normalize_feature_path("http://localhost:4200/admin/evidence/new") == "/admin/evidence/new"
    assert infer_e2e_route_path(
        _tc(steps="1. Hoàn tất", test_data="trace: BR/BR-4\npath: /BR-4", module="Tạo mới vật chứng")
    ) is None


def test_infer_scenario_negative_from_title():
    tc = _tc()
    assert infer_scenario_type(tc) == "Negative"


def test_normalize_vietnamese_steps_to_standard_actions():
    steps = (
        "1. Mở trang tạo vật chứng\n"
        "2. Nhập mã vật chứng EVD-EXIST-001\n"
        "3. Nhấn nút Lưu\n"
        "4. Kiểm tra thông báo lỗi"
    )
    out = normalize_e2e_steps(steps, "Lỗi trùng mã")
    assert "NAVIGATE Target:" in out
    assert "INPUT Target:" in out
    assert "SUBMIT Target:" in out or "CLICK Target:" in out
    assert "ASSERT Target:" in out


def test_strip_missing_context_markers():
    raw = "path: /x\n[MISSING CONTEXT] thiếu auth\nauthRole: Admin"
    cleaned = strip_missing_context_markers(raw)
    assert "[MISSING CONTEXT]" not in cleaned
    assert "path: /x" in cleaned


def test_enrich_fills_path_auth_scenario_and_normalizes_steps():
    tc = _tc()
    changed = enrich_e2e_tc_before_approve(tc)
    assert changed is True
    assert "path: /evidence/create" in tc.test_data
    assert "authRole: Investigator" in tc.test_data
    assert "authRequired: true" in tc.test_data
    assert "scenarioType: Negative" in tc.test_data
    assert "ruleRef: BR-01" in tc.test_data
    assert "postcondition:" in tc.test_data
    assert "[MISSING CONTEXT]" not in tc.test_data
    assert "NAVIGATE Target:" in tc.steps


def test_thin_e2e_can_approve_after_enrich_with_only_soft_gaps():
    tc = _tc()
    enrich_e2e_tc_before_approve(tc)
    issues = _validate_e2e_approve_readiness(tc)  # type: ignore[arg-type]
    critical, soft = _split_e2e_readiness_issues(issues)
    assert not critical
    assert not any("[MISSING CONTEXT]" in i for i in issues)
    assert not any("Step mơ hồ" in i for i in issues)


def test_enrich_strips_dor_thieu_context_when_usable_path():
    tc = _tc(
        precondition="Đã đăng nhập hệ thống",
        test_data="path: /admin/evidence/new\nevidenceCode: EVD-1\n[Thiếu Context] thiếu path",
    )
    enrich_e2e_tc_before_approve(tc)
    assert "[Thiếu Context]" not in (tc.test_data or "")
    assert "path: /admin/evidence/new" in (tc.test_data or "")
    assert "authRequired: true" in (tc.test_data or "")
    issues = _validate_e2e_approve_readiness(tc)  # type: ignore[arg-type]
    critical, _soft = _split_e2e_readiness_issues(issues)
    assert not critical


def test_enrich_keeps_thieu_context_when_no_usable_path():
    tc = _tc(
        steps="1. Nhấn nút Lưu",
        test_data="[Thiếu Context] thiếu path",
        module="Tạo mới vật chứng",
    )
    enrich_e2e_tc_before_approve(tc)
    assert "[Thiếu Context]" in (tc.test_data or "")
    assert "path:" not in (tc.test_data or "") or "/tạo" not in (tc.test_data or "").lower()


def test_enrich_rejects_baseurl_as_path_and_replaces_placeholder():
    tc = _tc(
        steps="1. Nhấn nút Lưu",
        test_data="path: http://localhost:4200\nauthRole: Investigator",
    )
    enrich_e2e_tc_before_approve(tc)
    assert "path: http://localhost:4200" not in (tc.test_data or "")
    # no invent from module when no usable route in text
    assert "/evidence-create" not in (tc.test_data or "")


def test_enrich_replaces_path_placeholder_kv_with_inline_route():
    tc = _tc(
        test_data="path: [Thiếu Context]\nauthRole: Investigator",
        steps="1. Mở /admin/evidence/new\n2. Nhấn Lưu",
    )
    enrich_e2e_tc_before_approve(tc)
    assert "[Thiếu Context]" not in (tc.test_data or "")
    assert "path: /admin/evidence/new" in (tc.test_data or "")
    assert "authRole: Investigator" in (tc.test_data or "")


def test_split_treats_missing_standard_action_as_soft():
    critical, soft = _split_e2e_readiness_issues(
        [
            "Steps thiếu action chuẩn NAVIGATE|INPUT|SELECT|CHECK|CLICK|SUBMIT|WAIT|ASSERT",
            "Còn placeholder [MISSING CONTEXT]/[Thiếu Context]",
        ]
    )
    assert not any("Steps thiếu action chuẩn" in row for row in critical)
    assert any("Steps thiếu action chuẩn" in row for row in soft)
    assert any("placeholder [MISSING CONTEXT]" in row for row in soft)
    assert not critical
