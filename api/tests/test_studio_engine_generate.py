"""Studio Unit/E2E generate rules + coerce helpers."""

from app.llm.tc_generation_rules import engine_generation_rules, get_tc_generation_rules
from app.routers.jobs import (
    _coerce_draft_type,
    _tc_matches_preferred_engine,
)


def test_engine_rules_unit_focus():
    text = engine_generation_rules("unit", focus_modules="ValidateEmail")
    assert "PHIÊN SINH UNIT" in text
    assert "KHÔNG sinh type=E2E" in text
    assert "ValidateEmail" in text
    assert "Todo" not in text
    assert "localhost" not in text


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
    # Không ép «đã đăng nhập» khi không có auth_hint
    bare = engine_generation_rules("e2e")
    assert "không bịa «đã đăng nhập»" in bare or "không bịa" in bare
    assert "TARGET URL: Chưa có baseURL" in bare
    assert "storageState" in bare
    assert "AUTH (không bắt buộc" in bare


def test_rules_document_agnostic():
    """Rule mặc định không gắn domain/app mẫu."""
    full = get_tc_generation_rules()
    compact = get_tc_generation_rules(preferred_engine="unit")
    for text in (full, compact):
        assert "DOCUMENT-AGNOSTIC" not in text  # chỉ trong docstring module
        assert "Todo" not in text
        assert "localhost" not in text
        assert "bám sát tài liệu" in text.lower() or "tài liệu" in text.lower()


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
    assert "KHÔNG sinh type=Unit" in e or "KHÔNG sinh type=Unit/API" in e


def test_compact_rules_when_engine_locked():
    from app.llm.tc_generation_rules import get_tc_generation_rules

    compact = get_tc_generation_rules(preferred_engine="e2e")
    full = get_tc_generation_rules()
    assert "QUY TẮC CHUNG" in compact
    assert len(compact) < len(full)


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
