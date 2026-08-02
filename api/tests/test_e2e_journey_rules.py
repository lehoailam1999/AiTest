"""E2E feature journey rules — prompt injection."""

from __future__ import annotations

from app.llm.e2e_journey_rules import (
    E2E_FEATURE_JOURNEY_RULES,
    e2e_journey_user_checklist,
)


def test_journey_rules_cover_phases_and_non_happy():
    text = E2E_FEATURE_JOURNEY_RULES
    assert "FEATURE ENTRY" in text or "Feature entry" in text
    assert "Spec skeleton" in text or "test.step('1." in text
    assert "Anti-patterns" in text or "invent" in text.lower()
    assert "Validation" in text or "BOUNDARY" in text or "Boundary" in text or "E2ECG" in text
    assert "landmark" in text.lower()
    assert "E2E_FEATURE_PATH" in text or "menu" in text.lower()
    # Auth/locator essays belong in E2ECG — journey must not restate them.
    assert "selectOption({ label: RegExp })" not in text
    assert "LOCATOR RESOLUTION" not in text


def test_journey_checklist_flags_validation_tc():
    out = e2e_journey_user_checklist(
        test_case_title="Không chấp nhận khoảng trắng",
        test_case_type="E2E-Validation",
        steps="Nhap whitespace",
        expected_result="Khong chap nhan",
        precondition="Mo popup Tao moi vat chung",
    )
    assert "Feature entry" in out or "feature entry" in out.lower()
    assert "VALIDATION" in out or "BOUNDARY" in out
    assert "dialog" in out.lower() or "Create" in out or "Arrange" in out
    assert "Execution Context resolved" not in out  # auth/context not duplicated here
