"""Unit TC ← Phân tích fidelity — UNIVERSAL Backend TC IR (SRS-only) + PRIMARY 4."""

from __future__ import annotations

from app.llm.base import GenerateContext, system_prompt, truncate
from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules
from app.llm.unit_tc_analysis_rules import (
    UNIT_TC_FROM_ANALYSIS_RULES,
    UNIT_TC_FROM_ANALYSIS_RULES_FAST,
    append_unit_tc_from_analysis_rules,
)

# Prompt must stay presentation-agnostic (portable) — no FE/UI taxonomy.
_PRESENTATION_TAXONOMY = (
    "BE_FE",
    "ClientApp",
    "*.component",
    "form/popup",
    "wizard",
    "hover",
    "animation",
    "toast",
)


def test_unit_analysis_rules_primary_four_and_ir_gates():
    text = UNIT_TC_FROM_ANALYSIS_RULES
    for label in (
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
        "UNKNOWN",
        "UNIVERSAL",
        "conflicts",
        "Backend Outcome Gate",
        "Behavior Decomposition",
        "Implementation-free",
        "Coverage / Gap Detection",
        "behaviorId",
        "primaryBucket",
        "FILE_DATA_SECURITY",
    ):
        assert label in text, label
    assert "PRIMARY" in text
    assert "ISTQB" in text
    assert "29119" in text
    assert "BACKEND" in text.upper() or "backend" in text
    assert "Dedup" in text or "dedup" in text.lower()
    assert "IN" in text and "OUT" in text and "MIXED" in text
    assert "layerHint" in text
    assert "sourceSignal" in text
    assert "coverage" in text
    assert "unknownBehaviors" in text
    assert "Approve" in text  # path/code phase after IR
    assert "atomic" in text.lower()
    # Portable categories (short names OK — no product nouns)
    low = text.lower()
    assert "authz" in low or "authorization" in low
    assert "validation" in low
    assert "file" in low and "security" in low
    for ban in _PRESENTATION_TAXONOMY:
        assert ban.lower() not in low, f"presentation taxonomy leaked: {ban}"
    assert "be_fe" not in low
    assert "non-ui" not in low
    assert "clientapp" not in low
    assert "invent" in low or "bịa" in text or "cấm" in low
    # Must not require source excerpt for IN
    assert "bắt buộc source excerpt" in text or "bắt buộc source" in low
    assert "Không" in text or "không" in low
    # Rule 3: must not collapse UNKNOWN into OUT
    assert "UNKNOWN" in text and (
        "UNKNOWN → OUT" in text or "UNKNOWN→OUT" in text.replace(" ", "") or "UNKNOWN→OUT" in text
    )
    # No Enforcement Gate (old contract)
    assert "Enforcement Gate" not in text


def test_unit_analysis_fast_covers_primary_and_srs_only():
    fast = UNIT_TC_FROM_ANALYSIS_RULES_FAST
    assert "SRS-only" in fast or "không cần source" in fast.lower() or "Backend TC IR" in fast
    assert "BUSINESS_RULES" in fast or "BR" in fast
    assert "VALIDATION" in fast.upper()
    assert "ERROR" in fast.upper()
    assert "ACCEPTANCE" in fast.upper() or "AC" in fast
    assert "OUT" in fast and "MIXED" in fast and "UNKNOWN" in fast
    assert "coverage" in fast.lower() or "Coverage" in fast
    assert "behaviorId" in fast
    assert "layerHint" in fast or "sourceSignal" in fast
    assert "không bắt buộc excerpt" in fast.lower() or "Approve" in fast
    low = fast.lower()
    assert "wizard" not in low and "popup" not in low and "clientapp" not in low
    assert "Enforcement" not in fast


def test_unit_rules_backend_only_in_engine_and_shared():
    eng = engine_generation_rules("unit")
    assert "BACKEND" in eng.upper() or "Backend" in eng
    assert "MIXED" in eng or "UNKNOWN" in eng or "PRIMARY" in eng
    assert "Outcome" in eng or "SRS-only" in eng or "UNKNOWN" in eng
    low = eng.lower()
    assert "wizard" not in low and "popup" not in low and "clientapp" not in low
    assert "be_fe" not in low
    shared = get_tc_generation_rules(preferred_engine="unit")
    assert "BACKEND" in shared.upper() or "Hành động BE" in shared
    assert "PORTABLE" in shared.upper() or "Hành động BE" in shared
    assert "PRIMARY" in shared or "BR" in shared
    assert "wizard" not in shared.lower() and "popup" not in shared.lower()
    fast = engine_generation_rules("unit", speed="fast")
    assert "backend" in fast.lower() or "BACKEND" in fast or "IR" in fast
    assert "CONFLICT" in fast or "UNKNOWN" in fast or "conflicts" in fast
    assert "wizard" not in fast.lower() and "popup" not in fast.lower()


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
    assert "AuthService" in full
    assert full.count("PRIMARY") >= 1

    fast = engine_generation_rules("unit", speed="fast", max_per_module=5)
    assert "SPEED" in fast
    assert fast.startswith("## UNIT ← PHÂN TÍCH")
    assert "≤5" in fast or "5" in fast


def test_engine_unit_soft_cap_prefers_br_validation_error():
    fast = engine_generation_rules("unit", speed="fast", max_per_module=5)
    assert "BR" in fast and "VALIDATION" in fast and "ERROR" in fast
    assert "≤5" in fast or "5" in fast
    assert "AC" in fast or "ACCEPTANCE" in fast.upper()


def test_unit_custom_rules_fit_eng_cap():
    shared = get_tc_generation_rules(preferred_engine="unit")
    eng = engine_generation_rules("unit")
    custom = f"{eng}\n\n{shared}".strip()
    assert len(custom) < 8000, f"custom rules too long: {len(custom)}"
    kept = truncate(custom, 5600)
    assert "PRIMARY" in kept or "conflicts" in kept or "Coverage" in kept
    assert "PHIÊN SINH UNIT" in kept or "UNIT ← PHÂN TÍCH" in kept
    assert "BUSINESS_RULES" in kept or "BR" in kept


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
    assert p.count("VALIDATION_DATA") >= 1
    assert "PRIMARY" in p or "MIXED" in p or "behaviorId" in p
    low = p.lower()
    assert "be_fe" not in low
    assert "clientapp" not in low
