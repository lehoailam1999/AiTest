"""R5 — chat knowledgeDiff apply + heuristic turn."""

from app.features.requirement_studio.chat_orchestrator import (
    apply_knowledge_diff,
    heuristic_chat_turn,
    parse_chat_llm_json,
)


def test_apply_add_rule():
    payload = {
        "summary": "S",
        "businessRules": [],
        "actors": [],
        "useCases": [],
        "glossary": [],
        "apiSummary": [],
        "databaseSummary": [],
        "constraints": [],
        "openQuestions": [],
        "missingInformation": [],
    }
    new_p, applied = apply_knowledge_diff(
        payload,
        {"ops": [{"op": "add", "path": "businessRules", "value": {"text": "Must login"}}]},
    )
    assert len(applied) == 1
    assert new_p["businessRules"][0]["text"] == "Must login"
    assert new_p["businessRules"][0]["id"] == "BR-1"
    assert "gaps" in new_p


def test_legacy_open_questions_path_maps_to_gaps():
    payload = {"summary": "S"}
    new_p, applied = apply_knowledge_diff(
        payload,
        {"ops": [{"op": "add", "path": "openQuestions", "value": {"text": "TBD scope"}}]},
    )
    assert applied
    assert any(g["text"] == "TBD scope" for g in new_p["gaps"])


def test_heuristic_add_rule_command():
    payload = {
        "summary": "Demo",
        "businessRules": [],
        "actors": [],
        "useCases": [],
        "glossary": [],
        "apiSummary": [],
        "databaseSummary": [],
        "constraints": [],
        "openQuestions": [],
        "missingInformation": [],
    }
    turn = heuristic_chat_turn("Thêm rule: Phải xác thực OTP", payload)
    assert turn["knowledgeDiff"]["ops"]
    assert "OTP" in turn["reply"]


def test_parse_chat_llm_json():
    raw = '{"reply":"Đã thêm","knowledgeDiff":{"ops":[{"op":"add","path":"actors","value":{"name":"Admin"}}],"summary":"add actor"}}'
    parsed = parse_chat_llm_json(raw)
    assert parsed is not None
    assert parsed["reply"] == "Đã thêm"
    assert parsed["knowledgeDiff"]["ops"][0]["path"] == "actors"
