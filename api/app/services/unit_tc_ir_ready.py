"""
Unit TC IR readiness — decide whether content is ready for source grounding.

Portable gates (no product nouns). Used at flatten + post-gen filter.
"""

from __future__ import annotations

import json
import re
from typing import Any

_ALLOWED_OBSERVABLES = frozenset(
    {
        "validate",
        "validation",
        "reject",
        "throw",
        "exception",
        "persist",
        "query",
        "filter",
        "create",
        "update",
        "delete",
        "read",
        "duplicate",
        "unique",
        "notfound",
        "not_found",
        "accessdenied",
        "authorization",
        "authz",
        "state",
        "transfer",
        "assign",
        "unassign",
    }
)

_PLACEHOLDER_FIELD_RE = re.compile(
    r"(?i)\[?\s*chưa\s+xác\s+định|not\s+determined|unknown\s+field|\[?\s*tbd\s*\]?",
)

_GENERIC_ASSERT_RE = re.compile(
    r"(?i)\b("
    r"assert\s+(ok|pass|thành\s*công|success)|"
    r"\bNot\.Null\b|toBeTruthy|toBeDefined|Should\.NotBeNull"
    r")\b"
)

_MAXLENGTH_IN_CONSTRAINT_RE = re.compile(
    r"(?i)max\s*length|maxlength|stringlength|\d+\s*ký\s*tự",
)

_STATUS_READY_RE = re.compile(
    r"(?i)^status\s*:\s*(READY_FOR_GROUNDING|READY_FOR_CODEGEN)\s*$"
)
_STATUS_NOT_READY_RE = re.compile(r"(?i)^status\s*:\s*NOT_READY\s*$")
_PRIMARY_BUCKET_RE = re.compile(r"(?i)^primaryBucket\s*:\s*(\S+)")
_BEHAVIOR_ID_RE = re.compile(r"(?i)^behaviorId\s*:\s*(\S+)")
_TARGET_FIELD_RE = re.compile(r"(?i)^target\.field\s*:\s*(.+)$")
_TARGET_PROPERTY_RE = re.compile(r"(?i)^target\.property\s*:\s*(.+)$")
_TARGET_CONSTRAINT_RE = re.compile(r"(?i)^target\.constraint\s*:\s*(.+)$")
_SOURCE_SIGNAL_RE = re.compile(r"(?i)^sourceSignal\s*:\s*\S")
_INPUT_LINE_RE = re.compile(r"(?i)^input\s*:\s*(.+)$")
_TRACE_PRIMARY_RE = re.compile(
    r"(?i)^trace\s*:\s*(BUSINESS_RULES|VALIDATION_DATA|ERROR_HANDLING|ACCEPTANCE)/",
)


def _as_list(v: Any) -> list[str]:
    if v is None:
        return []
    if isinstance(v, list):
        return [str(x).strip() for x in v if str(x).strip()]
    s = str(v).strip()
    return [s] if s else []


def _parse_input_keys_from_line(line: str) -> list[str]:
    raw = line.strip()
    if not raw.startswith("{"):
        return []
    try:
        obj = json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return []
    if not isinstance(obj, dict):
        return []
    return [str(k) for k in obj.keys()]


def _vi_key(key: str) -> bool:
    if re.match(r"^[A-Za-z_][\w]*$", key):
        return False
    return bool(re.search(r"[^\x00-\x7F]", key))


