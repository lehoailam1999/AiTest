"""
Requirement Studio — Phân tích (Knowledge) rules for prompt injection.

Criteria guide + fidelity A–K live in
``app.features.requirement_studio.knowledge_builder`` (schema source of truth).
This module adds TC-readiness checklist + chat diff rules (anti-rambling).
Keep in sync with ``.cursor/rules/requirement-analysis.mdc``.
"""

from __future__ import annotations

import logging
import os

from app.rules import get_rule_text
from app.rules import render_rules_for_profile_with_meta

logger = logging.getLogger(__name__)

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
_LEGACY_ANALYSIS_TC_READINESS_CHECKLIST = """\
## TC-readiness checklist (BABOK / IEEE 29148 — không lan man / không pad)
Mỗi bucket: không tín hiệu trong SRS → [] hoặc summary rỗng. Chính xác > số lượng. Item phải kiểm chứng được.
- SUMMARY_SCOPE: 2–5 câu Scope (in/out + actor) — cấm vision/marketing / «Hệ thống cho phép…».
- FEATURES: atomic FR từ FR-xx/Feature/hành vi; name=động từ+đối tượng; description có FR-id|path|field|status — cấm mục lục/Phạm vi/Mục tiêu/Endpoints/file›section/epic rỗng; cấm nút/input/field/widget đơn lẻ (→ validationRules); không có → [].
- ACTORS: 1 role/item đúng SRS; permissions = thao tác cụ thể — cấm bịa Admin/User/RBAC.
- BUSINESS_FLOWS: chỉ MSS từ UC-xx/Luồng ≥2 bước; name≤8 từ + mermaid TD + steps 1.2. — cấm Phạm vi/Mục tiêu/Exception trống/file›section/echo; không có → [].
- EXECUTION_CONTEXT: WHO cho scenario (actor/authRequired/roles/sessionHint) — cấm bịa role; không chọn cơ chế login.
- BUSINESS_RULES: 1 policy atomic must/shall gần nguyên văn — cấm «đảm bảo đúng đắn»; field → validationRules.
- VALIDATION_DATA: field (EN/VI đủ tên) + rule đo được + module (màn/chức năng|Chung); xuất đủ hàng bảng — cấm «dữ liệu hợp lệ»; thiếu field → bỏ.
- API_UI: 1 interface tường minh (method+path|UI entry) — cấm đoán /api/…; không có → [].
- ERROR_HANDLING: điều kiện + phản hồi quan sát được trong SRS — heading Exception Flow trống → [] (+ gap ngắn); cấm echo tiêu chí.
- ACCEPTANCE: chỉ GWT/Done-when/AC-n có outcome — không có → []; cấm heading trống / «dùng thành công».
- NFR_CONSTRAINTS: 1 NFR SMART (có ngưỡng) — cấm «bảo mật/hiệu năng tốt».
- GAPS: 1 thiếu sót chặn TC (TBD/«thiếu <key>») — cấm brainstorm hỏi mở.
Bridge Sinh TC: validation←validationRules+exceptions; RBAC←actors+executionContexts; flow/entry←useCases+apiSummary.
Bridge E2E codegen: WHO←executionContexts+actors; HOW←source/DOM/convention.
"""

_LEGACY_ANALYSIS_CHAT_DIFF_RULES = """\
## Knowledge chat — knowledgeDiff (bắt buộc)
- Chỉ dùng Knowledge JSON đã cung cấp — không đọc/ bịa từ file upload ngoài payload.
- knowledgeDiff.ops: op=add|update|remove|set; path ∈ summary|features|actors|useCases|
  executionContexts|businessRules|validationRules|apiSummary|exceptions|acceptanceCriteria|constraints|gaps
  (legacy openQuestions|missingInformation → gaps).
- Câu hỏi thuần → ops=[] ; reply ngắn, bám Knowledge.
- Sửa Knowledge → ops chính xác, value gần nguyên văn SRS; không tạo FEATURES từ ý user nếu không có căn trong Knowledge/SRS đã extract.
- Không nhét phân tích dài vào reply thay cho ops; không pad item mơ hồ.
"""

ANALYSIS_TC_READINESS_CHECKLIST = get_rule_text(
    "ANALYSIS-TC-READINESS", fallback=_LEGACY_ANALYSIS_TC_READINESS_CHECKLIST
)
ANALYSIS_CHAT_DIFF_RULES = get_rule_text(
    "ANALYSIS-CHAT-DIFF", fallback=_LEGACY_ANALYSIS_CHAT_DIFF_RULES
)


def _analysis_selective_enabled() -> bool:
    mode = (os.environ.get("AITEST_RULE_RETRIEVE_MODE") or "full").strip().lower()
    gate = (os.environ.get("AITEST_RULE_RETRIEVE_ANALYSIS") or "").strip().lower()
    return mode == "selective" and gate not in ("0", "false", "no", "off")


def append_analysis_tc_checklist(prompt: str) -> str:
    base = (prompt or "").rstrip()
    block = ANALYSIS_TC_READINESS_CHECKLIST.strip()
    if _analysis_selective_enabled():
        selected, rule_ids, chars = render_rules_for_profile_with_meta(
            "PROFILE-ANALYSIS-ENRICH"
        )
        if selected:
            logger.info(
                "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
                "PROFILE-ANALYSIS-ENRICH",
                "selective",
                ",".join(rule_ids),
                chars,
            )
            block = selected.strip()
    else:
        logger.info(
            "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
            "PROFILE-ANALYSIS-ENRICH",
            "full",
            "ANALYSIS-TC-READINESS",
            len(block),
        )
    if block in base:
        return base
    return f"{base}\n\n{block}"


def append_analysis_chat_diff_rules(prompt: str) -> str:
    base = (prompt or "").rstrip()
    block = ANALYSIS_CHAT_DIFF_RULES.strip()
    if _analysis_selective_enabled():
        selected, rule_ids, chars = render_rules_for_profile_with_meta(
            "PROFILE-ANALYSIS-CHAT"
        )
        if selected:
            logger.info(
                "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
                "PROFILE-ANALYSIS-CHAT",
                "selective",
                ",".join(rule_ids),
                chars,
            )
            block = selected.strip()
    else:
        logger.info(
            "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
            "PROFILE-ANALYSIS-CHAT",
            "full",
            "ANALYSIS-CHAT-DIFF",
            len(block),
        )
    if block in base:
        return base
    return f"{base}\n\n{block}"
