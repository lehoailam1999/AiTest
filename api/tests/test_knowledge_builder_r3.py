"""R3 — Knowledge Builder heuristic tests (TC-readiness criteria)."""

from pathlib import Path

from app.features.requirement_studio.knowledge_builder import (
    ANALYSIS_CRITERIA_GUIDE,
    _derive_use_case_name_from_fragment,
    _parse_numbered_use_case_title,
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
{"summary":"OK","features":[{"name":"Đăng nhập","description":"POST /auth/login"}],"businessRules":[{"id":"BR-1","text":"Must login"}],"actors":[],"useCases":[],"validationRules":[],"apiSummary":[],"exceptions":[],"acceptanceCriteria":[],"constraints":[],"gaps":[]}
```"""
    data = parse_knowledge_llm_json(raw)
    assert data is not None
    assert data["summary"] == "OK"
    assert data["businessRules"][0]["text"] == "Must login"
    assert data["features"][0]["name"] == "Đăng nhập"
    assert "gaps" in data


def test_empty_chunks_marks_gaps():
    payload = build_knowledge_heuristic([])
    assert payload["gaps"]


def test_build_knowledge_user_prompt_contains_all_required_types():
    prompt = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
        pass1=False,
    )
    assert "SRS nguồn tải lên cần phân tích đầy đủ" in prompt
    assert "NGUỒN SỰ THẬT" in prompt or "Bám sát" in prompt
    assert "gần nguyên văn" in prompt.lower() or "nguyên văn" in prompt
    for criterion in ANALYSIS_CRITERIA_GUIDE:
        assert criterion["type"] in prompt
        assert criterion["json_key"] in prompt
        # Per-criterion instruction embedded so model fills accurate content
        assert "→" in prompt or criterion["instruction"][:20] in prompt


def test_knowledge_system_prompt_enforces_document_fidelity():
    from app.features.requirement_studio.knowledge_builder import (
        ANALYSIS_FIDELITY_RULES,
        knowledge_system_prompt,
    )

    full = knowledge_system_prompt(pass1=False)
    slim = knowledge_system_prompt(pass1=True)
    assert "QUY TẮC CHUNG PHÂN TÍCH" in full
    assert "EXTRACT" in full
    assert "CẤM OUTPUT CHUNG CHUNG" in full or "chung chung" in full.lower()
    assert "QUY TẮC CHUNG PHÂN TÍCH" in slim
    assert "CẤM OUTPUT CHUNG CHUNG" in ANALYSIS_FIDELITY_RULES
    assert "(1)" in ANALYSIS_FIDELITY_RULES and "(4)" in ANALYSIS_FIDELITY_RULES


def test_build_knowledge_user_prompt_embeds_common_rule():
    prompt = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
        pass1=False,
    )
    assert "QUY TẮC CHUNG" in prompt or "system prompt" in prompt
    assert "Acceptance Criteria" in prompt or "acceptanceCriteria" in prompt
    assert "NGUỒN SỰ THẬT" in prompt
    assert "Cấm" in prompt or "cấm" in prompt


def test_build_knowledge_user_prompt_pass1_is_slimmer():
    from app.features.requirement_studio.knowledge_builder import (
        PASS1_JSON_KEYS,
        MAX_CHUNK_CHARS_FOR_BUILD_PASS1,
        merge_knowledge_payloads,
        rank_chunks_for_build,
    )

    prompt = build_knowledge_user_prompt(
        [("Feature: Login", "User phải đăng nhập bằng email/password.")],
        file_names=["SRS_Login.md"],
        pass1=True,
    )
    assert "pass 1" in prompt.lower() or "TC-critical" in prompt
    assert "FEATURES" in prompt or "features" in prompt.lower()
    # Full guide types not all required in pass1 prompt text for every key label
    assert "SUMMARY_SCOPE" in prompt or "summary" in prompt.lower()
    for key in PASS1_JSON_KEYS:
        assert key in prompt

    big = [("Noise", "x" * 5000), ("Feature: Auth", "User phải login. Actor: Admin")]
    ranked = rank_chunks_for_build(big)
    assert ranked[0][0] == "Feature: Auth"

    merged = merge_knowledge_payloads(
        {
            "summary": "heuristic",
            "features": [{"name": "Tạo A", "description": "POST /a"}],
            "apiSummary": [{"method": "GET", "path": "/a", "note": ""}],
            "actors": [],
            "useCases": [],
            "businessRules": [],
            "validationRules": [],
            "exceptions": [],
            "acceptanceCriteria": [],
            "constraints": [],
            "gaps": [],
        },
        {
            "summary": "llm",
            "features": [{"name": "Xem B", "description": "GET /b"}],
            "apiSummary": [],
            "actors": [{"name": "Admin"}],
            "useCases": [],
            "businessRules": [],
            "validationRules": [],
            "exceptions": [],
            "acceptanceCriteria": [],
            "constraints": [],
            "gaps": [],
        },
    )
    assert merged["summary"] == "llm"
    assert [f["name"] for f in merged["features"]] == ["Xem B", "Tạo A"]
    assert merged["actors"][0]["name"] == "Admin"
    # overlay api empty keeps heuristic endpoint; feature desc may also promote /b
    paths = {a["path"] for a in merged["apiSummary"]}
    assert "/a" in paths
    assert len(prompt) < MAX_CHUNK_CHARS_FOR_BUILD_PASS1 + 8000


def test_enforce_criteria_split_no_generic_flow_name():
    raw = {
        "summary": "Đăng nhập và đăng ký",
        "useCases": [
            {
                "name": "Đăng nhập",
                "steps": "1. Mở màn hình đăng nhập\n2. Nhập email\n3. Nhấn Gửi",
            },
            {
                "name": "Đăng ký",
                "steps": "1. Mở form đăng ký\n2. Nhập họ tên\n3. Lưu",
            },
        ],
        "businessRules": [],
        "features": [],
    }
    out = normalize_knowledge_payload(raw)
    names = [uc["name"] for uc in out["useCases"]]
    assert "Luồng tách từ SRS" not in names
    assert "Đăng nhập" in names
    assert "Đăng ký" in names
    assert len(out["useCases"]) >= 2


def test_derive_use_case_name_from_uc_header():
    frag = "UC-01: Đăng nhập hệ thống\n1. Mở trang login\n2. Nhập email"
    assert _derive_use_case_name_from_fragment(frag) == "Đăng nhập hệ thống"


def test_numbered_use_case_removed_from_features():
    assert _parse_numbered_use_case_title("01 Xem danh sách todo") == "Xem danh sách todo"
    raw = {
        "summary": "Todo app",
        "features": [
            {"name": "Quản lý todo qua REST API", "description": "CRUD /todos"},
            {"name": "Tải danh sách todo", "description": "GET /todos on page load"},
            {"name": "01 Xem danh sách todo", "description": "Actor mở trang và xem list"},
        ],
        "useCases": [],
        "businessRules": [],
    }
    out = normalize_knowledge_payload(raw)
    feature_names = [f["name"] for f in out["features"]]
    assert "01 Xem danh sách todo" not in feature_names
    assert "Quản lý todo qua REST API" in feature_names
    assert "Tải danh sách todo" in feature_names
    uc_names = [uc["name"] for uc in out["useCases"]]
    assert "Xem danh sách todo" in uc_names


def test_acceptance_criteria_section_placeholder_removed():
    raw = {
        "summary": "Todo app",
        "features": [
            {
                "name": "Quản lý todo qua REST API",
                "description": "GET/POST/PATCH/DELETE /todos với Bearer token",
            },
            {"name": "Acceptance Criteria", "description": ""},
            {
                "name": "Frontend UI Todo List",
                "description": "React Vite hiển thị danh sách todo, filter all/active/completed",
            },
        ],
        "acceptanceCriteria": [
            {"text": "Acceptance Criteria"},
            {"text": "Given user đã login When mở trang Then thấy danh sách todo"},
        ],
        "useCases": [],
        "businessRules": [],
    }
    out = normalize_knowledge_payload(raw)
    feature_names = [f["name"] for f in out["features"]]
    assert "Acceptance Criteria" not in feature_names
    assert any("/todos" in f["description"] for f in out["features"])
    ac_texts = [a["text"] for a in out["acceptanceCriteria"]]
    assert "Acceptance Criteria" not in ac_texts
    assert any("Given user" in t for t in ac_texts)


def test_vague_feature_blurb_dropped():
    raw = {
        "features": [
            {
                "name": "Frontend UI Todo List",
                "description": "Giao diện React hiển thị danh sách todo và các thao tác cơ bản",
            },
            {
                "name": "Quản lý tài khoản qua REST API",
                "description": "POST /auth/register, POST /auth/login, refresh TTL 15 phút",
            },
        ],
        "useCases": [],
        "businessRules": [],
    }
    out = normalize_knowledge_payload(raw)
    names = [f["name"] for f in out["features"]]
    assert "Quản lý tài khoản qua REST API" in names
    assert "Frontend UI Todo List" not in names
    assert any(a["path"].startswith("/auth/") for a in out["apiSummary"])


def test_doc_outline_headings_removed_from_features_and_use_cases():
    raw = {
        "features": [
            {"name": "Introduction", "description": ""},
            {"name": "Overall Description", "description": ""},
            {"name": "Functional Requirements", "description": ""},
            {"name": "External Interface Requirements", "description": ""},
            {"name": "Non-Functional Requirements", "description": ""},
            {"name": "Use Cases (for Test Design)", "description": ""},
            {"name": "Guidance for Test Case Generation", "description": ""},
            {"name": "Sample Test Outline (not exhaustive)", "description": ""},
            {"name": "Appendix — Project Structure", "description": ""},
            {
                "name": "Quản lý todo qua REST API",
                "description": "GET /todos, POST /todos, PATCH /todos/{id}, DELETE /todos/{id}",
            },
        ],
        "useCases": [
            {"name": "UC-01 Xem danh sách todo", "steps": "1. Mở trang\n2. Xem danh sách"},
            {"name": "UC-02 Thêm todo", "steps": "1. Nhập title\n2. Nhấn Thêm"},
            {"name": "Use Cases (for Test Design)", "steps": ""},
        ],
    }
    out = normalize_knowledge_payload(raw)
    feature_names = [f["name"] for f in out["features"]]
    uc_names = [uc["name"] for uc in out["useCases"]]
    assert "Introduction" not in feature_names
    assert "Overall Description" not in feature_names
    assert "Functional Requirements" not in feature_names
    assert "Use Cases (for Test Design)" not in feature_names
    assert "Guidance for Test Case Generation" not in feature_names
    assert "Sample Test Outline (not exhaustive)" not in feature_names
    assert "Appendix — Project Structure" not in feature_names
    assert "Quản lý todo qua REST API" in feature_names
    assert "UC-01 Xem danh sách todo" not in uc_names
    assert "Xem danh sách todo" in uc_names
    assert "UC-02 Thêm todo" not in uc_names
    assert "Thêm todo" in uc_names


def test_vietnamese_toc_headings_removed_from_features():
    """SRS mục lục VI (Mục tiêu, Tác nhân, …) must not appear under Chức năng."""
    raw = {
        "features": [
            {
                "name": "Xem danh sách todo",
                "description": "(FR-01) Frontend hiển thị danh sách qua GET /todos",
            },
            {
                "name": "Tạo todo",
                "description": "(FR-02) Form tạo qua POST /todos; title bắt buộc",
            },
            {"name": "Mục tiêu", "description": ""},
            {"name": "Mục tiêu (2)", "description": ""},
            {"name": "Phạm vi (2)", "description": "In/out scope"},
            {"name": "Tác nhân (2)", "description": ""},
            {"name": "Tác nhân", "description": ""},
            {"name": "Yêu cầu chức năng", "description": ""},
            {"name": "Yêu cầu phi chức năng", "description": ""},
            {"name": "API định nghĩa", "description": ""},
            {"name": "Todo Model", "description": ""},
            {"name": "Endpoints", "description": ""},
            {"name": "Hướng dẫn chạy thử", "description": ""},
            {"name": "Frontend", "description": ""},
            {"name": "Test case gợi ý", "description": ""},
            {"name": "1. Mục tiêu", "description": "Tổng quan dự án"},
            {"name": "Backend", "description": "Phần máy chủ"},
            {
                "name": (
                    "API định nghĩa. ## Software Requirements Specification (SRS) "
                    "# Software Requirements Specification (SRS) ## 1. Mục tiêu ## 1. Mục tiêu"
                ),
                "description": "",
            },
            {"name": "Giới thiệu", "description": "Hệ thống cho phép người dùng thao tác"},
        ],
    }
    out = normalize_knowledge_payload(raw)
    names = [f["name"] for f in out["features"]]
    for banned in (
        "Mục tiêu",
        "Mục tiêu (2)",
        "Phạm vi (2)",
        "Tác nhân (2)",
        "Tác nhân",
        "Yêu cầu chức năng",
        "Yêu cầu phi chức năng",
        "API định nghĩa",
        "Todo Model",
        "Endpoints",
        "Hướng dẫn chạy thử",
        "Frontend",
        "Test case gợi ý",
        "1. Mục tiêu",
        "Backend",
        "Giới thiệu",
    ):
        assert banned not in names, banned
    assert not any("Software Requirements Specification" in n for n in names)
    assert not any("#" in n for n in names)
    assert "Xem danh sách todo" in names
    assert "Tạo todo" in names
    assert len(names) == 2


def test_formal_srs_table_rows_and_gloss_headings():
    """Formal VI SRS: FR/BR/AC tables + TOC glosses must map cleanly."""
    raw = {
        "features": [
            {
                "name": "Yêu cầu chức năng (Functional Requirements)",
                "description": "",
            },
            {
                "name": "Mô tả tổng quan hệ thống",
                "description": "",
            },
            {
                "name": "FR-01: Hệ thống phải cho phép người dùng xem danh sách todo",
                "description": "GET /todos",
            },
            {
                "name": "xem danh sách toàn bộ công việc",
                "description": "FR-01: Hệ thống phải cho phép người dùng xem danh sách",
            },
        ],
        "useCases": [
            {"name": "1.1. Mục đích tài liệu", "steps": "Tài liệu mô tả yêu cầu"},
            {
                "name": "UC-01: Xem danh sách công việc",
                "steps": "1. Mở trang\n2. Xem danh sách",
            },
        ],
        "businessRules": [
            {"id": "BR-1", "text": "| BR-01 | Chỉ lưu khi hợp lệ |"},
            {"id": "BR-2", "text": "Chỉ lưu công việc khi dữ liệu thỏa toàn bộ rule validation."},
        ],
        "acceptanceCriteria": [
            {"text": "AC-01: Hệ thống hiển thị đầy đủ danh sách todo từ backend"},
            {"text": "| Mục | Nội dung |"},
        ],
        "actors": [
            {"name": "Người dùng ------> |  - Xem danh sách", "description": ""},
            {"name": "Người dùng", "description": "CRUD trên UI"},
        ],
    }
    out = normalize_knowledge_payload(raw)
    names = [f["name"] for f in out["features"]]
    assert "Yêu cầu chức năng (Functional Requirements)" not in names
    assert "Mô tả tổng quan hệ thống" not in names
    assert any("xem danh sách" in n.lower() for n in names)
    uc_names = [u["name"] for u in out["useCases"]]
    assert "Mục đích tài liệu" not in uc_names
    assert "1.1. Mục đích tài liệu" not in uc_names
    assert "Xem danh sách công việc" in uc_names
    br_texts = [b["text"] for b in out["businessRules"]]
    assert not any(t.strip().startswith("|") for t in br_texts)
    assert any("thỏa toàn bộ rule" in t for t in br_texts)
    ac_texts = [a["text"] for a in out["acceptanceCriteria"]]
    assert any("AC-01" in t for t in ac_texts)
    assert not any(t.strip().startswith("|") for t in ac_texts)
    actor_names = [a["name"] for a in out["actors"]]
    assert "Người dùng" in actor_names
    assert not any("----" in n for n in actor_names)


def test_heuristic_extracts_fr_uc_br_ac_from_todo_srs_tables():
    from app.features.requirement_studio.chunking import chunk_document_text
    from app.features.requirement_studio.knowledge_builder import build_knowledge_heuristic

    text = Path(r"d:\Todo\SRS.md").read_text(encoding="utf-8")
    pairs = [(c.heading, c.text) for c in chunk_document_text(text)]
    out = build_knowledge_heuristic(pairs, file_names=["SRS.md"])

    feature_blob = " ".join(
        f"{f.get('name','')} {f.get('description','')}" for f in out["features"]
    ).lower()
    assert "xem" in feature_blob and "tạo" in feature_blob
    assert not any(
        n in {f["name"] for f in out["features"]}
        for n in (
            "Mô tả tổng quan hệ thống",
            "Yêu cầu chức năng (Functional Requirements)",
            "Giới thiệu",
            "Mục đích tài liệu",
        )
    )
    uc_names = [u["name"] for u in out["useCases"]]
    assert "Xem danh sách công việc" in uc_names
    assert "Tạo công việc mới" in uc_names
    assert not any("Mục đích" in n for n in uc_names)
    assert any("Người dùng" == a["name"] for a in out["actors"])
    assert any("404" in b["text"] or "validation" in b["text"].lower() for b in out["businessRules"])
    assert any("AC-01" in a["text"] for a in out["acceptanceCriteria"])
    paths = {f"{a['method']} {a['path']}" for a in out["apiSummary"]}
    assert "GET /todos" in paths
    assert "POST /todos" in paths
    assert "DELETE /todos/:id" in paths or "DELETE /todos/{id}" in paths


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
    # Vague «Feature: Đăng nhập» without path/field stays out of features (stricter sanitize).
    assert out["validationRules"] or out["businessRules"]
    assert out["exceptions"]
    assert out["acceptanceCriteria"]
