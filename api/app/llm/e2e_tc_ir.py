"""
E2E TC Intermediate Representation (IR) — flatten to legacy TestCaseDraft fields.

Portable: no product nouns. Preserves semantic markers in test_data for Approve/Grounding/Codegen.
primaryCriterion + criteria[] aligned with Universal E2E TC Generator spec.
"""

from __future__ import annotations

import json
from typing import Any

_PRIMARY = frozenset(
    {
        "BUSINESS_FLOWS",
        "ACCEPTANCE",
        "VALIDATION_DATA",
        "BUSINESS_RULES",
        "ACTORS_EXEC_CONTEXT",
        "ERROR_HANDLING",
    }
)

_SCENARIOS = frozenset(
    {
        "HAPPY_PATH",
        "ALTERNATIVE_PATH",
        "EXCEPTION_FLOW",
        "UI_VALIDATION",
        "PERMISSION_ALLOW",
        "PERMISSION_DENY",
        "BOUNDARY_UI",
        "ERROR_UI",
    }
)


def looks_like_e2e_tc_ir(obj: dict[str, Any]) -> bool:
    """True when LLM returned structured E2E IR (not legacy flat string fields only)."""
    if not isinstance(obj, dict):
        return False
    if isinstance(obj.get("steps"), dict) or isinstance(obj.get("steps"), list):
        return True
    if isinstance(obj.get("expectedResult"), dict) or isinstance(
        obj.get("expected_result"), dict
    ):
        return True
    if isinstance(obj.get("trace"), dict) or isinstance(obj.get("authContext"), dict):
        return True
    if isinstance(obj.get("testData"), dict) or isinstance(obj.get("test_data"), dict):
        return True
    if obj.get("journeyId") or obj.get("featurePath"):
        return True
    if obj.get("primaryCriterion") or obj.get("primaryBucket"):
        return True
    if isinstance(obj.get("criteria"), list):
        return True
    return False


def _as_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    s = str(v).strip()
    return [s] if s else []


def _join_steps(steps: Any) -> str:
    if isinstance(steps, str):
        return steps.strip()
    if isinstance(steps, list):
        lines: list[str] = []
        for i, s in enumerate(steps, 1):
            if isinstance(s, dict):
                phase = str(s.get("phase") or "").strip()
                action = str(s.get("action") or "").strip()
                target = str(s.get("target") or "").strip()
                data = s.get("data")
                parts = []
                if phase:
                    parts.append(f"[{phase}]")
                if action:
                    parts.append(action)
                if target:
                    parts.append(f"→ {target}")
                if data not in (None, "", {}):
                    parts.append(f"({data})")
                st = " ".join(parts).strip()
            else:
                st = str(s or "").strip()
            if st:
                lines.append(f"{i}. {st}" if not st[0].isdigit() else st)
        return "\n".join(lines).strip()
    if not isinstance(steps, dict):
        return str(steps or "").strip()
    prepare = _as_list(steps.get("prepare"))
    execute = _as_list(steps.get("execute"))
    lines = []
    n = 1
    for p in prepare:
        lines.append(f"{n}. [Prepare] {p}")
        n += 1
    for e in execute:
        lines.append(f"{n}. [Execute] {e}")
        n += 1
    return "\n".join(lines).strip()


def _join_expected(expected: Any) -> str:
    if isinstance(expected, str):
        return expected.strip()
    if not isinstance(expected, dict):
        return str(expected or "").strip()
    ui = _as_list(expected.get("ui"))
    system = _as_list(expected.get("system"))
    data = _as_list(expected.get("data"))
    if ui or system or data:
        parts: list[str] = []
        if ui:
            parts.append("UI: " + "; ".join(ui))
        if system:
            parts.append("System: " + "; ".join(system))
        if data:
            parts.append("Data: " + "; ".join(data))
        return " — ".join(parts)
    typ = str(expected.get("type") or "").strip()
    desc = str(expected.get("description") or "").strip()
    obs_raw = expected.get("observableUI") or expected.get("observable")
    obs = (
        ", ".join(_as_list(obs_raw))
        if isinstance(obs_raw, list)
        else str(obs_raw or "").strip()
    )
    parts_legacy = [p for p in (typ, desc) if p]
    if obs and obs.lower() not in (desc.lower(), typ.lower()):
        parts_legacy.append(f"(quan sát UI: {obs})")
    return " — ".join(parts_legacy).strip(" —")


