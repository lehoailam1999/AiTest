"""Studio Unit/E2E generate rules + coerce helpers."""

from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules
from app.routers.jobs import (
    _coerce_draft_type,
    _tc_matches_preferred_engine,
)


def test_engine_rules_unit_focus():
    text = engine_generation_rules("unit", focus_modules="ValidateEmail")
    assert "PHIÊN SINH UNIT" in text
    assert "ValidateEmail" in text
    assert "Todo" not in text
    assert "localhost" not in text
    assert "trace:" in text
    assert text.startswith("## UNIT ← PHÂN TÍCH")
    assert "type=`Unit`" in text or "type=Unit" in text or "Unit` only" in text or "Unit only" in text


def test_engine_rules_e2e_inputs():
    text = engine_generation_rules(
        "e2e",
        target_url="http://localhost:3000",
        auth_hint="đã login admin",
        focus_modules="Checkout",
    )
    assert "PHIÊN SINH E2E" in text
    assert "http://localhost:3000" in text
    assert "đã login admin" in text
    assert "Checkout" in text
    assert text.startswith("## E2E ← PHÂN TÍCH")
    assert "OUTPUT COMPLETENESS" in text
    bare = engine_generation_rules("e2e")
    assert "không bịa" in bare
    assert "TARGET URL" in bare and ("baseURL" in bare or "Giả định" in bare)
    assert "storageState" in bare
    assert "trace:" in bare


def test_rules_document_agnostic():
    """Rule mặc định không gắn domain/app mẫu."""
    full = get_tc_generation_rules()
    compact = get_tc_generation_rules(preferred_engine="unit")
    for text in (full, compact):
        assert "DOCUMENT-AGNOSTIC" not in text  # chỉ trong docstring module
        assert "Todo" not in text
        assert "localhost" not in text
        assert "tài liệu" in text.lower() or "Knowledge" in text or "Feature" in text


def test_coerce_draft_type():
    assert _coerce_draft_type("E2E", "unit") == "Unit"
    assert _coerce_draft_type("Unit", "e2e") == "E2E"
    assert _coerce_draft_type("Journey", "e2e") == "E2E"
    assert _coerce_draft_type("Phủ định", "unit") == "Unit"


def test_system_prompt_locks_engine():
    from app.llm.base import GenerateContext, system_prompt

    u = system_prompt(GenerateContext(preferred_engine="unit"))
    assert "PHIÊN ENGINE = UNIT" in u
    assert "type=Unit" in u or '"type":"Unit"' in u
    assert "PHIÊN ENGINE = E2E" not in u

    e = system_prompt(GenerateContext(preferred_engine="e2e"))
    assert "PHIÊN ENGINE = E2E" in e
    assert "type=E2E" in e or '"type":"E2E"' in e
    assert "E2E ← PHÂN TÍCH" in e
    assert "Output-driven" in e or "OUTPUT COMPLETENESS" in e


def test_compact_rules_when_engine_locked():
    compact_e2e = get_tc_generation_rules(preferred_engine="e2e")
    compact_unit = get_tc_generation_rules(preferred_engine="unit")
    full = get_tc_generation_rules()
    assert "QUY TẮC CHUNG E2E" in compact_e2e
    assert "OUTPUT COMPLETENESS" not in compact_e2e  # SoT only
    assert "QUY TẮC CHUNG UNIT (BẮT BUỘC" in compact_unit
    assert len(compact_e2e) < len(compact_unit)
    assert len(compact_e2e) < len(full)
    assert len(compact_unit) < len(full)


def test_tc_gen_selective_mode_uses_registry_profiles(monkeypatch):
    from app.llm.tc_generation_rules import get_tc_generation_rules

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "selective")
    monkeypatch.setenv("AITEST_RULE_RETRIEVE_TCGEN", "1")
    unit = get_tc_generation_rules(preferred_engine="unit", speed="fast")
    e2e = get_tc_generation_rules(preferred_engine="e2e", speed="fast")
    assert "QUY TẮC CHUNG UNIT (SPEED" in unit
    assert "QUY TẮC CHUNG E2E (SPEED" in e2e


def test_tc_matches_preferred_engine():
    assert _tc_matches_preferred_engine("E2E", "e2e")
    assert not _tc_matches_preferred_engine("Unit", "e2e")
    assert _tc_matches_preferred_engine("API", "unit")
    assert _tc_matches_preferred_engine("Unit", "unit")
    assert not _tc_matches_preferred_engine("E2E", "unit")


def test_custom_rules_only_in_system_not_user():
    """Performance: rules appear once (system), not duplicated in user."""
    from app.llm.base import GenerateContext, system_prompt, user_prompt

    rules = "QUY TẮC UNIQUE_MARKER_XYZ — coverage happy+negative"
    ctx = GenerateContext(
        preferred_engine="unit",
        custom_rules=rules,
    )
    sys_p = system_prompt(ctx)
    usr_p = user_prompt(
        "Req",
        "# Snap\nKnowledge version: 1\n## Knowledge workspace\n### Features\n1. A — desc\n",
        ctx,
    )
    assert "UNIQUE_MARKER_XYZ" in sys_p
    assert "UNIQUE_MARKER_XYZ" not in usr_p
    assert "PHIÊN ENGINE = UNIT" in sys_p


def test_freeze_existing_tcs_stripped_when_live_inventory():
    from app.llm.base import GenerateContext, user_prompt

    freeze = (
        "# Snap\n"
        "Knowledge version: 2\n"
        "## Knowledge workspace\n"
        "### Features\n1. Billing — pay\n"
        "## Existing test cases (inventory — do not duplicate; fill gaps only)\n"
        "Count: 1\n"
        "1. Old TC — Unit — module=Billing\n"
        "## Chat transcript\n"
        "[USER]\nnote\n"
    )
    ctx = GenerateContext(
        preferred_engine="e2e",
        existing_cases=[("TC mới từ DB", "E2E")],
    )
    usr = user_prompt("Snap", freeze, ctx)
    assert "TC mới từ DB" in usr
    assert "Old TC — Unit" not in usr
    assert "Billing — pay" in usr or "Features" in usr
