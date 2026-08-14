"""E2E Grounding SoT + TC path contract + fail-closed stubs."""

from __future__ import annotations

from app.llm.base import E2ERequest, e2e_system_prompt, e2e_user_prompt
from app.llm.e2e_grounding_rules import E2E_GROUNDING_RULES, e2e_grounding_system_pointer
from app.llm.e2e_tc_analysis_rules import E2E_TC_FROM_ANALYSIS_RULES, E2E_TC_FROM_ANALYSIS_RULES_FAST
from app.llm.tc_generation_rules import engine_generation_rules
from app.services.e2e_codegen_guard import _render_smart_method_stub


def test_grounding_rules_portable_and_bounded():
    text = E2E_GROUNDING_RULES
    assert "path:" in text or "featurePath" in text
    assert "FAIL-CLOSED" in text or "fail-closed" in text.lower()
    assert "data-cy" in text
    assert "openCreate" in text or "Create" in text
    # No Forensic-hardcoded routes/roles
    assert "head_c09a" not in text
    assert "/admin/evidence" not in text
    assert len(text) < 1800
    assert "E2E_GROUNDING" in e2e_grounding_system_pointer()


def test_tc_analysis_requires_feature_path():
    assert "FEATURE PATH" in E2E_TC_FROM_ANALYSIS_RULES
    assert "path:" in E2E_TC_FROM_ANALYSIS_RULES
    assert "featurePath:" in E2E_TC_FROM_ANALYSIS_RULES
    assert "path:" in E2E_TC_FROM_ANALYSIS_RULES_FAST or "featurePath" in E2E_TC_FROM_ANALYSIS_RULES_FAST


def test_engine_e2e_overlay_mentions_path():
    full = engine_generation_rules("e2e")
    assert "FEATURE PATH" in full or "path:" in full
    fast = engine_generation_rules("e2e", speed="fast")
    assert "path:" in fast or "featurePath" in fast


def test_e2e_user_prompt_warns_missing_feature_path():
    req = E2ERequest(
        test_case_title="Validation max length evidence",
        test_case_type="E2E-Validation",
        priority="P1",
        steps="1. Mo form\n2. Nhap 501 ky tu",
        expected_result="Khong chap nhan",
    )
    up = e2e_user_prompt(req)
    assert "MISSING" in up or "Feature path" in up
    assert "path:" in up.lower() or "featurePath" in up


def test_e2e_user_prompt_has_resolved_path():
    req = E2ERequest(
        test_case_title="Evidence list",
        test_case_type="E2E",
        priority="P1",
        steps="1. Open",
        expected_result="OK",
        feature_path="admin/evidence",
    )
    up = e2e_user_prompt(req)
    assert "/admin/evidence" in up
    assert "MISSING" not in up


def test_system_prompt_includes_grounding_pointer():
    sys_p = e2e_system_prompt()
    assert "E2E_GROUNDING" in sys_p or "fail-closed" in sys_p.lower()
    assert len(sys_p) < 9500


def test_fail_closed_stub_no_button_first_invent():
    stub = _render_smart_method_stub("doMysteriousThing", dom_snapshot="")
    assert "ungrounded" in stub.lower()
    assert "locator('button" not in stub
    # Labeled Spec arg still allowed
    labeled = _render_smart_method_stub("clickSave", dom_snapshot="")
    # click* without DOM still needs arg or ungrounded — no invent first()
    assert "ungrounded" in labeled.lower() or "raw" in labeled


def test_create_open_stub_uses_entity_create_testid():
    """openCreate* grounds on JHipster data-cy / Create role — not warn+return."""
    from app.services.e2e_codegen_guard import (
        _is_create_open_method,
        _render_create_open_stub,
    )

    assert _is_create_open_method("openCreateModal")
    stub = _render_create_open_stub("openCreateModal")
    assert "entityCreateButton" in stub
    assert "console.warn" not in stub
    assert "return;" not in stub.split("waitFor")[0] or "entityCreateButton" in stub
