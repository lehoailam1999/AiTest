"""
Requirement Studio — Phân tích (Knowledge) rules for prompt injection.

Criteria guide + fidelity A–K live in
``app.features.requirement_studio.knowledge_builder`` (schema source of truth).
This module adds TC-readiness checklist + chat diff rules (anti-rambling).
Keep in sync with ``.cursor/rules/requirement-analysis.mdc``.
"""

from __future__ import annotations

# json_key values allowed in knowledgeDiff ops (11 analysis buckets + summary).
ANALYSIS_ALLOWED_JSON_KEYS: tuple[str, ...] = (
    "summary",
    "features",
    "actors",
    "useCases",
    "executionContexts",
    "businessRules",
    "validationRules",
    "apiSummary",
    "exceptions",
    "acceptanceCriteria",
    "constraints",
    "gaps",
)

# Compact inject — do not duplicate full ANALYSIS_CRITERIA_GUIDE.
ANALYSIS_TC_READINESS_CHECKLIST = """\
## TC-readiness checklist (BABOK / IEEE 29148 — không lan man / không pad)
Mỗi bucket: không tín hiệu trong SRS → [] hoặc summary rỗng. Chính xác > số lượng. Item phải kiểm chứng được.
- SUMMARY_SCOPE: 2–5 câu Scope (in/out + actor) — cấm vision/marketing / «Hệ thống cho phép…».
- FEATURES: atomic FR; name = động từ+đối tượng; ≥1 tín hiệu test — cấm mục lục / epic rỗng / dump markdown.
- ACTORS: 1 role/item đúng SRS; permissions = thao tác cụ thể — cấm bịa Admin/User/RBAC.
- BUSINESS_FLOWS: Main Success Scenario «1. …\\n2. …» hành động cụ thể — cấm «hoàn tất quy trình»; lỗi → exceptions.
- EXECUTION_CONTEXT: WHO cho scenario (actor/authRequired/roles/sessionHint) — cấm bịa role; không chọn cơ chế login.
- BUSINESS_RULES: 1 policy atomic must/shall gần nguyên văn — cấm «đảm bảo đúng đắn»; field → validationRules.
- VALIDATION_DATA: 1 cặp field+rule đo được — cấm «dữ liệu hợp lệ»; thiếu tên field → bỏ.
- API_UI: 1 interface tường minh (method+path|UI entry) — cấm đoán /api/…; không có → [].
- ERROR_HANDLING: điều kiện + phản hồi quan sát được — cấm thêm 401/403/500 «cho đủ».
- ACCEPTANCE: chỉ GWT/Done-when/AC-n có outcome — không có → []; cấm heading trống / «dùng thành công».
- NFR_CONSTRAINTS: 1 NFR SMART (có ngưỡng) — cấm «bảo mật/hiệu năng tốt».
- GAPS: 1 thiếu sót chặn TC (TBD/«thiếu <key>») — cấm brainstorm hỏi mở.
Bridge Sinh TC: validation←validationRules+exceptions; RBAC←actors+executionContexts; flow/entry←useCases+apiSummary.
Bridge E2E codegen: WHO←executionContexts+actors; HOW←source/DOM/convention.
"""

ANALYSIS_CHAT_DIFF_RULES = """\
## Knowledge chat — knowledgeDiff (bắt buộc)
- Chỉ dùng Knowledge JSON đã cung cấp — không đọc/ bịa từ file upload ngoài payload.
- knowledgeDiff.ops: op=add|update|remove|set; path ∈ summary|features|actors|useCases|
  executionContexts|businessRules|validationRules|apiSummary|exceptions|acceptanceCriteria|constraints|gaps
  (legacy openQuestions|missingInformation → gaps).
- Câu hỏi thuần → ops=[] ; reply ngắn, bám Knowledge.
- Sửa Knowledge → ops chính xác, value gần nguyên văn SRS; không tạo FEATURES từ ý user nếu không có căn trong Knowledge/SRS đã extract.
- Không nhét phân tích dài vào reply thay cho ops; không pad item mơ hồ.
"""


def append_analysis_tc_checklist(prompt: str) -> str:
    base = (prompt or "").rstrip()
    block = ANALYSIS_TC_READINESS_CHECKLIST.strip()
    if block in base:
        return base
    return f"{base}\n\n{block}"


def append_analysis_chat_diff_rules(prompt: str) -> str:
    base = (prompt or "").rstrip()
    block = ANALYSIS_CHAT_DIFF_RULES.strip()
    if block in base:
        return base
    return f"{base}\n\n{block}"
