"""Phân tích (Knowledge) rules — prompt injection + record-type contract."""

from __future__ import annotations

from app.features.requirement_studio import application as app_svc
from app.features.requirement_studio.chat_orchestrator import chat_system_prompt
from app.features.requirement_studio.knowledge_builder import (
    ANALYSIS_CRITERIA_GUIDE,
    build_knowledge_user_prompt,
    knowledge_system_prompt,
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
    assert len(app_svc.ANALYSIS_RECORD_TYPES) == 12
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


def test_knowledge_prompts_include_tc_checklist():
    full = knowledge_system_prompt(pass1=False)
    slim = knowledge_system_prompt(pass1=True)
    marker = "TC-readiness checklist"
    assert marker in full
    assert marker in slim
    assert "CẤM OUTPUT CHUNG CHUNG" in full or "QUY TẮC CHUNG PHÂN TÍCH" in full

    user_full = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
        pass1=False,
    )
    user_slim = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
        pass1=True,
    )
    assert marker in user_full
    assert marker in user_slim


def test_chat_system_prompt_includes_diff_rules():
    prompt = chat_system_prompt()
    assert "Knowledge chat" in prompt or "knowledgeDiff" in prompt
    assert ANALYSIS_CHAT_DIFF_RULES.strip()[:40] in prompt
    for key in ("features", "actors", "gaps", "acceptanceCriteria"):
        assert key in prompt
