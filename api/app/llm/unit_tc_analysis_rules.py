"""
Unit TC ← Phân tích (Knowledge / analysis records) fidelity rules.

International refs: ISTQB (EP/BVA/Decision Table), ISO/IEC/IEEE 29119-3
(test case + requirement traceability), BABOK/IEEE 29148 signals from Analysis.

Cursor narrative: ``.cursor/rules/unit-tc-from-analysis.mdc`` — keep in sync.

Injection (single place — do NOT restate essay in system_prompt / COMPACT / .mdc):
``tc_generation_rules.engine_generation_rules("unit")`` prepends this block.
Cursor pointer only: ``.cursor/rules/unit-tc-from-analysis.mdc``.
Approve path/code: Desktop ``resolveUnitPrimaryFromIndex`` + ``code-aliases-unit-gen.mdc`` (separate phase).

Contract: UNIVERSAL Backend TC IR — SRS-only; PRIMARY BR|VAL|ERROR|AC-BE; portable — no product nouns.
"""

from __future__ import annotations

import logging
import os

from app.rules import get_rule_text
from app.rules import render_rules_for_profile_with_meta

logger = logging.getLogger(__name__)

# Fallback if fragment missing — keep in sync with unit_tc_analysis_*.md
_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES = """\
## UNIT ← PHÂN TÍCH — UNIVERSAL Backend TC IR (ISTQB / ISO 29119-3)

**Phase = Test Case IR từ Knowledge/Freeze/DB.** Portable mọi tài liệu.  
**Không** cần source code để sinh TC. Source Retrieval + `path:`/`code:` = pha sau (Approve).

Knowledge/Freeze = SoT. **Không invent** BR / limit / permission / HTTP / exception / class / method.

### 0. Pipeline (không trộn pha)

Knowledge PRIMARY buckets → Atomic Backend Behavior → Unit TC IR → Approve → Source Retrieval → Codegen

Generator **bảo toàn** `primaryBucket` từ Phân tích (BUSINESS_RULES | VALIDATION_DATA | ERROR_HANDLING | ACCEPTANCE).  
**Cấm** invent/rename/chuyển bucket.

### 1. Sáu gate (thứ tự)

**Rule 1 — Behavior Decomposition**  
Multi-behavior / multi-constraint → atomic BE **trước** Scope Gate (1 TC = 1 behavior).

**Rule 2 — Backend Outcome Gate (SRS-only)**  
Phân loại theo **outcome BE quan sát được trong Knowledge**, không theo keyword UI bề mặt.  
**Cấm** suy “không có BE” chỉ vì SRS viết từ góc UI.  
Ví dụ: «chỉ hiển thị vụ án được tham gia» → BE filter/authz (IN). «Nút mở File Explorer» → OUT.  
**IN** khi Knowledge mô tả constraint/decision/persist/reject/return/authz/state/calc/side-effect.  
**Không** bắt buộc source excerpt để IN.  
Sau classify: **IN** | **OUT** | **MIXED** (chỉ nhánh BE) | **UNKNOWN**.

**Rule 3 — UNKNOWN vs OUT**  
- UI-only chắc chắn → **OUT**  
- Có khả năng BE nhưng Knowledge **thiếu/cắt** → **UNKNOWN** (+ `unknownBehaviors`) — **cấm** UNKNOWN→OUT để giảm TC  
- Source excerpt (nếu có) chỉ **optional confirm** — thiếu excerpt ≠ OUT

**Rule 4 — Conflict Gate**  
Req mâu thuẫn → `conflicts` / GAPS. **Cấm** tự resolve / invent.

**Rule 5 — Implementation-free IR**  
TC mô tả **WHAT** phải test — **không** HOW (class/method/handler/repo/DTO/ORM/HTTP/exception/mock lib).  
`layerHint` / `sourceSignal` = **null** trừ khi Knowledge/excerpt **nói rõ**. **Cấm** suy `maxLength→dto`, `duplicate→repository`.

**Rule 6 — Coverage / Gap Detection**  
Sau classify: inventory tín hiệu IN (đặc biệt VALIDATION_DATA + FILE_DATA_SECURITY) ↔ TC.  
Mỗi IN → ≥1 TC **hoặc** gap. Cấm dừng sớm chỉ happy-path/BR.  
Output `coverage` + `gaps` + `unknownBehaviors` + `conflicts`.

### 2. PRIMARY (itemCount>0 → đánh giá; 0 TC hợp lệ nếu toàn OUT)

1. BUSINESS_RULES — decision/constraint/authz/state/calc BE  
2. VALIDATION_DATA — chỉ chiều criterion hỗ trợ (required/null/empty/blank/min/max/len/format/type/pattern/allowed/combo/duplicate/invalid-ref); EP/BVA khi có biên  
3. ERROR_HANDLING — reject/fail/recover/fallback **có trong** Knowledge  
4. ACCEPTANCE — AC outcome BE; UI-only AC → OUT  

Categories gắn thêm (A–I) khi hữu ích: Logic · Validation · Authz · Integrity · State · Server-processing · Error · Dependency · File/security.

### 3. Atomic + behaviorId + scenario

`behaviorId` = `<requirementId>-B<seq>` (vd. `BR-25-B04`) — 1 behavior / 1 TC.  
Scenario chỉ khi relevant: POSITIVE|NEGATIVE|BOUNDARY|NULL|EMPTY|BLANK|DUPLICATE|NOT_FOUND|AUTHORIZATION|INVALID_STATE|DEPENDENCY_FAILURE — **không** blind matrix.  
Dedup cùng BE across buckets → một TC, gộp `requirementIds`.

### 4. Output contract (JSON only)

Root: `testCases`, `coverage` (per PRIMARY: total/covered/missing), `gaps`, `unknownBehaviors`, `conflicts`.

Mỗi TC tối thiểu: `title`, `type=Unit`, `primaryBucket`, `scenario`, `trace.{requirementIds,behaviorId}`, `preconditions`, `testData.{input,target,existingState}`, `steps.{prepare,execute}`, `expectedResult.{type,observable,description}`, `testDataHints.{layerHint,sourceSignal}` (null nếu không biết), `status` READY_FOR_CODEGEN|NOT_READY.

**Nguồn cover:** chỉ BUSINESS_RULES · VALIDATION_DATA · ERROR_HANDLING · ACCEPTANCE(BE).  
FEATURES = tên `module` — **cấm** pad TC từ FEATURES/FLOWS/useCases/UI.

**Approve-ready (bắt buộc — không invent class/method):**  
- `primaryBucket` + `behaviorId` + `requirementIds`  
- VALIDATION → `target.field` + `target.constraint` (+ boundary/value khi có)  
- `expectedResult.observable` ∈ create|update|query|validate|reject|persist|authz|state  
- Title VN: `[Feature] - [Hành động BE] - [Kết quả]` — động từ nghiệp vụ (tạo/cập nhật/từ chối/lọc/đọc/gán) — **cấm** Class.Method / click / điền form / màn hình.  
Steps/expected: ngôn ngữ nghiệp vụ BE — không class/repo/HTTP invent.

### 5. File / incomplete

File: chỉ chiều Knowledge nêu (format/size/…). Size chưa số → dùng «configured maximum» — **cấm** invent số.  
SRS cắt/TBD → `unknownBehaviors`, không TC phần thiếu.
"""

