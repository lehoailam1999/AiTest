"""Phase 1 — rule registry loader and UUTGS wiring."""

from __future__ import annotations

import hashlib
from app.llm.uutgs_rules import UUTGS_SPEC, _LEGACY_UUTGS_SPEC
from app.llm.e2e_codegen_rules import E2E_CODEGEN_SPEC
from app.rules import (
    ACTIVE_RULE_PROFILE_IDS,
    RULE_PROFILES,
    get_rule_text,
    load_rule_registry,
    render_rules_for_profile,
    render_rules_for_profile_with_meta,
    retrieve_rule_rows,
)


def _sha(text: str) -> str:
    return hashlib.sha256((text or "").encode("utf-8")).hexdigest()


def test_rule_registry_has_uutgs_full():
    data = load_rule_registry()
    ids = {str(r.get("id")) for r in data.get("rules", [])}
    assert "UUTGS-FULL" in ids


def test_uutgs_loaded_from_registry_matches_legacy_text():
    registry_text = get_rule_text("UUTGS-FULL", fallback="")
    assert registry_text.strip()
    assert UUTGS_SPEC.strip() == registry_text.strip()
    # Behavior-safe migration: registry content must remain byte-equivalent to legacy text.
    assert _sha(registry_text.strip()) == _sha(_LEGACY_UUTGS_SPEC.strip())


def test_rule_profiles_scaffold_has_core_profiles():
    assert "PROFILE-UNIT-CODEGEN" in RULE_PROFILES
    assert "PROFILE-E2E-CODEGEN" in RULE_PROFILES
    assert "PROFILE-ANALYSIS-ENRICH" in RULE_PROFILES
    assert "PROFILE-ANALYSIS-CHAT" in RULE_PROFILES
    assert "PROFILE-TC-UNIT-ANALYSIS" in RULE_PROFILES
    assert "PROFILE-TC-E2E-ANALYSIS" in RULE_PROFILES


def test_all_profiles_resolve_at_least_one_rule_row():
    for profile_id in ACTIVE_RULE_PROFILE_IDS:
        rows = retrieve_rule_rows(profile_id)
        assert rows, f"profile has no rows: {profile_id}"


def test_registry_contains_analysis_and_tc_gen_rules():
    data = load_rule_registry()
    ids = {str(r.get("id")) for r in data.get("rules", [])}
    assert "ANALYSIS-TC-READINESS" in ids
    assert "ANALYSIS-CHAT-DIFF" in ids
    assert "TC-GEN-DEFAULT" in ids
    assert "UNIT-TC-ANALYSIS-FULL" in ids
    assert "E2E-TC-ANALYSIS-FULL" in ids


def test_profile_analysis_chat_resolves_diff_block():
    txt = render_rules_for_profile("PROFILE-ANALYSIS-CHAT")
    assert "knowledgeDiff" in txt


def test_profile_tc_unit_analysis_resolves_trace_block():
    txt = render_rules_for_profile("PROFILE-TC-UNIT-ANALYSIS")
    assert "trace:" in txt
    assert "type≠Unit" in txt or "type=Unit" in txt


def test_render_rules_with_meta_returns_ids_and_char_count():
    text, ids, chars = render_rules_for_profile_with_meta("PROFILE-UNIT-CODEGEN")
    assert text.startswith("# UUTGS")
    assert "UUTGS-FULL" in ids
    assert chars == len(text)


def test_retrieve_profile_unit_codegen_returns_uutgs():
    rows = retrieve_rule_rows("PROFILE-UNIT-CODEGEN")
    ids = {str(r.get("id")) for r in rows}
    assert "UUTGS-FULL" in ids
    txt = render_rules_for_profile("PROFILE-UNIT-CODEGEN")
    assert txt.startswith("# UUTGS")


def test_uutgs_system_block_honors_selective_mode(monkeypatch):
    from app.llm.uutgs_rules import uutgs_system_block

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "selective")
    selected = uutgs_system_block()
    assert selected.startswith("# UUTGS")

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "full")
    full = uutgs_system_block()
    assert full.startswith("# UUTGS")
    assert len(full) >= len(selected)


def test_e2ecg_registry_fallback_matches_legacy_text():
    # Phase step: E2E now reads registry content (or falls back safely).
    text = E2E_CODEGEN_SPEC.strip()
    assert text.startswith("# E2ECG")
    assert "Auth & Role" in text
    assert "Implementation Mapping" in text
    assert len(text) >= 1500


def test_e2ecg_system_block_uses_selective_by_default_in_selective_mode(monkeypatch):
    from app.llm.e2e_codegen_rules import e2ecg_system_block

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "selective")
    monkeypatch.delenv("AITEST_RULE_RETRIEVE_E2E", raising=False)
    text = e2ecg_system_block()
    assert text.startswith("# E2ECG")
    assert "Grounding SoT" in text


def test_e2ecg_system_block_can_be_disabled_with_gate(monkeypatch):
    from app.llm.e2e_codegen_rules import e2ecg_system_block

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "selective")
    monkeypatch.setenv("AITEST_RULE_RETRIEVE_E2E", "0")
    text = e2ecg_system_block()
    assert text.startswith("# E2ECG")
    assert "Grounding SoT" in text