def _join_preconditions(obj: dict[str, Any]) -> str | None:
    pre = obj.get("precondition")
    if pre is None:
        pre = obj.get("preconditions")
    if isinstance(pre, list):
        joined = "\n".join(_as_list(pre))
        return joined or None
    s = str(pre or "").strip()
    return s or None


def _norm_criterion(raw: Any) -> str | None:
    s = str(raw or "").strip().upper().replace(" ", "_")
    aliases = {
        "FLOWS": "BUSINESS_FLOWS",
        "BUSINESS_FLOW": "BUSINESS_FLOWS",
        "AC": "ACCEPTANCE",
        "ACCEPTANCE_CRITERIA": "ACCEPTANCE",
        "VALIDATION": "VALIDATION_DATA",
        "BR": "BUSINESS_RULES",
        "BUSINESS_RULE": "BUSINESS_RULES",
        "ACTORS": "ACTORS_EXEC_CONTEXT",
        "EXEC_CONTEXT": "ACTORS_EXEC_CONTEXT",
        "AUTH": "ACTORS_EXEC_CONTEXT",
        "ERROR": "ERROR_HANDLING",
        "ERRORS": "ERROR_HANDLING",
    }
    s = aliases.get(s, s)
    return s if s in _PRIMARY else (str(raw).strip() or None)


# Backward compat alias
_norm_primary = _norm_criterion


def _compact_json(v: Any) -> str:
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(v)


def _serialize_structured_test_data(td: dict[str, Any]) -> str:
    """Serialize spec-format testData {field, value, constraint, boundary, existingState}."""
    lines: list[str] = []
    field = str(td.get("field") or "").strip()
    value = td.get("value")
    constraint = str(td.get("constraint") or "").strip()
    boundary = td.get("boundary")
    existing = str(td.get("existingState") or td.get("existing_state") or "").strip()
    if field:
        lines.append(f"field: {field}")
    if value not in (None, ""):
        lines.append(f"value: {value}")
    if constraint:
        lines.append(f"constraint: {constraint}")
    if boundary not in (None, ""):
        lines.append(f"boundary: {boundary}")
    if existing:
        lines.append(f"existingState: {existing}")
    td_path = td.get("path") or td.get("featurePath")
    if td_path:
        lines.append(f"path: {td_path}")
    target = td.get("target") if isinstance(td.get("target"), dict) else {}
    if target.get("element"):
        lines.append(f"target.element: {target.get('element')}")
    if target.get("value") not in (None, ""):
        lines.append(f"target.value: {target.get('value')}")
    inp = td.get("input")
    if inp not in (None, "", {}):
        lines.append(f"input: {_compact_json(inp)}")
    return "\n".join(lines)


