"""
Portable VI label → BE property binding for Unit TC IR (gen phase).

No product nouns — uses Latin identifiers, optional project field aliases from
Knowledge hints, and heuristics on target.field / input keys.
"""

from __future__ import annotations

import json
import re
import unicodedata
from typing import Any

# Latin identifier (PascalCase / camelCase property name)
_LATIN_ID_RE = re.compile(r"^[A-Za-z_][\w]*$")

# Vietnamese diacritics or common VI-only label chars in keys/labels
_VI_CHAR_RE = re.compile(
    r"[\u00C0-\u024F\u1E00-\u1EFF]|"
    r"đ|Đ|"
    r"[^\x00-\x7F]"
)

_PLACEHOLDER_FIELD_RE = re.compile(
    r"(?i)\[?\s*chưa\s+xác\s+định|not\s+determined|unknown\s+field|\[?\s*tbd\s*\]?",
)

# Optional aliases: {"Địa điểm thu giữ": ["SeizureLocation"], ...}
FieldAliasMap = dict[str, list[str]]


def _norm_label(s: str) -> str:
    t = unicodedata.normalize("NFD", (s or "").strip().lower())
    return "".join(c for c in t if unicodedata.category(c) != "Mn")


def _parse_field_aliases(raw: Any) -> FieldAliasMap:
    if not isinstance(raw, dict):
        return {}
    fields = raw.get("fields")
    if not isinstance(fields, dict):
        return {}
    out: FieldAliasMap = {}
    for label, props in fields.items():
        if not label:
            continue
        if isinstance(props, str):
            props = [props]
        if isinstance(props, list):
            out[str(label).strip()] = [
                str(p).strip() for p in props if str(p).strip()
            ]
    return out


def _input_keys(input_val: Any) -> list[str]:
    if not isinstance(input_val, dict):
        return []
    return [str(k).strip() for k in input_val.keys() if str(k).strip()]


def _key_looks_vietnamese(key: str) -> bool:
    if _LATIN_ID_RE.match(key):
        return False
    return bool(_VI_CHAR_RE.search(key))


def _field_label_needs_bind(field: str) -> bool:
    if not field or _LATIN_ID_RE.match(field):
        return False
    return bool(_VI_CHAR_RE.search(field) or " " in field)


def bind_unit_tc_field(
    obj: dict[str, Any],
    *,
    field_aliases: FieldAliasMap | None = None,
) -> tuple[dict[str, Any], list[str]]:
    """
    Enrich IR dict with target.property, normalized input, layerHint/sourceSignal hints.
    Returns (mutated_obj, refuse_reasons) — non-empty refuse → caller should NOT_READY.
    """
    reasons: list[str] = []
    aliases = field_aliases or {}

    td = obj.get("testData")
    if not isinstance(td, dict):
        td = obj.get("test_data") if isinstance(obj.get("test_data"), dict) else {}
    if not isinstance(td, dict):
        return obj, reasons

    target = td.get("target") if isinstance(td.get("target"), dict) else {}
    field_label = str(target.get("field") or "").strip()
    constraint = str(target.get("constraint") or "").strip()

    if field_label and _PLACEHOLDER_FIELD_RE.search(field_label):
        reasons.append("FAIL_FIELD_PLACEHOLDER")

    property_name = str(target.get("property") or "").strip()
    if not property_name and field_label and _LATIN_ID_RE.match(field_label):
        property_name = field_label
        target["property"] = property_name

    if not property_name and field_label:
        for alias_label, props in aliases.items():
            if _norm_label(alias_label) == _norm_label(field_label) and props:
                property_name = props[0]
                target["property"] = property_name
                break
        if not property_name:
            for alias_label, props in aliases.items():
                nl = _norm_label(field_label)
                al = _norm_label(alias_label)
                if al and (al in nl or nl in al) and props:
                    property_name = props[0]
                    target["property"] = property_name
                    break

    input_val = td.get("input")
    keys = _input_keys(input_val)
    vi_keys = [k for k in keys if _key_looks_vietnamese(k)]
    latin_keys = [k for k in keys if _LATIN_ID_RE.match(k)]
    field_needs_bind = _field_label_needs_bind(field_label)

    if property_name and isinstance(input_val, dict) and keys:
        if property_name not in keys and len(keys) == 1:
            only_key = keys[0]
            if only_key != property_name:
                val = input_val.get(only_key)
                td["input"] = {property_name: val}
                obj.setdefault("_fieldBind", {})["remappedInput"] = True
        elif property_name not in keys and field_needs_bind:
            reasons.append("FAIL_INPUT_PROPERTY_MISMATCH")

    if field_needs_bind and not property_name:
        if vi_keys or keys:
            reasons.append("FAIL_FIELD_UNBOUND")
    elif vi_keys and not property_name:
        reasons.append("FAIL_FIELD_UNBOUND")

    td["target"] = target
    obj["testData"] = td

    hints = obj.get("testDataHints") or obj.get("test_data_hints") or {}
    if not isinstance(hints, dict):
        hints = {}

    primary = str(obj.get("primaryBucket") or obj.get("primary_bucket") or "").upper()
    if primary == "VALIDATION_DATA" and property_name and constraint:
        if not hints.get("layerHint"):
            hints["layerHint"] = "dto"
        if not hints.get("sourceSignal") and constraint:
            kw = constraint.split(";")[0].strip()[:80]
            hints["sourceSignal"] = f"{property_name} {kw}"
        obj["testDataHints"] = hints

    return obj, reasons


def field_aliases_from_knowledge_pack(pack: dict[str, Any] | None) -> FieldAliasMap:
    """Optional field aliases embedded in MSC / knowledge context payload."""
    if not isinstance(pack, dict):
        return {}
    fa = pack.get("fieldAliases") or pack.get("field_aliases")
    return _parse_field_aliases({"fields": fa} if isinstance(fa, dict) else {})
