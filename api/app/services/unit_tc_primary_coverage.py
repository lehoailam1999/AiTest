"""
Unit TC PRIMARY coverage anti-miss (portable).

Inventory Knowledge BR / VALIDATION / ERROR / ACCEPTANCE → diff vs generated drafts
(markers in test_data / title). Used by TC gen jobs to retry missing signals.
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass
from typing import Any, Iterable

PRIMARY_BUCKETS = (
    "BUSINESS_RULES",
    "VALIDATION_DATA",
    "ERROR_HANDLING",
    "ACCEPTANCE",
)

_BUCKET_KEYS: dict[str, tuple[str, ...]] = {
    "BUSINESS_RULES": ("businessRules",),
    "VALIDATION_DATA": ("validationRules",),
    "ERROR_HANDLING": ("exceptions", "errorHandling", "errors"),
    "ACCEPTANCE": ("acceptanceCriteria",),
}

_ID_RE = re.compile(
    r"(?i)\b("
    r"BR[-_]?\d+[A-Za-z0-9_-]*|"
    r"VAL[-_]?[A-Za-z0-9_-]+|"
    r"EXC[-_]?[A-Za-z0-9_-]+|"
    r"AC[-_]?\d+[A-Za-z0-9_-]*|"
    r"ERR[-_]?\d+[A-Za-z0-9_-]*"
    r")\b"
)


@dataclass(frozen=True)
class PrimarySignal:
    bucket: str
    req_id: str
    text: str
    key: str


def _ascii_key(raw: str) -> str:
    t = unicodedata.normalize("NFD", raw or "")
    t = "".join(ch for ch in t if unicodedata.category(ch) != "Mn")
    t = t.replace("đ", "d").replace("Đ", "D")
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9\s_-]+", " ", t.lower())).strip()


def _as_list(v: Any) -> list[Any]:
    if v is None:
        return []
    if isinstance(v, list):
        return [x for x in v if x is not None]
    return [v]


def _row_text(row: Any) -> str:
    if isinstance(row, str):
        return row.strip()
    if not isinstance(row, dict):
        return str(row or "").strip()
    for k in (
        "text",
        "rule",
        "description",
        "name",
        "title",
        "criterion",
        "message",
        "note",
    ):
        s = str(row.get(k) or "").strip()
        if s:
            return s
    field = str(row.get("field") or "").strip()
    rule = str(row.get("rule") or "").strip()
    if field or rule:
        return f"{field}: {rule}".strip(": ")
    return " ".join(str(v) for v in row.values() if v is not None).strip()


def _row_req_id(row: Any, bucket: str, idx: int) -> str:
    if isinstance(row, dict):
        for k in ("id", "code", "requirementId", "requirement_id", "key", "name"):
            raw = str(row.get(k) or "").strip()
            if not raw:
                continue
            m = _ID_RE.search(raw)
            if m:
                return m.group(1).upper().replace("_", "-")
            # Short stable codes (BR-7, VAL-Ngăn…)
            if len(raw) <= 48 and re.search(r"[A-Za-z]", raw):
                return raw.strip()
        blob = _row_text(row)
        m = _ID_RE.search(blob)
        if m:
            return m.group(1).upper().replace("_", "-")
    prefix = {
        "BUSINESS_RULES": "BR",
        "VALIDATION_DATA": "VAL",
        "ERROR_HANDLING": "EXC",
        "ACCEPTANCE": "AC",
    }.get(bucket, "REQ")
    return f"{prefix}-AUTO-{idx:03d}"


def build_primary_inventory(knowledge: dict[str, Any] | None) -> list[PrimarySignal]:
    """Flatten Knowledge PRIMARY lists into portable signals (deduped)."""
    kw = knowledge if isinstance(knowledge, dict) else {}
    out: list[PrimarySignal] = []
    seen: set[str] = set()
    for bucket, keys in _BUCKET_KEYS.items():
        rows: list[Any] = []
        for k in keys:
            rows.extend(_as_list(kw.get(k)))
        for i, row in enumerate(rows, 1):
            text = _row_text(row)
            if len(text) < 4:
                continue
            req_id = _row_req_id(row, bucket, i)
            key = _ascii_key(f"{bucket}|{req_id}|{text[:80]}")
            if key in seen:
                continue
            seen.add(key)
            out.append(
                PrimarySignal(
                    bucket=bucket,
                    req_id=req_id,
                    text=text[:400],
                    key=key,
                )
            )
    return out


def _draft_blob(draft: Any) -> str:
    parts = [
        getattr(draft, "title", None),
        getattr(draft, "module", None),
        getattr(draft, "steps", None),
        getattr(draft, "expected_result", None),
        getattr(draft, "precondition", None),
        getattr(draft, "test_data", None),
    ]
    if isinstance(draft, dict):
        parts = [
            draft.get("title"),
            draft.get("module"),
            draft.get("steps"),
            draft.get("expectedResult") or draft.get("expected_result"),
            draft.get("precondition"),
            draft.get("testData") or draft.get("test_data"),
        ]
    return "\n".join(str(p or "") for p in parts)


def _ids_from_blob(blob: str) -> set[str]:
    found: set[str] = set()
    for m in _ID_RE.finditer(blob or ""):
        found.add(m.group(1).upper().replace("_", "-"))
    # Markers: behaviorId: BR-7-B01 · requirementIds: BR-7 · trace: BUSINESS_RULES/BR-7
    for m in re.finditer(
        r"(?i)\b(?:behaviorId|requirementIds|requirementId|trace)\s*:\s*([^\n]+)",
        blob or "",
    ):
        chunk = m.group(1)
        for piece in re.split(r"[,;/|\s]+", chunk):
            p = piece.strip().strip("'\"")
            if not p:
                continue
            idm = _ID_RE.search(p)
            if idm:
                found.add(idm.group(1).upper().replace("_", "-"))
            elif p.upper() in PRIMARY_BUCKETS:
                continue
            elif len(p) <= 48 and re.search(r"[A-Za-z]", p):
                # VAL-Ngăn lưu trữ style
                found.add(p)
    return found


def covered_req_ids_from_drafts(drafts: Iterable[Any]) -> set[str]:
    out: set[str] = set()
    for d in drafts or []:
        out |= _ids_from_blob(_draft_blob(d))
    return out


def signal_covered(sig: PrimarySignal, covered_ids: set[str], draft_blobs: list[str]) -> bool:
    rid = (sig.req_id or "").strip()
    rid_u = rid.upper().replace("_", "-")
    if rid_u in {c.upper().replace("_", "-") for c in covered_ids}:
        return True
    # behaviorId prefix BR-7-B01 covers BR-7
    for c in covered_ids:
        cu = c.upper().replace("_", "-")
        if cu.startswith(rid_u + "-") or rid_u.startswith(cu + "-"):
            return True
    # AUTO ids: fall back to text needle in any draft
    if "AUTO-" in rid_u:
        needle = _ascii_key(sig.text)[:48]
        if len(needle) >= 12:
            for blob in draft_blobs:
                if needle[:24] in _ascii_key(blob):
                    return True
        return False
    # Named id without marker: loose title/text hit
    rid_ascii = _ascii_key(rid)
    if len(rid_ascii) >= 4:
        for blob in draft_blobs:
            if rid_ascii in _ascii_key(blob):
                return True
    return False


def missing_primary_signals(
    inventory: list[PrimarySignal],
    drafts: Iterable[Any],
) -> list[PrimarySignal]:
    draft_list = list(drafts or [])
    covered = covered_req_ids_from_drafts(draft_list)
    blobs = [_draft_blob(d) for d in draft_list]
    return [s for s in inventory if not signal_covered(s, covered, blobs)]


def format_primary_miss_block(missing: list[PrimarySignal], *, limit: int = 24) -> str:
    """Prompt block: force CLI to emit Unit TCs for uncovered PRIMARY signals."""
    rows = missing[: max(1, limit)]
    lines = [
        "## PRIMARY coverage gap (anti-miss — BẮT BUỘC)",
        "Knowledge còn các tín hiệu PRIMARY sau CHƯA có Unit TC (thiếu trace/behaviorId).",
        "Hãy sinh thêm Unit TC IR CHỈ cho các item này (1 behaviorId / 1 TC).",
        "Giữ đúng primaryBucket; trace.requirementIds phải chứa req id dưới đây.",
        "Cấm invent thêm rule ngoài list. Cấm dừng sớm.",
        "",
    ]
    by_bucket: dict[str, list[PrimarySignal]] = {}
    for s in rows:
        by_bucket.setdefault(s.bucket, []).append(s)
    for bucket in PRIMARY_BUCKETS:
        items = by_bucket.get(bucket) or []
        if not items:
            continue
        lines.append(f"### {bucket} ({len(items)})")
        for s in items:
            lines.append(f"- id=`{s.req_id}` :: {s.text}")
        lines.append("")
    if len(missing) > len(rows):
        lines.append(f"… còn {len(missing) - len(rows)} tín hiệu — sẽ retry vòng sau.")
    return "\n".join(lines).strip()


def coverage_summary(
    inventory: list[PrimarySignal],
    missing: list[PrimarySignal],
) -> dict[str, Any]:
    by_total: dict[str, int] = {b: 0 for b in PRIMARY_BUCKETS}
    by_miss: dict[str, int] = {b: 0 for b in PRIMARY_BUCKETS}
    for s in inventory:
        by_total[s.bucket] = by_total.get(s.bucket, 0) + 1
    for s in missing:
        by_miss[s.bucket] = by_miss.get(s.bucket, 0) + 1
    return {
        "inventory": len(inventory),
        "missing": len(missing),
        "covered": max(0, len(inventory) - len(missing)),
        "perBucket": {
            b: {
                "total": by_total.get(b, 0),
                "missing": by_miss.get(b, 0),
                "covered": max(0, by_total.get(b, 0) - by_miss.get(b, 0)),
            }
            for b in PRIMARY_BUCKETS
        },
    }
