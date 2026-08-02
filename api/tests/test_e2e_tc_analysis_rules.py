"""E2E TC ← Phân tích Output-driven rules + anti-duplication."""

from __future__ import annotations

from app.llm.base import GenerateContext, system_prompt, truncate
from app.llm.e2e_tc_analysis_rules import (
    E2E_TC_FROM_ANALYSIS_RULES,
    E2E_TC_FROM_ANALYSIS_RULES_FAST,
    append_e2e_tc_from_analysis_rules,
)
from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules


def test_e2e_analysis_rules_cover_output_driven_contract():
    text = E2E_TC_FROM_ANALYSIS_RULES
    assert "OUTPUT COMPLETENESS" in text
    assert "SoT" in text or "nguồn #1" in text
    assert "trace:" in text
    assert "Scenario Expansion" in text or "Scenario" in text
    assert "Workflow" in text or "BUSINESS_FLOWS" in text
    for label in (
        "FEATURES",
        "BUSINESS_FLOWS",
        "BUSINESS_RULES",
        "VALIDATION",
        "ACCEPTANCE",
        "ERROR",
        "ACTORS",
        "GAPS",
    ):
        assert label in text
    assert "CẤM" in text
    assert "SRS" in text


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
    assert "trace:" in full
    assert "OUTPUT COMPLETENESS" in full
    assert "Đăng nhập" in full
    assert "https://app.example" in full
    # Overlay must NOT restate the full completeness essay.
    assert full.count("OUTPUT COMPLETENESS") == 1

    fast = engine_generation_rules("e2e", speed="fast", max_per_module=5)
    assert "SPEED" in fast
    assert fast.startswith("## E2E ← PHÂN TÍCH")
    assert "≤5" in fast or "5" in fast


def test_e2e_custom_rules_fit_eng_cap():
    shared = get_tc_generation_rules(preferred_engine="e2e")
    eng = engine_generation_rules("e2e")
    custom = f"{eng}\n\n{shared}".strip()
    assert len(custom) < 4200
    kept = truncate(custom, 4200)
    assert "OUTPUT COMPLETENESS" in kept or "COMPLETENESS" in kept
    assert "trace:" in kept
    assert "PHIÊN SINH E2E" in kept
    assert "GAPS" in kept


def test_engine_e2e_overlay_does_not_restate_sot_steps_expected():
    """Overlay keeps tags/auth/URL only — Step/Expected/Coverage live in SoT once."""
    full = engine_generation_rules("e2e")
    assert full.count("OUTPUT COMPLETENESS") == 1
    assert full.count("Step Expansion") == 1
    assert full.count("Expected Binding") == 1
    assert full.count("[Hành động]->[Element]") == 1
    # Overlay must not restate the action→element essay a second time.
    assert "element từ FLOWS" not in full
    assert "Expected chỉ assert outcome" not in full


def test_e2e_shared_rules_thinner_than_unit_compact():
    e2e = get_tc_generation_rules(preferred_engine="e2e")
    unit = get_tc_generation_rules(preferred_engine="unit")
    assert "Self-check" not in e2e
    assert "Self-check" in unit
    assert "trace:" not in e2e


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
    assert "Output-driven" in p or "OUTPUT COMPLETENESS" in p
    assert p.count("OUTPUT COMPLETENESS") == 1
    assert "trace:" in p
    # system header must not restate CẤM SRS (lives in SoT once)
    assert p.count("đọc lại SRS") <= 1
