"""
Unit TC Intermediate Representation (IR) — flatten to legacy TestCaseDraft fields.

Portable: no product nouns. Preserves semantic markers in test_data for Approve/Retrieval.
"""

from __future__ import annotations

import json
from typing import Any

_PRIMARY = frozenset(
    {
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
    }
)

_SCENARIOS = frozenset(
    {
        "POSITIVE",
        "NEGATIVE",
        "BOUNDARY",
        "NULL",
        "EMPTY",
        "BLANK",
        "DUPLICATE",
        "NOT_FOUND",
        "AUTHORIZATION",
        "INVALID_STATE",
        "DEPENDENCY_FAILURE",
    }
)


def looks_like_unit_tc_ir(obj: dict[str, Any]) -> bool:
    """True when LLM returned structured IR (not legacy flat string fields only)."""
    if not isinstance(obj, dict):
        return False
    if isinstance(obj.get("steps"), dict):
        return True
    if isinstance(obj.get("expectedResult"), dict) or isinstance(
        obj.get("expected_result"), dict
    ):
        return True
    if isinstance(obj.get("trace"), dict):
        return True
    if isinstance(obj.get("testData"), dict) or isinstance(obj.get("test_data"), dict):
        return True
    if obj.get("behaviorId") or obj.get("primaryBucket"):
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
    if not isinstance(steps, dict):
        return str(steps or "").strip()
    prepare = _as_list(steps.get("prepare"))
    execute = _as_list(steps.get("execute"))
    lines: list[str] = []
    n = 1
    for p in prepare:
        lines.append(f"{n}. {p}")
        n += 1
    for e in execute:
        lines.append(f"{n}. {e}")
        n += 1
    return "\n".join(lines).strip()


def _join_expected(expected: Any) -> str:
    if isinstance(expected, str):
        return expected.strip()
    if not isinstance(expected, dict):
        return str(expected or "").strip()
    typ = str(expected.get("type") or "").strip()
    desc = str(expected.get("description") or "").strip()
    obs = str(expected.get("observable") or "").strip()
    parts = [p for p in (typ, desc) if p]
    if obs and obs.lower() not in (desc.lower(), typ.lower()):
        parts.append(f"(quan sát: {obs})")
    return " — ".join(parts).strip(" —")


def _join_preconditions(obj: dict[str, Any]) -> str | None:
    pre = obj.get("precondition")
    if pre is None:
        pre = obj.get("preconditions")
    if isinstance(pre, list):
        joined = "\n".join(_as_list(pre))
        return joined or None
    s = str(pre or "").strip()
    return s or None


def _norm_primary(raw: Any) -> str | None:
    s = str(raw or "").strip().upper().replace(" ", "_")
    aliases = {
        "BR": "BUSINESS_RULES",
        "BUSINESS_RULE": "BUSINESS_RULES",
        "VALIDATION": "VALIDATION_DATA",
        "ERROR": "ERROR_HANDLING",
        "ERRORS": "ERROR_HANDLING",
        "EXCEPTIONS": "ERROR_HANDLING",
        "AC": "ACCEPTANCE",
        "ACCEPTANCE_CRITERIA": "ACCEPTANCE",
    }
    s = aliases.get(s, s)
    return s if s in _PRIMARY else (str(raw).strip() or None)


def _compact_json(v: Any) -> str:
    try:
        return json.dumps(v, ensure_ascii=False, separators=(",", ":"))
    except (TypeError, ValueError):
        return str(v)