def decide_unit_tc_ir_ready(obj: dict[str, Any]) -> tuple[bool, list[str]]:
    """
    Return (ready_for_grounding, refuse_reasons).
    This phase is source-independent: BE property binding and implementation
    evidence belong to Approve, never to TC content generation.
    """
    reasons: list[str] = []

    primary = str(obj.get("primaryBucket") or obj.get("primary_bucket") or "").strip().upper()
    if not primary:
        reasons.append("FAIL_NO_PRIMARY_BUCKET")
    elif primary not in (
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
    ):
        reasons.append("FAIL_PRIMARY_BUCKET")

    trace = obj.get("trace") if isinstance(obj.get("trace"), dict) else {}
    behavior_id = str(
        (trace or {}).get("behaviorId")
        or (trace or {}).get("behavior_id")
        or obj.get("behaviorId")
        or ""
    ).strip()
    req_ids = _as_list((trace or {}).get("requirementIds") or obj.get("requirementIds"))
    if not behavior_id and not req_ids:
        reasons.append("FAIL_NO_BEHAVIOR_ID")

    expected = obj.get("expectedResult") or obj.get("expected_result") or {}
    obs = ""
    if isinstance(expected, dict):
        obs = str(expected.get("observable") or "").strip().lower()
    if not obs:
        reasons.append("FAIL_NO_OBSERVABLE")
    elif obs not in _ALLOWED_OBSERVABLES and not any(
        tok in obs for tok in _ALLOWED_OBSERVABLES
    ):
        reasons.append("FAIL_OBSERVABLE_UNKNOWN")

    td = obj.get("testData") if isinstance(obj.get("testData"), dict) else {}
    if not isinstance(td, dict):
        td = obj.get("test_data") if isinstance(obj.get("test_data"), dict) else {}

    target = td.get("target") if isinstance(td.get("target"), dict) else {}
    field_label = str(target.get("field") or "").strip()
    constraint = str(target.get("constraint") or "").strip()
    if primary == "VALIDATION_DATA":
        if not field_label:
            reasons.append("FAIL_VAL_NO_FIELD")
        elif _PLACEHOLDER_FIELD_RE.search(field_label):
            reasons.append("FAIL_FIELD_PLACEHOLDER")
        if not constraint:
            reasons.append("FAIL_VAL_NO_CONSTRAINT")

    steps_blob = ""
    steps = obj.get("steps")
    if isinstance(steps, dict):
        steps_blob = "\n".join(
            _as_list(steps.get("prepare")) + _as_list(steps.get("execute"))
        )
    elif isinstance(steps, str):
        steps_blob = steps

    expected_desc = ""
    if isinstance(expected, dict):
        expected_desc = str(expected.get("description") or "")
    elif isinstance(expected, str):
        expected_desc = expected

    text = f"{steps_blob}\n{expected_desc}"
    if _GENERIC_ASSERT_RE.search(text) and obs:
        token = obs.replace("_", " ")
        if obs not in text.lower() and token not in text.lower():
            reasons.append("FAIL_GENERIC_ASSERT")

    return (len(reasons) == 0, reasons)


def apply_unit_tc_ir_readiness(obj: dict[str, Any]) -> dict[str, Any]:
    """Mutate generation status; automation is never ready before Approve."""
    ready, reasons = decide_unit_tc_ir_ready(obj)
    if ready:
        obj["status"] = "READY_FOR_GROUNDING"
        obj["automationReady"] = False
        obj.pop("_irReadyRefuse", None)
    else:
        obj["status"] = "NOT_READY"
        obj["automationReady"] = False
        obj["_irReadyRefuse"] = reasons
    return obj


def parse_markers_from_test_data(test_data: str | None) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (test_data or "").splitlines():
        if ":" not in line:
            continue
        k, _, v = line.partition(":")
        out[k.strip().lower()] = v.strip()
    return out


def decide_unit_tc_markers_ready(
    *,
    test_data: str | None = None,
    steps: str | None = None,
    expected_result: str | None = None,
) -> tuple[bool, list[str]]:
    """Flat test_data marker readiness (post-flatten / filter pass)."""
    td = test_data or ""
    markers = parse_markers_from_test_data(td)
    reasons: list[str] = []

    if _STATUS_NOT_READY_RE.search(td):
        return False, ["FAIL_STATUS_NOT_READY"]

    primary = (markers.get("primarybucket") or "").upper()
    if not primary and not _TRACE_PRIMARY_RE.search(td):
        if markers.get("behaviorid") or markers.get("target.field"):
            reasons.append("FAIL_NO_PRIMARY_BUCKET")

    if primary == "VALIDATION_DATA" or "validation_data" in td.lower():
        field = markers.get("target.field") or ""
        if not field:
            reasons.append("FAIL_VAL_NO_FIELD")
        elif _PLACEHOLDER_FIELD_RE.search(field):
            reasons.append("FAIL_FIELD_PLACEHOLDER")
        if not markers.get("target.constraint"):
            reasons.append("FAIL_VAL_NO_CONSTRAINT")
    if _STATUS_READY_RE.search(td) and reasons:
        return False, reasons

    if reasons:
        return False, reasons
    return True, []
