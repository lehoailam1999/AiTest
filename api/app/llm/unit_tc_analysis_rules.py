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
Knowledge / Freeze / «KẾT QUẢ PHÂN TÍCH ĐÃ LƯU DB» = SoT. SRS+source chỉ bổ sung tín hiệu đã có — không invent.
Mỗi TC: testData `trace: <TYPE>/<id|name>`. Bucket [] → bỏ qua.

Map (có item mới sinh TC):
- SUMMARY_SCOPE: khoanh scope — không sinh TC
- FEATURES: ≥1 happy/feature; module=name
- ACTORS: chỉ nhánh RBAC/logic service — role UI → E2E
- BUSINESS_FLOWS: logic trong steps → Unit; click UI → E2E
- BUSINESS_RULES: ≥1 TC/BR (Decision Table)
- VALIDATION_DATA: ≥1 EP/field+rule; có biên → BVA
- API_UI: method+path → handler/service; tên màn UI → E2E
- ERROR_HANDLING: ≥1 negative/exception
- ACCEPTANCE: chỉ AC không-UI; [] → không bịa
- NFR: chỉ đo được ở unit — còn lại bỏ
- GAPS: cấm pad TC

Cấm: bịa ngoài Phân tích · gộp nhiều tín hiệu/1 TC · type≠Unit · steps UI · SUT bootstrap.
"""

# Fast path — same contract, fewer lines (still under cap with SPEED overlay).
_LEGACY_UNIT_TC_FROM_ANALYSIS_RULES_FAST = """\
## UNIT ← PHÂN TÍCH (SPEED)
SoT = Knowledge/Freeze/DB. Cover FEATURES+BR+VALIDATION+ERROR (+API path, AC không-UI) có item.
`trace: TYPE/id|name` mỗi TC. []/GAPS → không invent/pad. type=Unit only.
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
