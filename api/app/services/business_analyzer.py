"""P9 — Business Analyzer: TC → BusinessIntent (no source code)."""

from __future__ import annotations

import json
import re
from typing import Any


def build_analyze_intent_prompts(
    *,
    title: str,
    module: str | None,
    steps: str,
    expected: str,
    precondition: str | None,
    test_data: str | None,
    tc_type: str | None = None,
) -> tuple[str, str]:
    system = (
        "You are a QA business analyst for an enterprise software product.\n"
        "Given a Test Case written in business language (often Vietnamese), extract structured "
        "business intent ONLY. Do NOT invent source file paths, class names that you cannot infer, "
        "or implementation details. Do NOT read or assume repository layout.\n\n"
        "Return ONLY one JSON object (no markdown fences) with this exact shape:\n"
        "{\n"
        '  "action": "Create|Update|Delete|Read|Authenticate|Approve|Upload|Process|Other",\n'
        '  "entity": "PascalCaseOrEnglishNoun",\n'
        '  "expectedResults": ["short bullet", "..."],\n'
        '  "businessRules": ["..."],\n'
        '  "validationRules": ["..."],\n'
        '  "externalDeps": ["Email|FileStorage|AuditLog|Payment|..."],\n'
        '  "domainTerms": ["vn or en terms from TC"],\n'
        '  "searchHints": ["Evidence","EvidenceService","CreateEvidence", "..."]\n'
        "}\n\n"
        "Rules:\n"
        "- action: one primary verb from the TC.\n"
        "- entity: main business noun in English PascalCase when possible "
        "(vật chứng→Evidence, hồ sơ→CaseRecord, người dùng→User).\n"
        "- expectedResults: 1–8 concrete outcomes from Expected / Steps.\n"
        "- searchHints: 5–16 short identifiers useful later for IDE symbol search "
        "(Entity, EntityService, EntityCommand, EntityRepository, CreateEntity, …). "
        "No full sentences.\n"
        "- If unsure, use empty arrays; never fabricate APIs."
    )
    lines = [
        "## Test case (business only — no source)",
        f"Title: {title}",
        f"Type: {tc_type or '—'}",
        f"Module: {module or '—'}",
        f"Precondition: {precondition or '—'}",
        f"Steps:\n{steps or '—'}",
        f"Expected:\n{expected or '—'}",
        f"Test data: {test_data or '—'}",
    ]
    return system, "\n".join(lines)


def _as_str_list(value: Any, *, max_items: int, max_len: int = 200) -> list[str]:
    if not isinstance(value, list):
        return []
    out: list[str] = []
    seen: set[str] = set()
    for item in value:
        s = str(item).strip()
        if not s or len(s) > max_len:
            continue
        key = s.lower()
        if key in seen:
            continue
        seen.add(key)
        out.append(s)
        if len(out) >= max_items:
            break
    return out


def _normalize_action(raw: str) -> str:
    a = (raw or "").strip()
    allowed = {
        "Create",
        "Update",
        "Delete",
        "Read",
        "Authenticate",
        "Approve",
        "Upload",
        "Process",
        "Other",
    }
    for name in allowed:
        if a.lower() == name.lower():
            return name
    # light map
    low = a.lower()
    if any(x in low for x in ("create", "tạo", "thêm", "add")):
        return "Create"
    if any(x in low for x in ("update", "cập nhật", "sửa")):
        return "Update"
    if any(x in low for x in ("delete", "xóa", "xoá")):
        return "Delete"
    if any(x in low for x in ("login", "auth", "đăng nhập")):
        return "Authenticate"
    return "Process"


def _normalize_entity(raw: str, fallback: str = "Unknown") -> str:
    s = re.sub(r"[^A-Za-z0-9_\s]", "", (raw or "").strip())
    s = re.sub(r"\s+", " ", s).strip()
    if not s:
        return fallback
    # PascalCase-ish
    parts = re.split(r"[\s_]+", s)
    return "".join(p[:1].upper() + p[1:] for p in parts if p)[:64] or fallback


