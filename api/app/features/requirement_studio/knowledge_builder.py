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
# Pass-1 LLM enrich — smaller budget for faster Cursor oneshot
MAX_CHUNK_CHARS_FOR_BUILD_PASS1 = 12_000
MAX_ITEMS = 40
MAX_GAPS = 20
MAX_EVIDENCE_PER_ITEM = 3

# Keys LLM must fill well for Generate TC; rest filled from heuristic when empty
PASS1_JSON_KEYS: tuple[str, ...] = (
    "summary",
    "features",
    "actors",
    "useCases",
    "businessRules",
    "validationRules",
    "gaps",
)

_API_RE = re.compile(
    r"\b(GET|POST|PUT|PATCH|DELETE)\s+(/[A-Za-z0-9_\-./{}:]+)",
    re.IGNORECASE,
)
_ACTOR_LINE_RE = re.compile(
    r"(?i)^\s*(?:[-*•]\s*)?(?:actor|vai trò|role|persona|người dùng|user|admin|hệ thống)\s*[:\-–]\s*(.+)$"
)
_USER_STORY_ACTOR_RE = re.compile(
    r"(?i)\blà\s+một\s+([^,.;\n]+)|\bas\s+an?\s+([^,.;\n]+)"
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
_FLOW_STEP_HINT = re.compile(
    r"(?i)^\s*(?:\d+[.)]|[-*•])\s*(mở|truy cập|vào|nhập|chọn|click|nhấn|bấm|tạo|sửa|xóa|lưu|gửi|xác nhận|đăng nhập|đăng xuất|tìm kiếm)\b"
)
_AUTH_HINT = re.compile(
    r"(?i)\b(login|đăng nhập|đăng xuất|role|vai trò|quyền|permission|phân quyền|403|401|unauthorized|forbidden)\b"
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

ANALYSIS_CRITERIA_GUIDE: tuple[dict[str, str], ...] = (
    {
        "type": "SUMMARY_SCOPE",
        "json_key": "summary",
        "label": "Tóm tắt & phạm vi",
        "instruction": (
            "Nêu mục tiêu hệ thống, phạm vi in-scope/out-of-scope, actor chính, và điều kiện tiền đề. "
            "Không suy diễn ngoài tài liệu."
        ),
    },
    {
        "type": "FEATURES",
        "json_key": "features",
        "label": "Chức năng",
        "instruction": (
            "Liệt kê module/chức năng độc lập từ SRS; mỗi item cần name rõ và description ngắn."
        ),
    },
    {
        "type": "ACTORS_PERMISSIONS",
        "json_key": "actors",
        "label": "Actors & quyền",
        "instruction": (
            "Xác định vai trò user/system và quyền thao tác tương ứng theo từng chức năng."
        ),
    },
    {
        "type": "BUSINESS_FLOWS",
        "json_key": "useCases",
        "label": "Luồng nghiệp vụ",
        "instruction": (
            "Mỗi flow là một user journey có điểm bắt đầu-kết thúc; ghi steps rõ theo thứ tự."
        ),
    },
    {
        "type": "BUSINESS_RULES",
        "json_key": "businessRules",
        "label": "Business rules",
        "instruction": (
            "Trích các quy tắc must/shall/không được; chỉ giữ rule có thể kiểm thử."
        ),
    },
    {
        "type": "VALIDATION_DATA",
        "json_key": "validationRules",
        "label": "Validation & dữ liệu",
        "instruction": (
            "Trích rule cho field/input: required, format, range, unique, boundary, message lỗi mong đợi."
        ),
    },
    {
        "type": "API_UI",
        "json_key": "apiSummary",
        "label": "API / giao diện",
        "instruction": (
            "Liệt kê endpoint (method/path) hoặc entry UI trọng yếu liên quan flow nghiệp vụ."
        ),
    },
    {
        "type": "ERROR_HANDLING",
        "json_key": "exceptions",
        "label": "Xử lý lỗi",
        "instruction": (
            "Trích các case lỗi/exception/status code và phản hồi kỳ vọng của hệ thống."
        ),
    },
    {
        "type": "ACCEPTANCE",
        "json_key": "acceptanceCriteria",
        "label": "Acceptance",
        "instruction": (
            "Trích tiêu chí nghiệm thu (Given/When/Then hoặc điều kiện Done) theo ngôn ngữ SRS."
        ),
    },
    {
        "type": "NFR_CONSTRAINTS",
        "json_key": "constraints",
        "label": "Ràng buộc NFR",
        "instruction": (
            "Trích hiệu năng, bảo mật, audit, logging, compliance, timeout, SLA nếu có."
        ),
    },
    {
        "type": "GAPS",
        "json_key": "gaps",
        "label": "Thiếu sót",
        "instruction": (
            "Chỉ ghi thiếu sót thực sự cản trở sinh test chính xác (không bịa thêm)."
        ),
    },
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


def _split_fragments(text: str) -> list[str]:
    if not text:
        return []
    chunks = re.split(r"(?:\n+|[;•\-]\s+)", text)
    out: list[str] = []
    for c in chunks:
        s = (c or "").strip()
        if len(s) < 8:
            continue
        out.append(s[:500])
    return out


def _text_item(row: Any) -> str:
    if isinstance(row, dict):
        for k in ("text", "name", "title", "criterion", "rule", "message"):
            v = row.get(k)
            if v is not None and str(v).strip():
                return str(v).strip()
        return " ".join(str(v).strip() for v in row.values() if v).strip()
    return str(row).strip() if row is not None else ""


def _payload_fragments(payload: dict[str, Any]) -> list[str]:
    out: list[str] = []
    if payload.get("summary"):
        out.extend(_split_fragments(str(payload["summary"])))
    for key in (
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
        "openQuestions",
        "missingInformation",
    ):
        for row in _as_list(payload.get(key)):
            t = _text_item(row)
            out.extend(_split_fragments(t))
    return out


def _append_unique(items: list[dict], key: str, value: dict, *, limit: int = MAX_ITEMS) -> None:
    target = str(value.get(key) or "").strip().lower()
    if not target:
        return
    for it in items:
        if str(it.get(key) or "").strip().lower() == target:
            return
    if len(items) < limit:
        items.append(value)


def _enforce_criteria_split(payload: dict[str, Any]) -> dict[str, Any]:
    """
    Ensure mixed SRS lines are split into their own criteria buckets.
    This helps when documents merge many rules in one paragraph.
    """
    fragments = _payload_fragments(payload)
    if not fragments:
        return payload

    features = _as_list(payload.get("features"))
    actors = _as_list(payload.get("actors"))
    use_cases = _as_list(payload.get("useCases"))
    business_rules = _as_list(payload.get("businessRules"))
    validations = _as_list(payload.get("validationRules"))
    apis = _as_list(payload.get("apiSummary"))
    exceptions = _as_list(payload.get("exceptions"))
    acceptance = _as_list(payload.get("acceptanceCriteria"))
    constraints = _as_list(payload.get("constraints"))
    gaps = _as_list(payload.get("gaps"))

    for frag in fragments:
        # 1) API/UI
        for m in _API_RE.finditer(frag):
            _append_unique(
                apis,
                "path",
                {"method": m.group(1).upper(), "path": m.group(2), "note": frag[:200]},
            )
        # 2) Actors / permissions
        m_actor = _ACTOR_LINE_RE.match(frag)
        if m_actor:
            _append_unique(
                actors,
                "name",
                {"name": m_actor.group(1).strip()[:120], "description": "", "permissions": ""},
            )
        # 3) Business flow
        if _FLOW_STEP_HINT.search(frag) or _USECASE_HEAD.search(frag):
            flow_name = "Luồng tách từ SRS"
            _append_unique(use_cases, "name", {"name": flow_name, "steps": frag[:800]})
        # 4) Validation
        if _VALIDATION_HINT.search(frag):
            _append_unique(validations, "rule", {"field": "", "rule": frag[:500]})
        # 5) Error handling
        if _EXCEPTION_HINT.search(frag):
            _append_unique(exceptions, "text", {"text": frag[:500]})
        # 6) Acceptance
        if _ACCEPTANCE_HINT.search(frag):
            _append_unique(acceptance, "text", {"text": frag[:500]})
        # 7) NFR constraints
        if re.search(r"(?i)\b(performance|bảo mật|security|sla|timeout|audit|logging)\b", frag):
            _append_unique(constraints, "text", {"text": frag[:500]})
        # 8) Business rules
        if _RULE_HINT.search(frag) or _AUTH_HINT.search(frag):
            _append_unique(
                business_rules,
                "text",
                {"id": f"BR-{len(business_rules) + 1}", "text": frag[:500]},
            )
        # 9) Features
        m_feat = _FEATURE_HEAD.match(frag)
        if m_feat:
            _append_unique(
                features,
                "name",
                {"name": (m_feat.group(2).strip() or frag[:80])[:200], "description": frag[:400]},
            )
        elif _FEATURE_HEAD_SIMPLE.search(frag):
            _append_unique(features, "name", {"name": frag[:200], "description": ""})
        # 10) Gaps
        if _GAP_HINT.search(frag):
            _append_unique(gaps, "text", {"text": frag[:500]}, limit=MAX_GAPS)

    payload["features"] = _dedupe_list(features, "name")
    payload["actors"] = _dedupe_list(actors, "name")
    payload["useCases"] = _dedupe_list(use_cases, "name")
    payload["businessRules"] = _dedupe_list(business_rules, "text")
    for i, r in enumerate(payload["businessRules"], start=1):
        r["id"] = f"BR-{i}"
    payload["validationRules"] = _dedupe_list(validations, "rule")
    payload["apiSummary"] = _dedupe_list(apis, "path")
    payload["exceptions"] = _dedupe_list(exceptions, "text")
    payload["acceptanceCriteria"] = _dedupe_list(acceptance, "text")
    payload["constraints"] = _dedupe_list(constraints, "text")
    payload["gaps"] = _dedupe_list(gaps, "text")[:MAX_GAPS]
    return payload


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

    return _enforce_criteria_split(base)


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

        if h and not _USECASE_HEAD.search(h) and _FEATURE_HEAD_SIMPLE.search(h):
            flow_lines = [ln.strip() for ln in body.splitlines() if _FLOW_STEP_HINT.search(ln)]
            if flow_lines:
                use_cases.append(
                    {
                        "name": h[:200],
                        "steps": "\n".join(flow_lines[:12])[:800],
                    }
                )

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
            else:
                m_story = _USER_STORY_ACTOR_RE.search(s)
                story_actor = (m_story.group(1) or m_story.group(2) or "").strip() if m_story else ""
                if story_actor:
                    actors.append(
                        {
                            "name": story_actor[:120],
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

            if _AUTH_HINT.search(s):
                rules.append({"id": f"BR-{len(rules) + 1}", "text": s[:500]})

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

            if _FLOW_STEP_HINT.search(s):
                flow_name = h[:200] if h else "Luồng nghiệp vụ"
                use_cases.append({"name": flow_name, "steps": s[:800]})

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
    if not payload["apiSummary"] and not payload["databaseSummary"]:
        structural_gaps.append(
            {"text": "Chưa có thông tin API / entity / model / bảng dữ liệu liên quan."}
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


def _chunk_rank_score(heading: str | None, text: str) -> int:
    h = (heading or "").strip()
    body = (text or "").strip()
    blob = f"{h}\n{body}"
    score = 0
    if h:
        score += 2
        if _FEATURE_HEAD_SIMPLE.search(h) or _FEATURE_HEAD.match(h):
            score += 6
        if _USECASE_HEAD.search(h):
            score += 6
    if _ACTOR_LINE_RE.search(blob) or _USER_STORY_ACTOR_RE.search(blob):
        score += 4
    if _RULE_HINT.search(blob):
        score += 3
    if _VALIDATION_HINT.search(blob):
        score += 3
    if _API_RE.search(blob):
        score += 2
    if _ACCEPTANCE_HINT.search(blob):
        score += 3
    if _EXCEPTION_HINT.search(blob):
        score += 2
    if _AUTH_HINT.search(blob):
        score += 2
    if _FLOW_STEP_HINT.search(blob):
        score += 2
    # Prefer denser chunks slightly
    score += min(3, len(body) // 800)
    return score


def rank_chunks_for_build(
    chunks: list[tuple[str | None, str]],
) -> list[tuple[str | None, str]]:
    """Prioritize TC-critical chunks; stable order among equal scores."""
    scored: list[tuple[int, int, str | None, str]] = []
    for i, (heading, text) in enumerate(chunks):
        scored.append((_chunk_rank_score(heading, text), i, heading, text or ""))
    scored.sort(key=lambda row: (-row[0], row[1]))
    return [(h, t) for _, _, h, t in scored]


def chunks_to_prompt_text(
    chunks: list[tuple[str | None, str]],
    *,
    max_chars: int | None = None,
    rank: bool = False,
) -> str:
    budget = max_chars if max_chars is not None else MAX_CHUNK_CHARS_FOR_BUILD
    ordered = rank_chunks_for_build(chunks) if rank else list(chunks)
    parts: list[str] = []
    total = 0
    for i, (heading, text) in enumerate(ordered):
        block = (
            f"[Chunk {i + 1}"
            + (f" | {heading}" if heading else "")
            + f"]\n{text.strip()}"
        )
        if total + len(block) > budget:
            remain = budget - total
            if remain > 200:
                parts.append(block[:remain] + "\n…")
            break
        parts.append(block)
        total += len(block)
    return "\n\n".join(parts)


def _list_item_identity(item: Any) -> str:
    if not isinstance(item, dict):
        return str(item).strip().lower() if item is not None else ""
    method = str(item.get("method") or "").strip().upper()
    path = str(item.get("path") or "").strip().lower()
    if method or path:
        return f"{method}:{path}"
    field = str(item.get("field") or "").strip().lower()
    rule = str(item.get("rule") or "").strip().lower()
    if field or rule:
        return f"{field}:{rule}"
    for k in ("name", "id", "title", "text", "criterion"):
        v = item.get(k)
        if v is not None and str(v).strip():
            return str(v).strip().lower()
    return _text_item(item).lower()


def _union_knowledge_lists(
    base_list: list[Any],
    overlay_list: list[Any],
    *,
    limit: int = MAX_ITEMS,
) -> list[Any]:
    """LLM items first, then heuristic extras not already covered (by identity)."""
    out: list[Any] = []
    seen: set[str] = set()
    for it in list(overlay_list) + list(base_list):
        if not isinstance(it, dict):
            continue
        ident = _list_item_identity(it)
        if not ident or ident in seen:
            continue
        seen.add(ident)
        out.append(it)
        if len(out) >= limit:
            break
    return out


def merge_knowledge_payloads(
    base: dict[str, Any] | None,
    overlay: dict[str, Any] | None,
) -> dict[str, Any]:
    """
    Merge LLM overlay onto heuristic base.
    Non-empty overlay summary wins. List keys are unioned (LLM first) so a
    thinner Cursor pass cannot wipe heuristic features / rules / APIs.
    Empty overlay lists keep base.
    """
    out = normalize_knowledge_payload(base if isinstance(base, dict) else empty_payload())
    if not isinstance(overlay, dict):
        return out
    over = normalize_knowledge_payload(overlay)
    if (over.get("summary") or "").strip():
        out["summary"] = over["summary"]
    for key in PRIMARY_LIST_KEYS + LEGACY_LIST_KEYS:
        ov = over.get(key) or []
        if not isinstance(ov, list) or len(ov) == 0:
            continue
        base_list = out.get(key) or []
        if not isinstance(base_list, list) or len(base_list) == 0:
            out[key] = ov
        else:
            out[key] = _union_knowledge_lists(base_list, ov)
    return normalize_knowledge_payload(out)


def knowledge_system_prompt(*, pass1: bool = True) -> str:
    guide = (
        tuple(c for c in ANALYSIS_CRITERIA_GUIDE if c["json_key"] in PASS1_JSON_KEYS)
        if pass1
        else ANALYSIS_CRITERIA_GUIDE
    )
    criteria_lines = "\n".join(
        f"- {c['type']} ({c['json_key']}): {c['instruction']}" for c in guide
    )
    if pass1:
        return (
            "You are a requirements analyst preparing Knowledge for QA test-case generation. "
            "From uploaded SRS excerpts, return ONLY one JSON object (no markdown) with keys:\n"
            "- summary (string)\n"
            "- features ([{name,description}])\n"
            "- actors ([{name,description,permissions}])\n"
            "- useCases ([{name,steps}])\n"
            "- businessRules ([{id,text}])\n"
            "- validationRules ([{field,rule}])\n"
            "- gaps ([{text}]): ONLY real missing info that blocks accurate TCs (max ~10)\n"
            "Focus criteria:\n"
            f"{criteria_lines}\n"
            "CRITICAL: split mixed SRS paragraphs into separate items per key. "
            "Do NOT invent facts. Be concise. No evidence quotes required. "
            "Use the document language (often Vietnamese)."
        )
    return (
        "You are a requirements analyst preparing Knowledge for QA test-case generation. "
        "From uploaded SRS excerpts, build a structured Knowledge Workspace for database persistence. "
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
        "Mandatory extraction criteria by persisted DB type:\n"
        f"{criteria_lines}\n"
        "CRITICAL: If one SRS paragraph mixes multiple criteria, split it into separate items "
        "for each relevant key (do not keep mixed/combined items).\n"
        "Use the document language (often Vietnamese). Be concise; do not invent facts. "
        "Prefer Features + Use Cases + Validation + Exceptions + Acceptance over trivia."
    )


def build_knowledge_user_prompt(
    chunks: list[tuple[str | None, str]],
    *,
    file_names: list[str] | None = None,
    pass1: bool = True,
) -> str:
    files = ", ".join((file_names or [])[:20]) or "(unknown)"
    guide = (
        tuple(c for c in ANALYSIS_CRITERIA_GUIDE if c["json_key"] in PASS1_JSON_KEYS)
        if pass1
        else ANALYSIS_CRITERIA_GUIDE
    )
    criteria = "\n".join(
        f"{idx + 1}. {c['label']} [{c['type']}] -> JSON key '{c['json_key']}'"
        for idx, c in enumerate(guide)
    )
    excerpt = chunks_to_prompt_text(
        chunks,
        max_chars=MAX_CHUNK_CHARS_FOR_BUILD_PASS1 if pass1 else MAX_CHUNK_CHARS_FOR_BUILD,
        rank=True,
    )
    if pass1:
        return (
            "SRS nguồn — phân tích nhanh (pass 1) theo checklist TC-critical.\n"
            f"Files: {files}\n\n"
            "Checklist:\n"
            f"{criteria}\n\n"
            "Quy tắc:\n"
            "- Trả về DUY NHẤT 1 JSON object hợp lệ (các key ở trên; list thiếu → []).\n"
            "- Không markdown, không giải thích.\n"
            "- Tách item đúng key; không bịa.\n\n"
            "Document excerpts:\n\n"
            f"{excerpt}\n\n"
            "Return the Knowledge JSON now."
        )
    return (
        "SRS nguồn tải lên cần phân tích đầy đủ theo checklist bắt buộc dưới đây.\n"
        f"Files: {files}\n\n"
        "Checklist tiêu chí:\n"
        f"{criteria}\n\n"
        "Quy tắc output:\n"
        "- Trả về DUY NHẤT 1 JSON object hợp lệ theo schema đã yêu cầu.\n"
        "- Không markdown, không giải thích thêm ngoài JSON.\n"
        "- Mỗi tiêu chí phải tách item riêng; không gộp Validation/Rule/Exception/Acceptance vào cùng 1 item.\n"
        "- Nếu 1 đoạn SRS chứa nhiều ý, phải tách thành nhiều item và map đúng key tương ứng.\n"
        "- Nếu không đủ dữ liệu cho tiêu chí nào, ghi lý do vào gaps.\n\n"
        "Document excerpts:\n\n"
        f"{excerpt}\n\n"
        "Return the Knowledge JSON now."
    )
