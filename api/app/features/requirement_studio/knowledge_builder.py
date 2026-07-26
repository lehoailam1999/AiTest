"""Heuristic (+ optional LLM) Knowledge Builder from document chunks (R3).

Criteria aligned with SRS readiness for Generate TC:
summary, features, actors, useCases, businessRules, validationRules,
apiSummary, exceptions, acceptanceCriteria, constraints, gaps.
Legacy keys (glossary, databaseSummary, openQuestions, missingInformation)
are dual-written for compatibility and folded via normalize.
"""

from __future__ import annotations

import json
import re
from typing import Any

from app.llm.base import strip_code_fences

MAX_CHUNK_CHARS_FOR_BUILD = 24_000
MAX_ITEMS = 40
MAX_GAPS = 20

_API_RE = re.compile(
    r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_\-./{}:]+)",
    re.IGNORECASE,
)
_ACTOR_LINE_RE = re.compile(
    r"(?i)^\s*(?:[-*•]\s*)?(?:actor|vai trò|role|persona|người dùng|user|admin|hệ thống)\s*[:\-–]\s*(.+)$"
)
_RULE_HINT = re.compile(
    r"(?i)\b(phải|bắt buộc|không được|cấm|shall|must|should not|required)\b"
)
# Tight gaps — avoid treating every "?" as an open question
_GAP_HINT = re.compile(
    r"(?i)\b(TBD|TODO|cần làm rõ|chưa xác định|open question|to be defined|chưa rõ)\b"
)
_USECASE_HEAD = re.compile(
    r"(?i)^(use\s*case|uc[\s\-_]?\d+|luồng|flow|scenario|kịch bản)\b"
)
_FEATURE_HEAD = re.compile(
    r"(?i)^(feature|chức năng|module|epic|capability)[\s\-_:.]+\s*(.+)$"
)
_FEATURE_HEAD_SIMPLE = re.compile(
    r"(?i)^(feature|chức năng|module)\b"
)
_VALIDATION_HINT = re.compile(
    r"(?i)\b(validation|validate|kiểm tra|định dạng|format|max length|min length|"
    r"độ dài|bắt buộc|required field|regex|schema|invalid|unique|không được trống|"
    r"email|số điện thoại|range|từ\s+\d+\s+đến)\b"
)
_EXCEPTION_HINT = re.compile(
    r"(?i)\b(exception|error|lỗi|xử lý lỗi|timeout|retry|fallback|HTTP\s*[45]\d\d|"
    r"403|401|404|500|forbidden|unauthorized|fail|thất bại)\b"
)
_ACCEPTANCE_HINT = re.compile(
    r"(?i)\b(acceptance|given\s|when\s|then\s|done when|tiêu chí chấp nhận|"
    r"điều kiện hoàn thành|AC\s*\d+)\b"
)
_GLOSSARY_RE = re.compile(
    r"(?i)^\s*(?:[-*•]\s*)?([A-Za-zÀ-ỹ0-9][\wÀ-ỹ0-9 \-/]{1,40})\s+(?:là|means|:)\s+(.+)$"
)
_ENTITY_RE = re.compile(
    r"(?i)\b(?:bảng|table|entity|entities|model)\s+[`'\"]?([A-Za-z_][\w]*)[`'\"]?"
)

PRIMARY_LIST_KEYS = (
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
)

LEGACY_LIST_KEYS = (
    "glossary",
    "databaseSummary",
    "openQuestions",
    "missingInformation",
)


def empty_payload() -> dict[str, Any]:
    return {
        "summary": "",
        "features": [],
        "actors": [],
        "useCases": [],
        "businessRules": [],
        "validationRules": [],
        "apiSummary": [],
        "exceptions": [],
        "acceptanceCriteria": [],
        "constraints": [],
        "gaps": [],
        "glossary": [],
        "databaseSummary": [],
        "openQuestions": [],
        "missingInformation": [],
    }


