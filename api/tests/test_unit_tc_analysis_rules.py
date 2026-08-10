"""Unit TC ← Phân tích fidelity rules (ISTQB / ISO 29119) + anti-duplication."""

from __future__ import annotations

from app.llm.base import GenerateContext, system_prompt, truncate
from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules
from app.llm.unit_tc_analysis_rules import (
    UNIT_TC_FROM_ANALYSIS_RULES,
    UNIT_TC_FROM_ANALYSIS_RULES_FAST,
    append_unit_tc_from_analysis_rules,
)


def test_unit_analysis_rules_cover_eleven_buckets_and_trace():
    text = UNIT_TC_FROM_ANALYSIS_RULES
    for label in (
        "SUMMARY_SCOPE",
        "FEATURES",
        "ACTORS",
        "BUSINESS_FLOWS",
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "API_UI",
        "ERROR_HANDLING",
        "ACCEPTANCE",
        "NFR",
        "GAPS",
        "EXECUTION_CONTEXT",
    ):
        assert label in text
    assert "ACTORS_PERMISSIONS" in text
    assert "NFR_CONSTRAINTS" in text
    assert "trace:" in text
    assert "ISTQB" in text
    assert "29119" in text
    assert "BACKEND" in text.upper() or "backend" in text
    assert "Decision Table" in text
    assert "coverage gate" in text.lower() or "Coverage gate" in text or "itemCount" in text
    assert "1 tổ hợp" in text or "tổ hợp" in text
    assert "negative" in text.lower() or "từ chối" in text
    for ban in ("form", "popup", "wizard", "Bước"):
        assert ban.lower() in text.lower() or ban in text
    assert "ClientApp" in text or "*.component" in text
    assert "invent" in text.lower() or "bịa" in text or "cấm" in text.lower()
    assert "CQRS" in text or "Handler" in text
    assert "HTTP" in text or "200" in text


def test_unit_analysis_fast_covers_br_validation_authz():
    fast = UNIT_TC_FROM_ANALYSIS_RULES_FAST
    assert "BR" in fast or "BUSINESS" in fast.upper()
    assert "VALIDATION" in fast.upper()
    assert "ERROR" in fast.upper()
    assert "authz" in fast.lower() or "EXEC_CONTEXT" in fast or "ACTORS" in fast
    assert "trace:" in fast
    assert "wizard" in fast.lower() or "popup" in fast.lower() or "Bước" in fast
    assert "ClientApp" in fast or "component" in fast.lower()
    assert "invent" in fast.lower() or "bịa" in fast or "VI" in fast


def test_unit_rules_backend_only_in_engine_and_shared():
    eng = engine_generation_rules("unit")
    assert "BACKEND" in eng.upper()
    assert "popup" in eng.lower() or "wizard" in eng.lower()
    assert "portable" in eng.lower() or "mọi stack" in eng.lower() or "SUT" in eng
    shared = get_tc_generation_rules(preferred_engine="unit")
    assert "BACKEND" in shared.upper()
    assert "PORTABLE" in shared.upper() or "Hành động BE" in shared
    fast = engine_generation_rules("unit", speed="fast")
    assert "backend" in fast.lower() or "BACKEND" in fast
    assert "wizard" in fast.lower() or "popup" in fast.lower() or "Bước" in fast


def test_append_prepares_analysis_first():
    once = append_unit_tc_from_analysis_rules("=== PHIÊN SINH UNIT ===")
    assert once.startswith("## UNIT ← PHÂN TÍCH")
    assert once.index("UNIT ← PHÂN TÍCH") < once.index("PHIÊN SINH UNIT")
    twice = append_unit_tc_from_analysis_rules(once)
    assert once == twice

    fast = append_unit_tc_from_analysis_rules("overlay", speed=True)
    assert UNIT_TC_FROM_ANALYSIS_RULES_FAST.strip() in fast
    assert UNIT_TC_FROM_ANALYSIS_RULES.strip() not in fast


def test_engine_unit_injects_analysis_fidelity_without_map_dup():
    full = engine_generation_rules("unit", focus_modules="AuthService")
    assert full.startswith("## UNIT ← PHÂN TÍCH")
    assert "PHIÊN SINH UNIT" in full
    assert "trace:" in full
    assert "AuthService" in full
    # Overlay must NOT restate the full bucket essay (single source).
    assert full.count("Decision Table") <= 1
    assert full.count("NGUỒN") <= 1 or "nguồn #1" in full.lower()

    fast = engine_generation_rules("unit", speed="fast", max_per_module=5)
    assert "SPEED" in fast
    assert fast.startswith("## UNIT ← PHÂN TÍCH")
    assert "≤5" in fast or "5" in fast


def test_engine_unit_soft_cap_prefers_br_validation_error():
    fast = engine_generation_rules("unit", speed="fast", max_per_module=5)
    assert "BR" in fast and "VALIDATION" in fast and "ERROR" in fast
    assert "≤5" in fast or "5" in fast


def test_unit_custom_rules_fit_eng_cap():
    shared = get_tc_generation_rules(preferred_engine="unit")
    eng = engine_generation_rules("unit")
    custom = f"{eng}\n\n{shared}".strip()
    assert len(custom) < 4200, f"custom rules too long: {len(custom)}"
    kept = truncate(custom, 4200)
    assert "GAPS" in kept
    assert "trace:" in kept
    assert "PHIÊN SINH UNIT" in kept
    assert "EXECUTION_CONTEXT" in kept


def test_system_prompt_unit_defers_to_analysis_block():
    shared = get_tc_generation_rules(preferred_engine="unit")
    eng = engine_generation_rules("unit")
    p = system_prompt(
        GenerateContext(
            preferred_engine="unit",
            custom_rules=f"{eng}\n\n{shared}",
        )
    )
    assert "PHIÊN ENGINE = UNIT" in p
    assert "UNIT ← PHÂN TÍCH" in p
    assert p.count("VALIDATION_DATA") == 1  # only in analysis block, not restated
    assert "trace:" in p