def build_unit_ir_test_data(obj: dict[str, Any]) -> str:
    """Serialize IR semantics into portable newline markers for DB test_data."""
    lines: list[str] = []

    primary = _norm_primary(obj.get("primaryBucket") or obj.get("primary_bucket"))
    trace = obj.get("trace") if isinstance(obj.get("trace"), dict) else {}
    req_ids = _as_list(
        (trace or {}).get("requirementIds")
        or (trace or {}).get("requirement_ids")
        or obj.get("requirementIds")
    )
    behavior_id = str(
        (trace or {}).get("behaviorId")
        or (trace or {}).get("behavior_id")
        or obj.get("behaviorId")
        or ""
    ).strip()

    if primary and req_ids:
        lines.append(f"trace: {primary}/{'+'.join(req_ids)}")
    elif primary and behavior_id:
        lines.append(f"trace: {primary}/{behavior_id}")
    elif primary:
        lines.append(f"trace: {primary}/behavior")
    elif isinstance(obj.get("testData"), str) and "trace:" in obj["testData"].lower():
        pass

    if primary:
        lines.append(f"primaryBucket: {primary}")
    if behavior_id:
        lines.append(f"behaviorId: {behavior_id}")
    if req_ids:
        lines.append(f"requirementIds: {', '.join(req_ids)}")

    scenario = str(obj.get("scenario") or "").strip().upper()
    if scenario in _SCENARIOS:
        lines.append(f"scenario: {scenario}")

    cats = obj.get("category") or obj.get("categories")
    if isinstance(cats, list) and cats:
        lines.append(f"category: {', '.join(str(c).strip() for c in cats if str(c).strip())}")
    elif isinstance(cats, str) and cats.strip():
        lines.append(f"category: {cats.strip()}")

    td = obj.get("testData") if isinstance(obj.get("testData"), dict) else None
    if td is None and isinstance(obj.get("test_data"), dict):
        td = obj.get("test_data")
    if isinstance(td, dict):
        target = td.get("target") if isinstance(td.get("target"), dict) else {}
        scope = str(target.get("scope") or "").strip().lower()
        if scope in ("field", "multi", "aggregate"):
            lines.append(f"target.scope: {scope}")
        if target.get("field"):
            lines.append(f"target.field: {target.get('field')}")
        if target.get("property"):
            lines.append(f"target.property: {target.get('property')}")
        properties = target.get("properties")
        if isinstance(properties, list):
            props = [str(p).strip() for p in properties if str(p).strip()]
            if props:
                lines.append(f"target.properties: {', '.join(props)}")
        if target.get("constraint"):
            lines.append(f"target.constraint: {target.get('constraint')}")
        if target.get("boundary"):
            lines.append(f"target.boundary: {target.get('boundary')}")
        if target.get("value") not in (None, ""):
            lines.append(f"target.value: {target.get('value')}")
        if td.get("input") not in (None, "", {}):
            lines.append(f"input: {_compact_json(td.get('input'))}")
        if td.get("existingState") not in (None, "", {}):
            lines.append(f"existingState: {_compact_json(td.get('existingState'))}")
    elif isinstance(obj.get("testData"), str) and obj["testData"].strip():
        # Keep legacy free-text markers (avoid duplicating if we already built structured lines)
        legacy = obj["testData"].strip()
        if not lines:
            return legacy
        # Append legacy lines that are not already present as keys
        existing_keys = {ln.split(":", 1)[0].strip().lower() for ln in lines if ":" in ln}
        for ln in legacy.splitlines():
            k = ln.split(":", 1)[0].strip().lower() if ":" in ln else ""
            if k and k in existing_keys:
                continue
            if ln.strip():
                lines.append(ln.strip())

    hints = obj.get("testDataHints") or obj.get("test_data_hints") or {}
    if isinstance(hints, dict):
        lh = hints.get("layerHint")
        ss = hints.get("sourceSignal")
        if lh not in (None, "", "null"):
            lines.append(f"layerHint: {lh}")
        if ss not in (None, "", "null"):
            lines.append(f"sourceSignal: {ss}")

    status = str(obj.get("status") or "").strip()
    if status:
        lines.append(f"status: {status}")

    return "\n".join(lines).strip()


def flatten_unit_tc_ir(
    obj: dict[str, Any],
    *,
    field_aliases: dict[str, list[str]] | None = None,
) -> dict[str, Any]:
    """
    Normalize one TC object to the flat shape expected by TestCaseDraft / DB.
    Legacy flat TCs pass through with light enrichment when IR keys exist.
    """
    if not isinstance(obj, dict):
        return {}

    from app.services.unit_tc_ir_ready import apply_unit_tc_ir_readiness

    out = dict(obj)

    if looks_like_unit_tc_ir(obj):
        # Source-independent TC Gen preserves human labels/input. Backend
        # properties are bound only by IDE Repository Intelligence during Approve.
        apply_unit_tc_ir_readiness(out)
        out["steps"] = _join_steps(out.get("steps"))
        out["expectedResult"] = _join_expected(
            out.get("expectedResult")
            or out.get("expected_result")
            or out.get("expected")
        )
        pre = _join_preconditions(out)
        if pre:
            out["precondition"] = pre
        # Serialize the normalized object. Binding/readiness mutate `out`; using
        # the original object loses property/input/status and creates dual status.
        out["testData"] = build_unit_ir_test_data(out)
        # Prefer feature module from title bracket or leave module for caller
        if not out.get("module") and out.get("title"):
            title = str(out["title"])
            if title.startswith("[") and "]" in title:
                out["module"] = title[1 : title.index("]")].strip() or out.get("module")
        out.setdefault("type", "Unit")
        # TC generation can only be grounding-ready. Codegen readiness is
        # derived after authoritative Approve source grounding.
        out["automationReady"] = False
        out["automation_ready"] = False
    elif obj.get("primaryBucket") or obj.get("behaviorId") or (
        isinstance(obj.get("trace"), dict)
    ):
        # Partial IR markers on otherwise flat TC — merge into testData
        existing = str(obj.get("testData") or obj.get("test_data") or "").strip()
        built = build_unit_ir_test_data(obj)
        if built:
            if existing and "behaviorId:" not in existing.lower():
                out["testData"] = f"{built}\n{existing}".strip()
            elif not existing:
                out["testData"] = built

    return out
