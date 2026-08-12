from __future__ import annotations

from types import SimpleNamespace

from app.routers.testcases import (
    _split_e2e_readiness_issues,
    _validate_e2e_approve_readiness,
)


def _sample_tc(**overrides):
    base = dict(
        test_case_code="TC-101",
        title="E2E checkout negative duplicate",
        module="Checkout",
        type="E2E",
        priority="High",
        severity="Major",
        precondition="User logged in as role: Investigator; Requirement: BR-01",
        steps=(
            "1. NAVIGATE Target: Checkout page Expected: Page is visible\n"
            "2. INPUT Target: Evidence code Value: EVD-EXIST-001 Expected: Field updated\n"
            "3. SUBMIT Target: Save button Expected: Duplicate error message shown\n"
            "4. ASSERT Target: Error banner Expected: Không tạo dữ liệu mới"
        ),
        expected_result="Error message is shown and no new record is created.",
        test_data=(
            "baseURL: http://localhost:3000\n"
            "path: /checkout/create\n"
            "authRequired: true\n"
            "authRole: Investigator\n"
            "scenarioType: Negative\n"
            "ruleRef: BR-01\n"
            "evidenceCode: EVD-EXIST-001"
        ),
    )
    base.update(overrides)
    return SimpleNamespace(**base)


def test_e2e_ready_passes_with_complete_semantic_content():
    tc = _sample_tc()
    issues = _validate_e2e_approve_readiness(tc)  # type: ignore[arg-type]
    assert issues == []


def test_e2e_ready_blocks_when_missing_context_and_vague_step():
    tc = _sample_tc(
        steps="1. Kiểm tra\n2. Tiếp tục",
        test_data="authRole: Admin\n[MISSING CONTEXT] thiếu path",
    )
    issues = _validate_e2e_approve_readiness(tc)  # type: ignore[arg-type]
    text = " | ".join(issues)
    assert "E2E Context thiếu path/route/featurePath" in text
    assert "placeholder [MISSING CONTEXT]" in text
    assert "Step mơ hồ" in text


def test_e2e_ready_blocks_locator_leak_in_testcase():
    tc = _sample_tc(
        steps="1. CLICK Target: page.locator('#save-btn') Expected: submit",
    )
    issues = _validate_e2e_approve_readiness(tc)  # type: ignore[arg-type]
    assert any("locator kỹ thuật" in row for row in issues)


def test_split_readiness_issues_critical_vs_soft():
    critical, soft = _split_e2e_readiness_issues(
        [
            "Business Context thiếu Actor/Role",
            "E2E Context thiếu path/route/featurePath",
            "Steps thiếu action chuẩn NAVIGATE|INPUT|SELECT|CHECK|CLICK|SUBMIT|WAIT|ASSERT",
            "Còn placeholder [MISSING CONTEXT]/[Thiếu Context]",
            "Step mơ hồ: 'Kiểm tra'",
        ]
    )
    assert not any("Steps thiếu action chuẩn" in row for row in critical)
    assert any("Steps thiếu action chuẩn" in row for row in soft)
    assert any("placeholder [MISSING CONTEXT]" in row for row in soft)
    assert any("Business Context thiếu Actor/Role" in row for row in soft)
    assert any("Step mơ hồ" in row for row in critical)

