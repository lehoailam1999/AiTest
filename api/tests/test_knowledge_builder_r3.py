"""R3 — Knowledge Builder heuristic tests (TC-readiness criteria)."""

from app.features.requirement_studio.knowledge_builder import (
    ANALYSIS_CRITERIA_GUIDE,
    build_knowledge_user_prompt,
    build_knowledge_heuristic,
    normalize_knowledge_payload,
    parse_knowledge_llm_json,
)


def test_heuristic_extracts_rules_and_apis():
    chunks = [
        (
            "Use Case Login",
            "Actor: Admin\nUser phải đăng nhập bằng email.\nGET /api/auth/login\nBảng Users lưu hồ sơ.",
        ),
        (None, "Token là chuỗi JWT. Cần làm rõ timeout."),
    ]
    payload = build_knowledge_heuristic(chunks, file_names=["srs.md"])
    assert payload["summary"]
    assert any("đăng nhập" in r["text"].lower() for r in payload["businessRules"])
    assert any(a["name"] for a in payload["actors"])
    assert any(u["name"] for u in payload["useCases"])
    assert any(a["path"].startswith("/api/") for a in payload["apiSummary"])
    assert payload["features"]  # fallback from use cases
    assert payload["gaps"]  # structural and/or TBD
    # Plain "?" alone should not explode gaps — only "cần làm rõ"
    assert any("cần làm rõ" in g["text"].lower() for g in payload["gaps"])


def test_question_mark_alone_is_not_a_gap():
    chunks = [("Notes", "What is the limit? Is this OK?")]
    payload = build_knowledge_heuristic(chunks)
    gap_texts = " ".join(g["text"] for g in payload["gaps"]).lower()
    assert "what is the limit?" not in gap_texts


def test_normalize_merges_legacy_open_and_missing():
    raw = {
        "summary": "S",
        "openQuestions": [{"text": "TBD X"}],
        "missingInformation": [{"text": "No actors"}],
        "useCases": [{"name": "Login", "steps": "1. Go"}],
    }
    p = normalize_knowledge_payload(raw)
    assert any(g["text"] == "TBD X" for g in p["gaps"])
    assert any(g["text"] == "No actors" for g in p["gaps"])
    assert any(f["name"] == "Login" for f in p["features"])


def test_parse_llm_json_fence():
    raw = """```json
{"summary":"OK","features":[{"name":"Auth"}],"businessRules":[{"id":"BR-1","text":"Must login"}],"actors":[],"useCases":[],"validationRules":[],"apiSummary":[],"exceptions":[],"acceptanceCriteria":[],"constraints":[],"gaps":[]}
```"""
    data = parse_knowledge_llm_json(raw)
    assert data is not None
    assert data["summary"] == "OK"
    assert data["businessRules"][0]["text"] == "Must login"
    assert data["features"][0]["name"] == "Auth"
    assert "gaps" in data


def test_empty_chunks_marks_gaps():
    payload = build_knowledge_heuristic([])
    assert payload["gaps"]


def test_build_knowledge_user_prompt_contains_all_required_types():
    prompt = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
    )
    assert "SRS nguồn tải lên cần phân tích đầy đủ" in prompt
    for criterion in ANALYSIS_CRITERIA_GUIDE:
        assert criterion["type"] in prompt
        assert criterion["json_key"] in prompt


def test_normalize_splits_mixed_lines_into_separate_criteria():
    raw = {
        "summary": (
            "Feature: Đăng nhập; Email bắt buộc; nếu sai mật khẩu trả 401; "
            "Given user hợp lệ thì vào dashboard."
        ),
        "businessRules": [
            {
                "text": "Người dùng phải đăng nhập để truy cập; nếu sai thì báo lỗi."
            }
        ],
    }
    out = normalize_knowledge_payload(raw)
    assert out["features"]
    assert out["validationRules"]
    assert out["exceptions"]
    assert out["acceptanceCriteria"]
