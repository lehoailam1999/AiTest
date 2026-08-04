"""
E2E TC ← Phân tích (Knowledge / analysis records) — Output-driven SoT.

AI chỉ được phép dùng Output Requirement Analysis đã duyệt (Freeze / Knowledge / DB).
Không đọc lại SRS thô, không dùng source để invent requirement ở bước sinh TC.

Aligned techniques (ISTQB / ISO-29119 style, compact):
  workflow/use-case · EP/BVA · decision/permission · error/exception · traceability.

Số TC = số tín hiệu Output cần cover — KHÔNG trần số cố định.
Siết chặt: cấm TC thừa / trùng / lan man.

Cursor narrative: ``.cursor/rules/e2e-tc-from-analysis.mdc`` — keep in sync.

Injection (single place — do NOT restate in system_prompt / freeze / COMPACT):
``tc_generation_rules.engine_generation_rules("e2e")`` prepends this block.
"""

from __future__ import annotations

# Canonical E2E←Analysis contract. Keep compact — fits under system eng_cap with overlay.
E2E_TC_FROM_ANALYSIS_RULES = """\
## E2E ← PHÂN TÍCH (Output-driven) — nguồn #1 duy nhất
Approved Knowledge / Freeze / «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB» = SoT (12 bucket + summary).
CẤM: đọc lại SRS thô · source invent FR · pad · exploratory · TC thừa/trùng.
Bucket [] → bỏ qua. Mỗi TC: testData `trace: <TYPE>/<id|name>` (unique trong module).
Số TC = số tín hiệu Output cần cover — không trần N cố định, không «cho đủ số».
target_url/auth_hint = runtime hint, không tạo FR.

0. OUTPUT COMPLETENESS (gate TRƯỚC khi sinh):
   Tối thiểu: FEATURES (≥1) + (BUSINESS_FLOWS hoặc ACCEPTANCE) có item.
   Thiếu → chỉ cover phần đủ; ghi [Thiếu Output] / [Giả định] — KHÔNG bịa flow/AC.
   GAPS = cảnh báo, không phải nguồn pad TC.
1. SoT lock: chỉ Output đã duyệt (header).
2. Traceability (ISTQB): `trace:` → FEATURES|FLOWS|BR|VALIDATION|AC|ERROR|ACTORS|EXEC_CONTEXT|API_UI.
   1 tín hiệu chính / 1 TC — cấm gộp nhiều FR/AC/BR khác nhau trong một TC.
   Cùng `trace:` → tối đa 1 TC (cấm clone wording).
3. Workflow / use-case: BUSINESS_FLOWS = xương sống.
   Mỗi main + mỗi alt/exception có trong FLOWS → ≥1 TC độc lập (entry→exit).
   Back/Cancel/Save-draft chỉ khi FLOWS/AC có tín hiệu.
4. Decision / permission: ACTORS + EXECUTION_CONTEXT → ≥1 TC quyền (allow/deny) khi có RBAC.
5. EP / BVA: VALIDATION có miền/biên → ≥1 TC lớp tương đương hoặc biên (không nhân bản cùng assert).
6. BR Expansion: mỗi BUSINESS_RULES quan sát được trên UI → ≥1 TC.
7. Scenario Expansion (có tín hiệu mới sinh): Happy · Validation · Permission · Boundary · Error —
   CHỈ nhánh có tín hiệu Output (không checklist giả).
8. Step Expansion: [Hành động]->[Element]->[Data]; label gần nguyên văn Output.
   Mỗi step kiểm chứng được; cấm bước «kiểm tra chung chung».
9. Expected Binding: chỉ outcome AC/BR/ERROR/VALIDATION/FLOW — 1–3 assert observable.
10. Coverage gate (không lọt): mọi FEATURES/FLOWS/BR/VALIDATION/AC/ERROR/(ACTORS RBAC)/EXECUTION_CONTEXT
    có item → ≥1 TC. Thiếu lớp có tín hiệu = FAIL (không chấp nhận «đã đủ vì hết quota»).
11. Anti-bloat (siết thừa): bỏ TC nếu (a) trùng trace, (b) cùng flow+cùng expected chỉ đổi title,
    (c) chỉ restates TC khác, (d) không thêm assert/observable mới. SUMMARY/NFR/GAPS → không pad.
12. Lock: không đổi/bổ sung requirement ngoài Output.
13. AUTH WHO (khi có tín hiệu): `authRequired` · `authRole` (1 role) · multi → `roles:` + `multiRole: true`.
    Role CHỈ từ ACTORS/EXECUTION_CONTEXT. Không ghi storageState/API-login (HOW=codegen).
14. FEATURE PATH (E2E_GROUNDING): TC sau login / không PUBLIC → `testData` BẮT BUỘC
    `path: /…` hoặc `featurePath: /…` từ FLOWS|API_UI|FEATURES|route map Output —
    cấm invent. Tuỳ chọn `landmark:` (nhãn màn từ Output, không selector CSS).
    TC Login/Logout/PUBLIC: được miễn path.

Map: FEATURES→happy · FLOWS→journey · EXEC_CONTEXT/ACTORS→auth/permission · BR→rule UI ·
VALIDATION→EP/BVA · API_UI→entry · ERROR→negative · ACCEPTANCE→expected.
Cấm: type≠E2E · Unit/API thuần · duplicate journey · bịa role · pad số lượng · thiếu path: post-login.
"""

# Compact variant — same coverage contract, shorter wording (token save). No numeric ceiling.
E2E_TC_FROM_ANALYSIS_RULES_FAST = """\
## E2E ← PHÂN TÍCH (gọn) — đủ cover, cấm thừa
SoT = Knowledge/Freeze/DB. Gate: FEATURES + (FLOWS|AC). type=E2E. `trace:` unique/TC.
Cover đủ item có tín hiệu: FLOWS · FEATURES · AUTH WHO · VALIDATION/BR · ERROR/permission.
Post-login: `path:`/`featurePath:` bắt buộc (E2E_GROUNDING). Login/PUBLIC miễn.
Số TC = số tín hiệu cần cover — không trần N. CẤM: pad · trùng trace · cùng expected+flow · SRS invent.
1 tín hiệu/TC · expected 1–3 assert · []/GAPS không invent.
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
