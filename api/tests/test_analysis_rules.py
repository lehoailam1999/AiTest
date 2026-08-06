"""Phân tích (Knowledge) rules — prompt injection + record-type contract."""

from __future__ import annotations

from app.features.requirement_studio.analysis_records import ANALYSIS_RECORD_TYPES
from app.features.requirement_studio.chat_orchestrator import chat_system_prompt
from app.features.requirement_studio.knowledge_builder import (
    ANALYSIS_CRITERIA_GUIDE,
    ANALYSIS_FIDELITY_RULES,
    build_enrich_oneshot_prompt,
    knowledge_enrich_oneshot_system_prompt,
)
from app.llm.analysis_rules import (
    ANALYSIS_ALLOWED_JSON_KEYS,
    ANALYSIS_CHAT_DIFF_RULES,
    ANALYSIS_TC_READINESS_CHECKLIST,
    append_analysis_chat_diff_rules,
    append_analysis_tc_checklist,
)


def test_allowed_json_keys_match_criteria_guide_and_record_types():
    guide_keys = {c["json_key"] for c in ANALYSIS_CRITERIA_GUIDE}
    assert set(ANALYSIS_ALLOWED_JSON_KEYS) == guide_keys
    assert len(ANALYSIS_RECORD_TYPES) == 12
    assert len(ANALYSIS_ALLOWED_JSON_KEYS) == 12


def test_tc_readiness_checklist_covers_eleven_buckets():
    text = ANALYSIS_TC_READINESS_CHECKLIST
    for label in (
        "SUMMARY_SCOPE",
        "FEATURES",
        "ACTORS",
        "BUSINESS_FLOWS",
        "EXECUTION_CONTEXT",
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "API_UI",
        "ERROR_HANDLING",
        "ACCEPTANCE",
        "NFR_CONSTRAINTS",
        "GAPS",
    ):
        assert label in text
    assert "Bridge Sinh TC" in text or "validationRules" in text


def test_chat_diff_rules_constrain_ops_paths():
    text = ANALYSIS_CHAT_DIFF_RULES
    assert "knowledgeDiff" in text
    assert "ops" in text
    assert "features" in text
    assert "gaps" in text


def test_append_helpers_are_idempotent():
    once = append_analysis_tc_checklist("base")
    twice = append_analysis_tc_checklist(once)
    assert once == twice
    assert ANALYSIS_TC_READINESS_CHECKLIST.strip() in once

    once_chat = append_analysis_chat_diff_rules("chat-base")
    twice_chat = append_analysis_chat_diff_rules(once_chat)
    assert once_chat == twice_chat
    assert ANALYSIS_CHAT_DIFF_RULES.strip() in once_chat


def test_enrich_oneshot_prompts_include_fidelity_and_keys():
    sys = knowledge_enrich_oneshot_system_prompt()
    user = build_enrich_oneshot_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
    )
    assert "QUY TẮC CHUNG PHÂN TÍCH" in sys or "features" in sys
    assert "executionContexts" in sys
    assert "CẤM OUTPUT CHUNG CHUNG" in ANALYSIS_FIDELITY_RULES
    assert "DOCUMENT EXCERPTS" in user
    assert "Login" in user


def test_chat_system_prompt_includes_diff_rules():
    prompt = chat_system_prompt()
    assert "Knowledge chat" in prompt or "knowledgeDiff" in prompt
    assert ANALYSIS_CHAT_DIFF_RULES.strip()[:40] in prompt
    for key in ("features", "actors", "gaps", "acceptanceCriteria"):
        assert key in prompt


def test_analysis_selective_mode_uses_profile_blocks(monkeypatch):
    from app.llm.analysis_rules import (
        append_analysis_chat_diff_rules,
        append_analysis_tc_checklist,
    )

    monkeypatch.setenv("AITEST_RULE_RETRIEVE_MODE", "selective")
    monkeypatch.setenv("AITEST_RULE_RETRIEVE_ANALYSIS", "1")
    t = append_analysis_tc_checklist("base")
    assert "TC-readiness checklist" in t
    c = append_analysis_chat_diff_rules("chat-base")
    assert "knowledgeDiff" in c
