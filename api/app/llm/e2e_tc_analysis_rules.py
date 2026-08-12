"""
UNIVERSAL E2E Test Case Generator — Analysis Output → E2E TC IR.

SoT = Analysis Output (6 criteria: BUSINESS_FLOWS, ACCEPTANCE, VALIDATION_DATA,
BUSINESS_RULES, ACTORS_EXEC_CONTEXT, ERROR_HANDLING).
Không đọc lại SRS thô, không dùng source để invent requirement ở bước sinh TC.
Source code chỉ dùng ở pha Codegen sau.

Aligned techniques (ISTQB / ISO-29119 style, compact):
  workflow/use-case · EP/BVA · decision/permission · error/exception · traceability.

Số TC = số behavior cần cover — KHÔNG trần số cố định.
Cross-criteria dedup: cùng behavior ở nhiều criteria → 1 TC, gộp criteria[].
Siết chặt: cấm TC thừa / trùng / lan man / invent.

Cursor narrative: ``.cursor/rules/e2e-tc-from-analysis.mdc`` — keep in sync.

Injection (single place — do NOT restate in system_prompt / freeze / COMPACT):
``tc_generation_rules.engine_generation_rules("e2e")`` prepends this block.
"""

from __future__ import annotations

import logging
import os

from app.rules import get_rule_text
from app.rules import render_rules_for_profile_with_meta

logger = logging.getLogger(__name__)

