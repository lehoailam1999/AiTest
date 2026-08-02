"""
E2E TC ← Phân tích (Knowledge / analysis records) — Output-driven SoT.

AI chỉ được phép dùng Output Requirement Analysis đã duyệt (Freeze / Knowledge / DB).
Không đọc lại SRS thô, không dùng source để invent requirement ở bước sinh TC.

Cursor narrative: ``.cursor/rules/e2e-tc-from-analysis.mdc`` — keep in sync.

Injection (single place — do NOT restate in system_prompt / freeze / COMPACT):
``tc_generation_rules.engine_generation_rules("e2e")`` prepends this block.
"""

from __future__ import annotations

# Canonical E2E←Analysis contract. Keep compact — fits under system eng_cap with overlay.
E2E_TC_FROM_ANALYSIS_RULES = """\
## E2E ← PHÂN TÍCH (Output-driven) — nguồn #1 duy nhất
Approved Knowledge / Freeze / «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB» = SoT (11 bucket).
CẤM: đọc lại SRS thô · dùng source invent FR · pad ngoài Output. Bucket [] → bỏ qua.
Mỗi TC: testData `trace: <TYPE>/<id|name>`. target_url/auth_hint = runtime hint, không tạo FR.

0. OUTPUT COMPLETENESS (gate TRƯỚC khi sinh):
   Tối thiểu: FEATURES (≥1) + (BUSINESS_FLOWS hoặc ACCEPTANCE) có item.
   Thiếu → chỉ cover phần đủ; ghi [Thiếu Output] / [Giả định] — KHÔNG bịa flow/AC.
   GAPS = cảnh báo, không phải nguồn pad TC.
1. SoT lock: chỉ Output đã duyệt (header).
2. Traceability: `trace:` → FEATURES|FLOWS|BR|VALIDATION|AC|ERROR|ACTORS|API_UI.
3. Workflow-based: BUSINESS_FLOWS = xương sống; mỗi main/alt độc lập → ≥1 TC.
4. BR Expansion: mỗi BUSINESS_RULES quan sát được trên UI → ≥1 TC.
5. Scenario Expansion (ưu tiên): FEATURE/FLOW → Happy/Validation/Permission/Boundary/Error
   — CHỈ nhánh có tín hiệu (không checklist giả).
6. Step Expansion: [Hành động]->[Element]->[Data]; label/entry từ FLOWS/API_UI/FEATURES.
7. Expected Binding: expectedResult chỉ outcome trong AC/BR/ERROR/VALIDATION/FLOW.
8. Coverage: mọi FEATURES/FLOWS/BR/VALIDATION/AC/ERROR/(ACTORS RBAC) có item → ≥1 TC.
9. Lock: không đổi/bổ sung requirement ngoài Output.

Map UI: FEATURES→module+happy · FLOWS→journey ·
EXECUTION_CONTEXT→precondition `authRequired`/`role`/`roles[]` (WHO — không chọn storageState) ·
ACTORS→auth/permission · BR→rule UI ·
VALIDATION→fill/assert · API_UI(UI)→điểm bắt đầu · ERROR→negative UI · ACCEPTANCE→expected ·
SUMMARY/NFR/GAPS→không pad.
Cấm: type≠E2E · Unit/API thuần hàm · gộp nhiều tín hiệu/1 TC · bịa role ngoài actors/executionContexts.
"""

E2E_TC_FROM_ANALYSIS_RULES_FAST = """\
## E2E ← PHÂN TÍCH (SPEED)
SoT = Knowledge/Freeze/DB. Gate: FEATURES + (FLOWS|AC). Cover journey chính + validation/BR có item.
`trace: TYPE/id|name` mỗi TC. []/GAPS → không invent. type=E2E only. Cấm SRS/source invent.
"""


def append_e2e_tc_from_analysis_rules(prompt: str, *, speed: bool = False) -> str:
    """Prepend Output-driven contract so truncate(eng_cap) keeps SoT if budget is tight."""
    block = (
        E2E_TC_FROM_ANALYSIS_RULES_FAST if speed else E2E_TC_FROM_ANALYSIS_RULES
    ).strip()
    base = (prompt or "").rstrip()
    if block in base:
        return base
    if not base:
        return block
    return f"{block}\n\n{base}"