def parse_business_intent_json(raw: str) -> dict[str, Any]:
    text = (raw or "").strip()
    if text.startswith("```"):
        text = re.sub(r"^```(?:json)?\s*", "", text, flags=re.I)
        text = re.sub(r"\s*```$", "", text)
    try:
        data = json.loads(text)
    except json.JSONDecodeError:
        m = re.search(r"\{[\s\S]*\}", text)
        if not m:
            raise ValueError("LLM không trả JSON BusinessIntent hợp lệ")
        data = json.loads(m.group(0))
    if not isinstance(data, dict):
        raise ValueError("BusinessIntent phải là object JSON")

    action = _normalize_action(str(data.get("action") or "Process"))
    entity = _normalize_entity(str(data.get("entity") or "Unknown"))
    expected = _as_str_list(data.get("expectedResults"), max_items=8)
    business_rules = _as_str_list(data.get("businessRules"), max_items=8)
    validation_rules = _as_str_list(data.get("validationRules"), max_items=8)
    external_deps = _as_str_list(data.get("externalDeps"), max_items=8)
    domain_terms = _as_str_list(data.get("domainTerms"), max_items=12)
    search_hints = _as_str_list(data.get("searchHints"), max_items=16)

    # Ensure minimum search hints from entity/action
    if entity and entity != "Unknown":
        for h in (
            entity,
            f"{entity}Service",
            f"{entity}Command",
            f"{entity}Handler",
            f"{entity}Repository",
            f"{action}{entity}" if action not in ("Process", "Other", "Read") else entity,
        ):
            if h and h.lower() not in {x.lower() for x in search_hints}:
                search_hints.append(h)
            if len(search_hints) >= 16:
                break

    return {
        "action": action,
        "entity": entity,
        "expectedResults": expected,
        "businessRules": business_rules,
        "validationRules": validation_rules,
        "externalDeps": external_deps,
        "domainTerms": domain_terms or ([entity] if entity != "Unknown" else []),
        "searchHints": search_hints[:16],
        "source": "llm",
    }


def heuristic_business_intent(
    *,
    title: str,
    module: str | None,
    steps: str,
    expected: str,
    precondition: str | None = None,
    test_data: str | None = None,
) -> dict[str, Any]:
    """Fallback when LLM fails — mirrors Desktop local analyzer (no source)."""
    blob = "\n".join(
        x for x in [title, precondition or "", steps, expected, test_data or ""] if x
    )
    action = "Process"
    pairs = [
        (r"tạo|create|thêm|add|insert|đăng\s*ký", "Create"),
        (r"cập\s*nhật|update|sửa|edit", "Update"),
        (r"xóa|xoá|delete|remove", "Delete"),
        (r"xem|get|đọc|read|list|tìm|search", "Read"),
        (r"đăng\s*nhập|login|auth", "Authenticate"),
        (r"duyệt|approve|reject", "Approve"),
        (r"upload|tải\s*lên", "Upload"),
    ]
    for pat, act in pairs:
        if re.search(pat, blob, re.I):
            action = act
            break

    cleaned = re.sub(
        r"tạo|create|thêm|cập\s*nhật|update|xóa|xoá|delete|xem|get|thành\s*công|thất\s*bại|khi|với|của|một|các",
        " ",
        title or "",
        flags=re.I,
    )
    parts = [p for p in cleaned.split() if len(p) > 2]
    entity_raw = parts[-1] if parts else (module or "Unknown")
    entity = _normalize_entity(entity_raw)

    expected_results = [
        line.strip()
        for line in re.split(r"[\r\n;•|]+", expected or "")
        if line.strip() and len(line.strip()) > 2
    ][:8]
    if not expected_results and re.search(r"thành\s*công|success", title or "", re.I):
        expected_results = ["Operation succeeds"]

    external: list[str] = []
    if re.search(r"email|mail|smtp", blob, re.I):
        external.append("Email")
    if re.search(r"upload|file|ảnh|image|s3|blob", blob, re.I):
        external.append("FileStorage")
    if re.search(r"audit|nhật\s*ký|\blog\b", blob, re.I):
        external.append("AuditLog")

    validation: list[str] = []
    if re.search(r"bắt\s*buộc|required|không\s*được\s*rỗng", blob, re.I):
        validation.append("Required fields must be present")
    business: list[str] = []
    if re.search(r"quyền|permission|role|authorize", blob, re.I):
        business.append("Authorization / role check")

    base = {
        "action": action,
        "entity": entity,
        "expectedResults": expected_results,
        "businessRules": business,
        "validationRules": validation,
        "externalDeps": external,
        "domainTerms": [t for t in [module, entity] if t][:12],
        "searchHints": [],
        "source": "heuristic",
    }
    intent = parse_business_intent_json(json.dumps(base))
    intent["source"] = "heuristic"
    return intent