# Canonical E2E←Analysis contract. Keep compact — fits under system eng_cap with overlay.
_LEGACY_E2E_TC_FROM_ANALYSIS_RULES = """\
## E2E ← PHÂN TÍCH — UNIVERSAL E2E Test Case Generator (ISTQB / ISO 29119-3)

**Phase = E2E Test Case IR từ Analysis Output (Output-driven).** Portable mọi tài liệu UI.  
**Không** đọc lại SRS thô hay source code FE/DOM ở pha này. Grounding (`path:`/`featurePath:`, `landmark:`, locators, Playwright code) = pha sau (Approve/Codegen).

Analysis Output = SoT (6 criteria). **Không invent** FR / flow / step / UI control / role / credential.

### 0. Pipeline (không trộn pha)

Analysis Output (6 criteria) → Behavior Extraction → Atomic UI Journey → Cross-criteria Dedup → E2E TC IR → Coverage Validation → Approve → Grounding → Codegen

Generator **bảo toàn** `primaryCriterion` từ Phân tích. **Cấm** invent/rename/chuyển criterion.

### 1. Sáu gate (thứ tự)

**Rule 1 — Journey & Flow Decomposition**  
Multi-step / multi-branch user workflow → atomic UI journeys **trước** Scope Gate (1 TC = 1 user journey = 1 primary behavior).

**Rule 2 — UI Relevance Outcome Gate (Output-driven)**  
Phân loại theo **tín hiệu UI quan sát được trong Analysis Output**, không theo logic ngầm backend.  
- **UI_JOURNEY** (IN): Thao tác & outcome quan sát được trên UI.  
- **BE_ONLY** (OUT): Logic ngầm server/DB/cache không có UI → bỏ qua E2E.  
- **MIXED**: Có cả BE & UI → chỉ lấy nhánh UI.  
- **UNKNOWN**: Có khả năng có UI flow nhưng Analysis Output bị thiếu/cắt.

**Rule 3 — UNKNOWN vs OUT (Chống ép giảm TC)**  
- BE-only chắc → **OUT**. Có UI journey nhưng Analysis Output **thiếu context** → **UNKNOWN** (+ `unknownBehaviors`) — **cấm** UNKNOWN→OUT để giảm TC.

**Rule 4 — Conflict Gate**  
Req mâu thuẫn → `conflicts` / GAPS. **Cấm** tự resolve / invent.

**Rule 5 — Implementation-free & Grounding-decoupled IR**  
TC mô tả **WHAT** trên UI — không HOW. Cấm CSS/Playwright/credentials/HTTP status/exact toast invent.  
`path`/`featurePath` = AbsolutePath ASCII từ Output; **cấm** baseURL/localhost làm route; **cấm** invent slug module VN; **cấm** malware/AV nếu Output không nói. Wizard → steps concrete.

**Rule 6 — Coverage / Gap Detection & Anti-bloat Gate**  
Inventory mọi tín hiệu `UI_JOURNEY` ↔ TC. Mỗi behavior → ≥1 TC hoặc gap. Coverage tính ở **behavior level** (totalBehaviors/coveredBehaviors/missingBehaviors per criterion).  
**Anti-bloat**: bỏ TC nếu trùng trace / cùng flow+expected / restates / không thêm observable UI mới / `BE_ONLY`.

### 2. Sáu criteria (PRIMARY)

Mỗi TC PHẢI có `primaryCriterion` (1 giá trị) + `criteria` (mảng tất cả criteria liên quan).

1. **BUSINESS_FLOWS** — Main/alt/exception user journeys (xương sống E2E). Ưu tiên làm primary khi nhiều criteria mô tả cùng behavior.
2. **ACCEPTANCE** — AC outcome hiển thị trên UI. Verify observable outcome, không invent exact UI text.
3. **VALIDATION_DATA** — EP/BVA trên giao diện. Chỉ gen dimensions có trong Output: Required · Empty · Blank · Null · Min · Max · Below Min · Above Max · Format · Type · Allowed Value · Duplicate · Invalid Reference. **Cấm gen full validation matrix tự động.**
4. **BUSINESS_RULES** — Rule có observable UI outcome (show/hide, enable/disable, dynamic fields, auto-generate, reset, status transitions). Cấm gen internal implementation.
5. **ACTORS_EXEC_CONTEXT** — RBAC & Permission. Chỉ gen khi Output nêu rõ actor/role/permission. Cấm invent role.
6. **ERROR_HANDLING** — Dynamic UI error handling. Chỉ gen error có trong Output. Cấm invent HTTP status/error code/exact message.

### 3. Cross-criteria dedup (BẮT BUỘC)

Cùng behavior ở nhiều criteria → **MỘT** TC. Gộp `criteria[]` + `requirementIds`. Dedup bằng Business Intent + Condition + Observable Outcome (không phải requirement ID). `BUSINESS_FLOWS` ưu tiên primary.

### 4. ONE TC = ONE PRIMARY BEHAVIOR

Mỗi TC đúng 1 primary intent. Cấm gộp nhiều behavior không liên quan vào 1 TC (trừ khi Output định nghĩa là 1 inseparable Business Flow).

### 5. Atomic + journeyId + scenario + authContext

`journeyId` = `<requirementId>-J<seq>` — 1 journey / 1 TC.  
Scenario: HAPPY_PATH | ALTERNATIVE_PATH | EXCEPTION_FLOW | UI_VALIDATION | PERMISSION_ALLOW | PERMISSION_DENY | BOUNDARY_UI | ERROR_UI.  
`authContext`: `authRequired` (boolean), `authRole` (1 role duy nhất), `multiRole` (boolean).

### 6. Output contract (JSON only)

Root: `testCases`, `coverage` (per criterion: `totalBehaviors`/`coveredBehaviors`/`missingBehaviors`), `gaps`, `unknownBehaviors`, `conflicts`.

Mỗi TC: `title`, `type=E2E`, `primaryCriterion`, `criteria[]`, `scenario`, `trace.{requirementIds,journeyId,behaviorId}`, `authContext.{authRequired,authRole,multiRole}`, `featurePath` (null/string), `preconditions[]`, `testData.{field,value,constraint,boundary,existingState}`, `steps[{phase,action,target,data}]`, `expectedResult.{ui[],system[],data[]}`, `testDataHints.{landmark,sourceSignal}`, `status` READY_FOR_GROUNDING|NOT_READY.

Title VN: `[Feature] - [Thao tác UI] - [Kết quả quan sát được]`. Steps/expected: ngôn ngữ nghiệp vụ UI — không CSS/Playwright invent.

### 7. Final Validation Checklist

Mọi IN behavior ≥1 TC · mọi TC có requirementIds+journeyId+primaryCriterion · duplicate merged (1 TC, criteria[]) · validation chỉ gen dimensions có trong Output · auth chỉ gen khi Output nêu · expected observable · cấm invent implementation/source/locator/route/API/HTTP status.
"""

