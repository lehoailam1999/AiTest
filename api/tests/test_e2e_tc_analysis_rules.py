"""E2E TC ← Phân tích — Universal E2E Test Case Generator rules + anti-duplication."""

from __future__ import annotations

from app.llm.base import GenerateContext, system_prompt, truncate
from app.llm.e2e_tc_analysis_rules import (
    E2E_TC_FROM_ANALYSIS_RULES,
    E2E_TC_FROM_ANALYSIS_RULES_FAST,
    append_e2e_tc_from_analysis_rules,
)
from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules


def test_e2e_analysis_rules_cover_universal_spec_contract():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "SoT" in text or "Output-driven" in text
    assert "trace." in text or "trace:" in text
    assert "Scenario" in text or "scenario" in text
    assert "BUSINESS_FLOWS" in text
    assert "1 TC = 1" in text or "1 journey" in text or "1 primary behavior" in text
    for label in (
        "BUSINESS_FLOWS",
        "ACCEPTANCE",
        "VALIDATION_DATA",
        "BUSINESS_RULES",
        "ACTORS_EXEC_CONTEXT",
        "ERROR_HANDLING",
        "journeyId",
        "primaryCriterion",
        "criteria",
        "authContext",
        "behaviorId",
    ):
        assert label in text, f"Missing: {label}"
    assert "Cấm" in text or "CẤM" in text


def test_e2e_analysis_rules_cross_criteria_dedup():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "Cross-criteria dedup" in text or "cross-criteria" in text.lower()
    assert "criteria[]" in text or "criteria`" in text or "gộp `criteria" in text
    assert "Business Intent" in text or "Dedup bằng" in text


def test_e2e_analysis_rules_validation_dimensions():
    text = E2E_TC_FROM_ANALYSIS_RULES
    for dim in ("Required", "Empty", "Blank", "Min", "Max", "Format", "Duplicate"):
        assert dim in text, f"Missing VALIDATION dimension: {dim}"
    assert "validation matrix" in text.lower()


def test_e2e_analysis_rules_coverage_per_behavior():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "totalBehaviors" in text
    assert "coveredBehaviors" in text
    assert "missingBehaviors" in text


def test_e2e_analysis_rules_no_invent_contract():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "HTTP status" in text or "HTTP" in text
    assert "error code" in text or "error message" in text
    assert "locator" in text.lower()
    assert "route" in text.lower()


def test_e2e_analysis_rules_one_tc_one_behavior():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "ONE TC = ONE PRIMARY BEHAVIOR" in text or "1 primary behavior" in text


def test_e2e_analysis_rules_feature_path_contract():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "featurePath" in text
    assert "path" in text


def test_e2e_analysis_rules_structured_output():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "steps" in text
    assert "expectedResult" in text
    assert "ui" in text


def test_e2e_fast_rules_keep_mandatory_classes():
    fast = E2E_TC_FROM_ANALYSIS_RULES_FAST
    assert "ACTORS_EXEC_CONTEXT" in fast
    assert "VALIDATION_DATA" in fast
    assert "ERROR_HANDLING" in fast
    assert "journeyId" in fast
    assert "primaryCriterion" in fast
    assert "criteria[]" in fast or "criteria`" in fast or "criteria[" in fast
    assert "Cross-criteria dedup" in fast or "cross-criteria" in fast.lower()
    assert "totalBehaviors" in fast


def test_e2e_rules_anti_bloat_and_no_fixed_ceiling():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "Anti-bloat" in text or "siết thừa" in text
    assert "trùng" in text.lower()
    assert "Coverage" in text


def test_append_prepares_analysis_first():
    once = append_e2e_tc_from_analysis_rules("=== PHIÊN SINH E2E ===")
    assert once.startswith("## E2E ← PHÂN TÍCH")
    assert once.index("E2E ← PHÂN TÍCH") < once.index("PHIÊN SINH E2E")
    twice = append_e2e_tc_from_analysis_rules(once)
    assert once == twice

    fast = append_e2e_tc_from_analysis_rules("overlay", speed=True)
    assert E2E_TC_FROM_ANALYSIS_RULES_FAST.strip() in fast
    assert E2E_TC_FROM_ANALYSIS_RULES.strip() not in fast


def test_engine_e2e_injects_analysis_fidelity_without_map_dup():
    full = engine_generation_rules("e2e", focus_modules="Đăng nhập", target_url="https://app.example")
    assert full.startswith("## E2E ← PHÂN TÍCH")
    assert "PHIÊN SINH E2E" in full
    assert "Đăng nhập" in full
    assert "https://app.example" in full

    fast = engine_generation_rules("e2e", speed="fast", max_per_module=5)
    assert "SPEED" in fast
    assert fast.startswith("## E2E ← PHÂN TÍCH")
    assert "≤5" in fast or "5" in fast

    uncapped = engine_generation_rules("e2e", speed="fast", max_per_module=None)
    assert "SPEED" in uncapped
    assert "Trần tùy chọn" not in uncapped
    assert "Trần mềm" not in uncapped


def test_e2e_custom_rules_fit_eng_cap():
    shared = get_tc_generation_rules(preferred_engine="e2e")
    eng = engine_generation_rules("e2e")
    custom = f"{eng}\n\n{shared}".strip()
    assert len(custom) < 12000
    kept = truncate(custom, 12000)
    assert "PHIÊN SINH E2E" in kept
    assert "E2E ← PHÂN TÍCH" in kept


def test_e2e_shared_rules_are_thin_pointers():
    e2e = get_tc_generation_rules(preferred_engine="e2e")
    assert "SoT" in e2e or "e2e_tc_analysis_rules" in e2e or "format" in e2e.lower()
    assert len(e2e) < 500


def test_system_prompt_e2e_defers_to_analysis_block():
    shared = get_tc_generation_rules(preferred_engine="e2e")
    eng = engine_generation_rules("e2e")
    p = system_prompt(
        GenerateContext(
            preferred_engine="e2e",
            custom_rules=f"{eng}\n\n{shared}",
        )
    )
    assert "PHIÊN ENGINE = E2E" in p
    assert "E2E ← PHÂN TÍCH" in p
    assert "BUSINESS_FLOWS" in p
