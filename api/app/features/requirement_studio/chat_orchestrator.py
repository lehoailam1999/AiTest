"""Chat orchestrator — Knowledge-only turns + knowledgeDiff apply (R5, BR-V2-17)."""

from __future__ import annotations

import copy
import json
import re
from typing import Any

from app.llm.base import strip_code_fences
from app.features.requirement_studio.knowledge_builder import (
    normalize_knowledge_payload,
)

LIST_PATHS = (
    "features",
    "actors",
    "useCases",
    "businessRules",
    "validationRules",
    "apiSummary",
    "exceptions",
    "acceptanceCriteria",
    "constraints",
    "gaps",
    # Legacy paths still accepted
    "glossary",
    "databaseSummary",
    "openQuestions",
    "missingInformation",
)

_PATH_ALIASES = {
    "openQuestions": "gaps",
    "missingInformation": "gaps",
}


def empty_diff() -> dict[str, Any]:
    return {"ops": [], "summary": ""}


def apply_knowledge_diff(
    payload: dict[str, Any], diff: dict[str, Any] | None
) -> tuple[dict[str, Any], list[dict[str, Any]]]:
    """
    Apply knowledgeDiff ops onto a copy of payload.
    Returns (new_payload, applied_ops).
    """
    out = copy.deepcopy(payload or {})
    for key in LIST_PATHS:
        out.setdefault(key, [])
    out.setdefault("summary", out.get("summary") or "")

    applied: list[dict[str, Any]] = []
    ops = (diff or {}).get("ops") or []
    if not isinstance(ops, list):
        return normalize_knowledge_payload(out), applied

    for raw_op in ops:
        if not isinstance(raw_op, dict):
            continue
        op = (raw_op.get("op") or "").strip().lower()
        path = (raw_op.get("path") or "").strip()
        path = _PATH_ALIASES.get(path, path)
        if path == "summary" and op in ("set", "update", "replace"):
            val = raw_op.get("value")
            if isinstance(val, str) and val.strip():
                out["summary"] = val.strip()[:4000]
                applied.append({"op": "set", "path": "summary", "value": out["summary"]})
            continue
        if path not in LIST_PATHS:
            continue
        items = out.get(path)
        if not isinstance(items, list):
            items = []
            out[path] = items

        if op == "add":
            value = raw_op.get("value")
            if isinstance(value, dict):
                items.append(value)
                applied.append({"op": "add", "path": path, "value": value})
            elif isinstance(value, str) and value.strip():
                normalized = _normalize_list_item(path, value.strip())
                items.append(normalized)
                applied.append({"op": "add", "path": path, "value": normalized})
        elif op in ("update", "replace"):
            match = raw_op.get("match") or {}
            value = raw_op.get("value")
            if not isinstance(value, dict):
                continue
            idx = _find_index(items, match if isinstance(match, dict) else {})
            if idx >= 0:
                items[idx] = {**items[idx], **value}
                applied.append(
                    {"op": "update", "path": path, "match": match, "value": items[idx]}
                )
        elif op == "remove":
            match = raw_op.get("match") or {}
            idx = _find_index(items, match if isinstance(match, dict) else {})
            if idx >= 0:
                removed = items.pop(idx)
                applied.append({"op": "remove", "path": path, "value": removed})

    for i, rule in enumerate(out.get("businessRules") or [], start=1):
        if isinstance(rule, dict) and not rule.get("id"):
            rule["id"] = f"BR-{i}"

    return normalize_knowledge_payload(out), applied


def _normalize_list_item(path: str, text: str) -> dict[str, Any]:
    if path == "businessRules":
        return {"id": "", "text": text}
    if path == "actors":
        return {"name": text, "description": "", "permissions": ""}
    if path == "useCases":
        return {"name": text, "steps": ""}
    if path == "features":
        return {"name": text, "description": ""}
    if path == "validationRules":
        return {"field": "", "rule": text}
    if path in ("exceptions", "acceptanceCriteria", "gaps", "constraints"):
        return {"text": text}
    if path == "glossary":
        if ":" in text:
            term, definition = text.split(":", 1)
            return {"term": term.strip(), "definition": definition.strip()}
        return {"term": text, "definition": ""}
    if path == "apiSummary":
        m = re.match(r"(?i)^(GET|POST|PUT|PATCH|DELETE)\s+(\S+)(?:\s+(.*))?$", text)
        if m:
            return {
                "method": m.group(1).upper(),
                "path": m.group(2),
                "note": (m.group(3) or "").strip(),
            }
        return {"method": "GET", "path": text, "note": ""}
    if path == "databaseSummary":
        return {"entity": text, "note": ""}
    return {"text": text}


def _find_index(items: list, match: dict) -> int:
    if not match:
        return -1
    for i, it in enumerate(items):
        if not isinstance(it, dict):
            continue
        ok = True
        for k, v in match.items():
            if str(it.get(k, "")).strip().lower() != str(v).strip().lower():
                ok = False
                break
        if ok:
            return i
    return -1


def parse_chat_llm_json(raw: str) -> dict[str, Any] | None:
    text = strip_code_fences(raw or "").strip()
    if not text:
        return None
    try:
        start = text.find("{")
        end = text.rfind("}")
        if start >= 0 and end > start:
            text = text[start : end + 1]
        data = json.loads(text)
    except Exception:
        return None
    if not isinstance(data, dict):
        return None
    reply = data.get("reply")
    if not isinstance(reply, str) or not reply.strip():
        return None
    diff = data.get("knowledgeDiff") or data.get("knowledge_diff") or empty_diff()
    if not isinstance(diff, dict):
        diff = empty_diff()
    diff.setdefault("ops", [])
    diff.setdefault("summary", "")
    return {"reply": reply.strip(), "knowledgeDiff": diff}