# Compact variant — same coverage contract, shorter wording (token save). No numeric ceiling.
_LEGACY_E2E_TC_FROM_ANALYSIS_RULES_FAST = """\
## E2E ← PHÂN TÍCH (SPEED) — Universal E2E TC IR (Output-driven)

SoT = Analysis Output (6 criteria). **PRIMARY** giữ nguyên criterion: BUSINESS_FLOWS · ACCEPTANCE · VALIDATION_DATA · BUSINESS_RULES · ACTORS_EXEC_CONTEXT · ERROR_HANDLING.  
**Pha này không đọc raw SRS / source code.** Grounding = Approve/Codegen sau.

**6 gate:** (1) Atomic UI journey (1 TC = 1 primary behavior). (2) Outcome UI — UI_JOURNEY→IN, BE_ONLY→OUT, MIXED→nhánh UI, UNKNOWN→không invent. (3) Cấm UNKNOWN→OUT. (4) Conflict→conflicts/GAPS. (5) Implementation-free; cấm invent HTTP/error code/locator/route. (6) Coverage per behavior (totalBehaviors/coveredBehaviors/missingBehaviors) & Anti-bloat.

**Cross-criteria dedup:** cùng behavior → 1 TC, gộp `criteria[]`; `BUSINESS_FLOWS` ưu tiên primary.  
**VALIDATION_DATA:** chỉ gen dimensions có trong Output. Cấm gen full validation matrix.

`primaryCriterion` + `criteria[]`. `journeyId`=`<reqId>-J<seq>`. Scenario: HAPPY_PATH|ALTERNATIVE_PATH|EXCEPTION_FLOW|UI_VALIDATION|PERMISSION_ALLOW|PERMISSION_DENY|BOUNDARY_UI|ERROR_UI.  
`authContext`: authRequired, authRole, multiRole. TC: `steps[{phase,action,target,data}]`, `expectedResult.{ui[],system[],data[]}`, `testData.{field,value,constraint,boundary,existingState}`.  
Title VN `[Feature] - [Thao tác UI] - [Kết quả quan sát được]`.  
JSON: testCases[] + coverage(per criterion) + gaps + unknownBehaviors + conflicts.
"""


E2E_TC_FROM_ANALYSIS_RULES = get_rule_text(
    "E2E-TC-ANALYSIS-FULL", fallback=_LEGACY_E2E_TC_FROM_ANALYSIS_RULES
)
E2E_TC_FROM_ANALYSIS_RULES_FAST = get_rule_text(
    "E2E-TC-ANALYSIS-FAST", fallback=_LEGACY_E2E_TC_FROM_ANALYSIS_RULES_FAST
)


def _tc_gen_selective_enabled() -> bool:
    mode = (os.environ.get("AITEST_RULE_RETRIEVE_MODE") or "full").strip().lower()
    gate = (os.environ.get("AITEST_RULE_RETRIEVE_TCGEN") or "").strip().lower()
    return mode == "selective" and gate not in ("0", "false", "no", "off")


def append_e2e_tc_from_analysis_rules(prompt: str, *, speed: bool = False) -> str:
    """Prepend Output-driven contract so truncate(eng_cap) keeps SoT if budget is tight."""
    block = (E2E_TC_FROM_ANALYSIS_RULES_FAST if speed else E2E_TC_FROM_ANALYSIS_RULES).strip()
    if _tc_gen_selective_enabled():
        profile = (
            "PROFILE-TC-E2E-ANALYSIS-SPEED"
            if speed
            else "PROFILE-TC-E2E-ANALYSIS"
        )
        selected, rule_ids, chars = render_rules_for_profile_with_meta(profile)
        if selected:
            logger.info(
                "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
                profile,
                "selective",
                ",".join(rule_ids),
                chars,
            )
            block = selected.strip()
    else:
        logger.info(
            "RuleProfile apply profile=%s mode=%s ids=%s chars=%s",
            "PROFILE-TC-E2E-ANALYSIS",
            "full",
            "E2E-TC-ANALYSIS-FULL/E2E-TC-ANALYSIS-FAST",
            len((E2E_TC_FROM_ANALYSIS_RULES_FAST if speed else E2E_TC_FROM_ANALYSIS_RULES).strip()),
        )
    base = (prompt or "").rstrip()
    if block in base:
        return base
    if not base:
        return block
    return f"{block}\n\n{base}"