def build_e2e_ir_test_data(obj: dict[str, Any]) -> str:
    """Serialize E2E IR semantics into portable newline markers for DB test_data."""
    lines: list[str] = []

    primary = _norm_criterion(
        obj.get("primaryCriterion")
        or obj.get("primary_criterion")
        or obj.get("primaryBucket")
        or obj.get("primary_bucket")
    )
    criteria_raw = obj.get("criteria")
    criteria_list: list[str] = []
    if isinstance(criteria_raw, list):
        for c in criteria_raw:
            nc = _norm_criterion(c)
            if nc and nc in _PRIMARY:
                criteria_list.append(nc)

    trace = obj.get("trace") if isinstance(obj.get("trace"), dict) else {}
    req_ids = _as_list(
        (trace or {}).get("requirementIds")
        or (trace or {}).get("requirement_ids")
        or obj.get("requirementIds")
    )
    journey_id = str(
        (trace or {}).get("journeyId")
        or (trace or {}).get("journey_id")
        or obj.get("journeyId")
        or ""
    ).strip()
    behavior_id = str(
        (trace or {}).get("behaviorId")
        or (trace or {}).get("behavior_id")
        or obj.get("behaviorId")
        or ""
    ).strip()

    if primary and req_ids:
        lines.append(f"trace: {primary}/{'+'.join(req_ids)}")
    elif primary and (journey_id or behavior_id):
        lines.append(f"trace: {primary}/{journey_id or behavior_id}")
    elif primary:
        lines.append(f"trace: {primary}/journey")
    elif isinstance(obj.get("testData"), str) and "trace:" in obj["testData"].lower():
        pass

    if primary:
        lines.append(f"primaryCriterion: {primary}")
    if criteria_list:
        lines.append(f"criteria: {','.join(criteria_list)}")
    if journey_id:
        lines.append(f"journeyId: {journey_id}")
    if behavior_id and behavior_id != journey_id:
        lines.append(f"behaviorId: {behavior_id}")
    if req_ids:
        lines.append(f"requirementIds: {', '.join(req_ids)}")

    scenario = str(obj.get("scenario") or "").strip().upper()
    if scenario in _SCENARIOS:
        lines.append(f"scenario: {scenario}")

    auth_ctx = obj.get("authContext") or obj.get("auth_context") or {}
    if isinstance(auth_ctx, dict):
        auth_role = auth_ctx.get("authRole") or auth_ctx.get("role")
        auth_req = auth_ctx.get("authRequired")
        multi_role = auth_ctx.get("multiRole")
        if auth_role:
            lines.append(f"authRole: {auth_role}")
        if auth_req is not None:
            lines.append(f"authRequired: {'true' if auth_req else 'false'}")
        if multi_role:
            lines.append("multiRole: true")

    feature_path = (
        obj.get("featurePath")
        or obj.get("feature_path")
        or obj.get("path")
    )
    if isinstance(feature_path, str) and feature_path.strip():
        lines.append(f"featurePath: {feature_path.strip()}")

    td = obj.get("testData") if isinstance(obj.get("testData"), dict) else None
    if td is None and isinstance(obj.get("test_data"), dict):
        td = obj.get("test_data")
    if isinstance(td, dict):
        structured = _serialize_structured_test_data(td)
        existing_keys = {ln.split(":", 1)[0].strip().lower() for ln in lines if ":" in ln}
        for ln in structured.splitlines():
            k = ln.split(":", 1)[0].strip().lower() if ":" in ln else ""
            if k and k in existing_keys:
                continue
            if ln.strip():
                lines.append(ln.strip())
    elif isinstance(obj.get("testData"), str) and obj["testData"].strip():
        legacy = obj["testData"].strip()
        if not lines:
            return legacy
        existing_keys = {ln.split(":", 1)[0].strip().lower() for ln in lines if ":" in ln}
        for ln in legacy.splitlines():
            k = ln.split(":", 1)[0].strip().lower() if ":" in ln else ""
            if k and k in existing_keys:
                continue
            if ln.strip():
                lines.append(ln.strip())

    hints = obj.get("testDataHints") or obj.get("test_data_hints") or {}
    if isinstance(hints, dict):
        lm = hints.get("landmark")
        ss = hints.get("sourceSignal")
        if lm not in (None, "", "null"):
            lines.append(f"landmark: {lm}")
        if ss not in (None, "", "null"):
            lines.append(f"sourceSignal: {ss}")

    status = str(obj.get("status") or "").strip()
    if status:
        lines.append(f"status: {status}")

    return "\n".join(lines).strip()


def flatten_e2e_tc_ir(obj: dict[str, Any]) -> dict[str, Any]:
    """
    Normalize one E2E TC object to the flat shape expected by TestCaseDraft / DB.
    Legacy flat TCs pass through with light enrichment when IR keys exist.
    """
    if not isinstance(obj, dict):
        return {}

    out = dict(obj)

    if looks_like_e2e_tc_ir(obj):
        out["steps"] = _join_steps(obj.get("steps"))
        out["expectedResult"] = _join_expected(
            obj.get("expectedResult") or obj.get("expected_result") or obj.get("expected")
        )
        pre = _join_preconditions(obj)
        if pre:
            out["precondition"] = pre
        out["testData"] = build_e2e_ir_test_data(obj)
        if not out.get("module") and out.get("title"):
            title = str(out["title"])
            if title.startswith("[") and "]" in title:
                out["module"] = title[1 : title.index("]")].strip() or out.get("module")
        out.setdefault("type", "E2E")
        if not out.get("automationReady") and not out.get("automation_ready"):
            status = str(obj.get("status") or "").upper()
            out["automationReady"] = status == "READY_FOR_GROUNDING"
    elif obj.get("primaryCriterion") or obj.get("primaryBucket") or obj.get("journeyId") or (
        isinstance(obj.get("trace"), dict)
    ) or isinstance(obj.get("criteria"), list):
        existing = str(obj.get("testData") or obj.get("test_data") or "").strip()
        built = build_e2e_ir_test_data(obj)
        if built:
            if existing and "journeyid:" not in existing.lower():
                out["testData"] = f"{built}\n{existing}".strip()
            elif not existing:
                out["testData"] = built

    return out