def _dedupe_list(items: list[dict], key: str) -> list[dict]:
    seen: set[str] = set()
    out: list[dict] = []
    for it in items:
        k = str(it.get(key) or "").strip().lower()
        if not k or k in seen:
            continue
        seen.add(k)
        out.append(it)
        if len(out) >= MAX_ITEMS:
            break
    return out


def _as_list(value: Any) -> list:
    return value if isinstance(value, list) else []


def _text_item(row: Any) -> str:
    if isinstance(row, dict):
        for k in ("text", "name", "title", "criterion", "rule", "message"):
            v = row.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return " ".join(str(v).strip() for v in row.values() if v).strip()
    return str(row).strip() if row is not None else ""


def normalize_knowledge_payload(raw: dict[str, Any] | None) -> dict[str, Any]:
    """
    Fold legacy keys into TC-readiness schema; dual-write legacy mirrors.
    Safe to call on every read/write.
    """
    base = empty_payload()
    if not isinstance(raw, dict):
        return base

    summary = raw.get("summary")
    if isinstance(summary, str):
        base["summary"] = summary.strip()
    elif isinstance(summary, list):
        base["summary"] = "\n".join(
            str(x).strip() for x in summary if str(x).strip()
        ).strip()
    elif summary is not None:
        base["summary"] = str(summary).strip()

    for key in PRIMARY_LIST_KEYS:
        if key == "gaps":
            continue
        items = _as_list(raw.get(key))
        if items:
            base[key] = items[:MAX_ITEMS]

    if not base["features"] and base["useCases"]:
        feats: list[dict] = []
        for uc in base["useCases"]:
            if not isinstance(uc, dict):
                continue
            name = str(uc.get("name") or "").strip()
            if name:
                feats.append({"name": name, "description": ""})
        base["features"] = _dedupe_list(feats, "name")

    gaps_in = _as_list(raw.get("gaps"))
    if gaps_in:
        folded: list[dict] = []
        seen_g: set[str] = set()
        for g in gaps_in:
            text = _text_item(g)
            key = text.lower()
            if not text or key in seen_g:
                continue
            seen_g.add(key)
            if isinstance(g, dict) and "text" in g:
                folded.append({"text": str(g["text"])[:500]})
            else:
                folded.append({"text": text[:500]})
            if len(folded) >= MAX_GAPS:
                break
        base["gaps"] = folded
    else:
        merged: list[dict] = []
        seen: set[str] = set()
        for src_key in ("openQuestions", "missingInformation"):
            for row in _as_list(raw.get(src_key)):
                text = _text_item(row)
                key = text.lower()
                if not text or key in seen:
                    continue
                seen.add(key)
                merged.append({"text": text[:500]})
                if len(merged) >= MAX_GAPS:
                    break
            if len(merged) >= MAX_GAPS:
                break
        base["gaps"] = merged

    base["openQuestions"] = list(base["gaps"])
    base["missingInformation"] = list(base["gaps"])
    for key in ("glossary", "databaseSummary"):
        items = _as_list(raw.get(key))
        if items:
            base[key] = items[:MAX_ITEMS]

    if not base["validationRules"] and base["databaseSummary"]:
        for ent in base["databaseSummary"]:
            if not isinstance(ent, dict):
                continue
            name = str(ent.get("entity") or "").strip()
            if not name:
                continue
            note = str(ent.get("note") or "").strip()
            base["validationRules"].append(
                {
                    "field": name,
                    "rule": note or f"Entity/table {name}",
                }
            )
        base["validationRules"] = base["validationRules"][:MAX_ITEMS]

    return base