def chat_system_prompt() -> str:
    from app.llm.analysis_rules import append_analysis_chat_diff_rules

    base = (
        "You are a requirements analyst assistant for AITest Requirement Studio. "
        "You may ONLY use the provided Knowledge Workspace JSON — never invent reading "
        "raw uploaded files. Answer in the user's language (often Vietnamese). "
        "Return ONLY one JSON object with keys: "
        'reply (string), knowledgeDiff ({ops:[], summary:string}). '
        "ops items: {op:add|update|remove|set, path: features|actors|useCases|"
        "businessRules|validationRules|apiSummary|exceptions|acceptanceCriteria|"
        "constraints|gaps|summary, "
        "value?:object|string, match?:object}. "
        "Legacy paths openQuestions|missingInformation map to gaps. "
        "If the user only asks a question, keep ops empty. "
        "If they ask to add/fix knowledge, include precise ops."
    )
    return append_analysis_chat_diff_rules(base)


def heuristic_chat_turn(
    user_message: str, payload: dict[str, Any]
) -> dict[str, Any]:
    """Offline fallback when LLM is unavailable — BR-V2-17 still holds (Knowledge only)."""
    msg = (user_message or "").strip()
    low = msg.lower()
    diff = empty_diff()
    ops: list[dict[str, Any]] = []

    add_rule = re.match(
        r"(?i)^\s*(?:thêm|add)\s+(?:business\s*)?rule\s*[:\-–]\s*(.+)$", msg
    )
    if add_rule:
        text = add_rule.group(1).strip()
        ops.append({"op": "add", "path": "businessRules", "value": {"id": "", "text": text}})
        diff = {"ops": ops, "summary": f"Thêm Business Rule: {text[:80]}"}
        return {
            "reply": f"Đã ghi nhận Business Rule mới vào Knowledge:\n«{text}»",
            "knowledgeDiff": diff,
        }

    add_term = re.match(
        r"(?i)^\s*(?:thêm|add)\s+(?:thuật ngữ|glossary|term)\s*[:\-–]\s*(.+)$", msg
    )
    if add_term:
        text = add_term.group(1).strip()
        ops.append({"op": "add", "path": "glossary", "value": text})
        diff = {"ops": ops, "summary": f"Thêm glossary: {text[:80]}"}
        return {
            "reply": f"Đã thêm thuật ngữ vào Glossary:\n«{text}»",
            "knowledgeDiff": diff,
        }

    add_actor = re.match(
        r"(?i)^\s*(?:thêm|add)\s+actor\s*[:\-–]\s*(.+)$", msg
    )
    if add_actor:
        name = add_actor.group(1).strip()
        ops.append({"op": "add", "path": "actors", "value": {"name": name, "description": ""}})
        diff = {"ops": ops, "summary": f"Thêm Actor: {name}"}
        return {
            "reply": f"Đã thêm Actor «{name}» vào Knowledge.",
            "knowledgeDiff": diff,
        }

    # Q&A over knowledge text
    blob_parts: list[str] = [str(payload.get("summary") or "")]
    for key in LIST_PATHS:
        for it in payload.get(key) or []:
            if isinstance(it, dict):
                blob_parts.append(" ".join(str(v) for v in it.values() if v))
    blob = "\n".join(blob_parts)

    if any(k in low for k in ("tóm tắt", "summary", "tổng quan")):
        summary = (payload.get("summary") or "").strip() or "Chưa có tóm tắt trong Knowledge."
        return {"reply": summary, "knowledgeDiff": empty_diff()}

    if "rule" in low or "business" in low or "ràng buộc" in low:
        rules = payload.get("businessRules") or []
        if not rules:
            return {
                "reply": "Knowledge chưa có Business Rules. Bạn có thể gửi: Thêm rule: …",
                "knowledgeDiff": empty_diff(),
            }
        lines = [f"- {r.get('id', 'BR')}: {r.get('text', '')}" for r in rules[:12] if isinstance(r, dict)]
        return {
            "reply": "Business Rules hiện có:\n" + "\n".join(lines),
            "knowledgeDiff": empty_diff(),
        }

    if "thiếu" in low or "missing" in low or "gap" in low:
        missing = payload.get("missingInformation") or []
        if not missing:
            return {
                "reply": "Không thấy mục Missing Information trong Knowledge hiện tại.",
                "knowledgeDiff": empty_diff(),
            }
        lines = [f"- {m.get('text', m)}" for m in missing[:12] if isinstance(m, dict) or isinstance(m, str)]
        return {
            "reply": "Missing Information:\n" + "\n".join(lines),
            "knowledgeDiff": empty_diff(),
        }

    # Keyword search snippet
    tokens = [t for t in re.split(r"\W+", low) if len(t) >= 4][:6]
    hits: list[str] = []
    for line in blob.splitlines():
        l = line.strip()
        if not l:
            continue
        if any(t in l.lower() for t in tokens):
            hits.append(l[:240])
        if len(hits) >= 5:
            break
    if hits:
        return {
            "reply": "Dựa trên Knowledge hiện có:\n- " + "\n- ".join(hits),
            "knowledgeDiff": empty_diff(),
        }

    return {
        "reply": (
            "Tôi chỉ làm việc trên Knowledge Workspace (không đọc lại file upload). "
            "Bạn có thể hỏi tóm tắt / rules / missing, hoặc cập nhật bằng:\n"
            "• Thêm rule: …\n• Thêm actor: …\n• Thêm thuật ngữ: Term: định nghĩa"
        ),
        "knowledgeDiff": empty_diff(),
    }
