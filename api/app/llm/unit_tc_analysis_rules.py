"""
Unit TC ← Phân tích (Knowledge / analysis records) fidelity rules.

International refs: ISTQB (EP/BVA/Decision Table), ISO/IEC/IEEE 29119-3
(test case + requirement traceability), BABOK/IEEE 29148 signals from Analysis.

Cursor narrative: ``.cursor/rules/unit-tc-from-analysis.mdc`` — keep in sync.

Injection (single place — do NOT restate in system_prompt / freeze / COMPACT):
``tc_generation_rules.engine_generation_rules("unit")`` prepends this block.
"""

from __future__ import annotations

import logging
import os

from app.rules import get_rule_text
from app.rules import render_rules_for_profile_with_meta

logger = logging.getLogger(__name__)

# Canonical Unit←Analysis contract. Keep compact — fits under system eng_cap with overlay.
_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES = """\
## UNIT ← PHÂN TÍCH (ISTQB / ISO 29119-3) — nguồn #1 duy nhất
Knowledge / Freeze / DB = SoT. SRS+source chỉ bổ sung tín hiệu đã có — không invent.
Mỗi TC: `trace: TYPE/id|name` (1 tín hiệu/1 TC). Bucket [] → bỏ. Alias: ACTORS≡ACTORS_PERMISSIONS · NFR≡NFR_CONSTRAINTS · FLOWS≡BUSINESS_FLOWS.
Portable: không domain/framework sản phẩm — SUT từ Phân tích + source.

BACKEND only (mọi stack): business · service|use-case|handler · validation · domain · utility · authz · error · mock port/repo/gateway.
CQRS→Handler/Service · MVC→service (không thin controller) · Nest/TS BE→service/pipe (không FE).
Mock port — không Unit ORM/SQL trừ Knowledge nói rõ. `path:`/`code:` khuyến khích; Approve bổ sung. Cấm absolute/kebab SUT.
Symbol Latin chỉ trong `path:`/`code:` (Approve/index) — **cấm** ghi Class.Method vào title.

Cấm (→ E2E/bỏ): form/popup/modal/wizard/Bước N/Step N/page/component/chuyển bước/enable-UI · click/fill/navigate/toast · ClientApp/`*.component.*`/`*.page.*`/spa shell · thin HTTP client khi BR/validation · bootstrap · API smoke HTTP-200-only.

Coverage gate (itemCount>0 → ≥1 TC BE; thiếu lớp có tín hiệu = FAIL):
- SUMMARY_SCOPE: không TC
- FEATURES: ≥1 happy handler/service; UI-only → E2E
- ACTORS+EXECUTION_CONTEXT: authz service/handler allow(+deny)
- BUSINESS_FLOWS: logic → Unit; wizard/UI → E2E
- BUSINESS_RULES: mỗi BR ≥1; Decision Table = 1 tổ hợp/TC; fail-branch → negative
- VALIDATION_DATA: mỗi field+rule → EP (+BVA) trên input BE
- API_UI: → handler/service (không status-only); UI màn → E2E
- ERROR_HANDLING: mỗi lỗi BE → ≥1 negative
- ACCEPTANCE: AC không-UI only
- NFR: chỉ đo được unit BE
- GAPS: cấm pad/invent

Cấm: bịa · gộp nhiều tín hiệu/TC · type≠Unit · steps UI · pad GAPS.
Title: `[Feature] - [Hành động BE tiếng Việt] - [Kết quả]` — **cấm** Class.Method / Handler / Service Latin trong title.
"""

# Fast path — same contract, fewer lines (still under cap with SPEED overlay).
_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES_FAST = """\
## UNIT ← PHÂN TÍCH (SPEED)
SoT = Knowledge/Freeze/DB. Cover bucket itemCount>0 phía backend: FEATURES + mỗi BR (≥1; fail-branch) + mỗi VALIDATION (EP/+BVA) + ERROR + (API→handler, không HTTP-200-only) + (ACTORS/EXEC_CONTEXT authz) + AC không-UI.
`trace: TYPE/id|name` 1 tín hiệu/1 TC. []/GAPS → không invent/pad. type=Unit only.
SUT = handler/service/use-case/validator/domain; mock port/repo. CQRS→Handler/Service · MVC→service (không thin controller).
Cấm: form/popup/modal/wizard/Bước N/chuyển bước/enable-UI/page/component/click-fill · ClientApp/`*.component.*`/`*.page.*` → E2E hoặc bỏ.
Title VN: `[Feature] - [Hành động BE] - [Kết quả]` — cấm Latin Class.Method trong title. path:/code: khi Approve.
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