def build_knowledge_heuristic(
    chunks: list[tuple[str | None, str]],
    *,
    file_names: list[str] | None = None,
) -> dict[str, Any]:
    """
    Extract a readable Knowledge payload from (heading, text) chunks.
    Always available — no LLM required (R3 baseline).
    """
    payload = empty_payload()
    if not chunks:
        payload["gaps"].append(
            {"text": "Chưa có đoạn tài liệu — upload và tách đoạn trước."}
        )
        payload["summary"] = "Knowledge trống."
        return normalize_knowledge_payload(payload)

    headings = [h for h, _ in chunks if h]
    joined_preview = "\n\n".join(
        (f"## {h}\n{t}" if h else t) for h, t in chunks
    )[:1200]

    files = ", ".join(file_names[:8]) if file_names else ""
    summary_bits = []
    if files:
        summary_bits.append(f"Nguồn: {files}.")
    if headings:
        summary_bits.append(
            "Phạm vi / mục chính: " + "; ".join(dict.fromkeys(headings[:12])) + "."
        )
    summary_bits.append(joined_preview[:500].replace("\n", " ").strip())
    payload["summary"] = " ".join(summary_bits).strip()

    features: list[dict] = []
    rules: list[dict] = []
    actors: list[dict] = []
    use_cases: list[dict] = []
    validations: list[dict] = []
    apis: list[dict] = []
    exceptions: list[dict] = []
    acceptance: list[dict] = []
    gaps: list[dict] = []
    constraints: list[dict] = []
    glossary: list[dict] = []
    entities: list[dict] = []

    for heading, text in chunks:
        h = (heading or "").strip()
        body = (text or "").strip()

        if h and _USECASE_HEAD.search(h):
            use_cases.append({"name": h[:200], "steps": body[:800]})

        if h:
            m_feat = _FEATURE_HEAD.match(h)
            if m_feat:
                features.append(
                    {
                        "name": m_feat.group(2).strip()[:200] or h[:200],
                        "description": body[:400],
                    }
                )
            elif _FEATURE_HEAD_SIMPLE.search(h) and not _USECASE_HEAD.search(h):
                features.append({"name": h[:200], "description": body[:400]})

        for line in text.splitlines():
            s = line.strip()
            if not s or len(s) < 8:
                continue

            m_actor = _ACTOR_LINE_RE.match(s)
            if m_actor:
                actors.append(
                    {
                        "name": m_actor.group(1).strip()[:120],
                        "description": "",
                        "permissions": "",
                    }
                )

            if _RULE_HINT.search(s):
                item = {"id": f"BR-{len(rules) + 1}", "text": s[:500]}
                if re.search(
                    r"(?i)\b(performance|bảo mật|security|sla|timeout|audit|logging)\b",
                    s,
                ):
                    constraints.append({"text": s[:500]})
                else:
                    rules.append(item)
                if _VALIDATION_HINT.search(s):
                    validations.append({"field": "", "rule": s[:500]})
            elif _VALIDATION_HINT.search(s):
                validations.append({"field": "", "rule": s[:500]})

            if _EXCEPTION_HINT.search(s):
                exceptions.append({"text": s[:500]})

            if _ACCEPTANCE_HINT.search(s):
                acceptance.append({"text": s[:500]})

            if _GAP_HINT.search(s):
                gaps.append({"text": s[:400]})

            m_g = _GLOSSARY_RE.match(s)
            if m_g:
                glossary.append(
                    {
                        "term": m_g.group(1).strip()[:80],
                        "definition": m_g.group(2).strip()[:400],
                    }
                )

            for m in _API_RE.finditer(s):
                apis.append(
                    {
                        "method": m.group(1).upper(),
                        "path": m.group(2),
                        "note": s[:200],
                    }
                )

            for m in _ENTITY_RE.finditer(s):
                entities.append({"entity": m.group(1), "note": s[:200]})

    payload["features"] = _dedupe_list(features, "name")
    payload["businessRules"] = _dedupe_list(rules, "text")
    for i, r in enumerate(payload["businessRules"], start=1):
        r["id"] = f"BR-{i}"
    payload["actors"] = _dedupe_list(actors, "name")
    payload["useCases"] = _dedupe_list(use_cases, "name")
    payload["validationRules"] = _dedupe_list(validations, "rule")
    payload["apiSummary"] = _dedupe_list(apis, "path")
    payload["exceptions"] = _dedupe_list(exceptions, "text")
    payload["acceptanceCriteria"] = _dedupe_list(acceptance, "text")
    payload["constraints"] = _dedupe_list(constraints, "text")
    payload["glossary"] = _dedupe_list(glossary, "term")
    payload["databaseSummary"] = _dedupe_list(entities, "entity")

    structural_gaps: list[dict] = []
    if not payload["features"] and not payload["useCases"]:
        structural_gaps.append(
            {
                "text": "Chưa nhận diện Chức năng / Feature — cần tiêu đề Feature hoặc Use Case."
            }
        )
    if not payload["useCases"]:
        structural_gaps.append(
            {"text": "Chưa có Luồng nghiệp vụ (Use Case) có tiêu đề + steps."}
        )
    if not payload["businessRules"]:
        structural_gaps.append(
            {"text": "Chưa thấy Business Rule kiểm thử được (phải / bắt buộc / must…)."}
        )
    if not payload["actors"]:
        structural_gaps.append({"text": "Chưa nhận diện Actor / vai trò."})
    if not payload["validationRules"]:
        structural_gaps.append(
            {"text": "Chưa có Validation & dữ liệu (field, format, range)."}
        )
    if not payload["acceptanceCriteria"]:
        structural_gaps.append(
            {"text": "Chưa có Acceptance criteria (Done when / Given-When-Then)."}
        )

    payload["gaps"] = _dedupe_list(gaps + structural_gaps, "text")[:MAX_GAPS]
    return normalize_knowledge_payload(payload)