_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES_FAST = """\
## UNIT ← PHÂN TÍCH (SPEED) — Backend TC IR (SRS-only)

SoT = Knowledge PRIMARY ONLY: BR · VALIDATION_DATA · ERROR · ACCEPTANCE(BE).  
FEATURES = tên module; FLOWS/UI → không cover. **Pha này không cần source.** `path`/`code`/SUT class = Approve/Retrieval sau.

**6 gate:** (1) Atomic BE trước scope. (2) Outcome BE từ Knowledge — cấm bỏ BE chỉ vì wording UI; không bắt buộc excerpt. (3) UI-only→OUT; thiếu Knowledge→UNKNOWN (cấm UNKNOWN→OUT). (4) Conflict→conflicts/GAPS. (5) IR implementation-free; layerHint/sourceSignal=null trừ Knowledge/excerpt nói rõ. (6) Coverage: inventory IN (VALIDATION + FILE security)↔TC; output coverage/gaps/unknownBehaviors; cấm dừng sớm happy-path.

Scope IN|OUT|MIXED|UNKNOWN. MIXED→chỉ nhánh BE.  
`behaviorId`=`<reqId>-B<seq>`. Scenario chỉ chiều relevant. Dedup cùng BE. Cấm invent limit/HTTP/exception/class.  
Title VN `[Feature]-[Hành động BE]-[Kết quả]`. Steps prepare/execute nghiệp vụ.  
Approve markers: primaryBucket + behaviorId + target.field/constraint (VALIDATION) + observable BE.  
JSON: testCases[] + coverage + gaps + unknownBehaviors + conflicts.
"""

UNIT_TC_FROM_ANALYSIS_RULES = get_rule_text(
    "UNIT-TC-ANALYSIS-FULL", fallback=_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES
)
UNIT_TC_FROM_ANALYSIS_RULES_FAST = get_rule_text(
    "UNIT-TC-ANALYSIS-FAST", fallback=_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES_FAST
)


def _tc_gen_selective_enabled() -> bool:
    mode = (os.environ.get("AITEST_RULE_RETRIEVE_MODE") or "full").strip().lower()
    gate = (os.environ.get("AITEST_RULE_RETRIEVE_TCGEN") or "").strip().lower()
    return mode == "selective" and gate not in ("0", "false", "no", "off")


def append_unit_tc_from_analysis_rules(prompt: str, *, speed: bool = False) -> str:
    """Prepend analysis contract so truncate(eng_cap) keeps SoT if budget is tight."""
    block = (UNIT_TC_FROM_ANALYSIS_RULES_FAST if speed else UNIT_TC_FROM_ANALYSIS_RULES).strip()
    if _tc_gen_selective_enabled():
        profile = (
            "PROFILE-TC-UNIT-ANALYSIS-SPEED"
            if speed
            else "PROFILE-TC-UNIT-ANALYSIS"
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
            "PROFILE-TC-UNIT-ANALYSIS",
            "full",
            "UNIT-TC-ANALYSIS-FULL/UNIT-TC-ANALYSIS-FAST",
            len(
                (
                    UNIT_TC_FROM_ANALYSIS_RULES_FAST
                    if speed
                    else UNIT_TC_FROM_ANALYSIS_RULES
                ).strip()
            ),
        )
    base = (prompt or "").rstrip()
    if block in base:
        return base
    if not base:
        return block
    return f"{block}\n\n{base}"