def parse_knowledge_llm_json(raw: str) -> dict[str, Any] | None:
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
    base = empty_payload()
    for key in base:
        if key not in data:
            continue
        val = data[key]
        if key == "summary":
            if isinstance(val, str):
                base["summary"] = val.strip()
            elif isinstance(val, list):
                base["summary"] = "\n".join(
                    str(x).strip() for x in val if str(x).strip()
                ).strip()
            elif val is not None:
                base["summary"] = str(val).strip()
        elif isinstance(val, list):
            limit = MAX_GAPS if key == "gaps" else MAX_ITEMS
            base[key] = val[:limit]
    return normalize_knowledge_payload(base)


def knowledge_system_prompt() -> str:
    return (
        "You are a requirements analyst preparing Knowledge for QA test-case generation. "
        "From document excerpts, build a structured Knowledge Workspace. "
        "Return ONLY one JSON object (no markdown) with keys:\n"
        "- summary (string): scope in/out + short overview\n"
        "- features ([{name,description}]): distinct features/modules for TC module mapping\n"
        "- actors ([{name,description,permissions}]): who can do what\n"
        "- useCases ([{name,steps}]): flows with numbered steps when possible\n"
        "- businessRules ([{id,text}]): testable rules\n"
        "- validationRules ([{field,rule}]): field/format/range/required\n"
        "- apiSummary ([{method,path,note}])\n"
        "- exceptions ([{text}]): error/exception expected behaviors\n"
        "- acceptanceCriteria ([{text}]): Done-when / Given-When-Then\n"
        "- constraints ([{text}]): NFR (perf/security/audit…)\n"
        "- gaps ([{text}]): ONLY real missing info that blocks accurate TCs "
        "(do NOT invent dozens of open questions; max ~15)\n"
        "Use the document language (often Vietnamese). Be concise; do not invent facts. "
        "Prefer Features + Use Cases + Validation + Exceptions + Acceptance over trivia."
    )


def chunks_to_prompt_text(chunks: list[tuple[str | None, str]]) -> str:
    parts: list[str] = []
    total = 0
    for i, (heading, text) in enumerate(chunks):
        block = (
            f"[Chunk {i + 1}"
            + (f" | {heading}" if heading else "")
            + f"]\n{text.strip()}"
        )
        if total + len(block) > MAX_CHUNK_CHARS_FOR_BUILD:
            remain = MAX_CHUNK_CHARS_FOR_BUILD - total
            if remain > 200:
                parts.append(block[:remain] + "\n…")
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)
