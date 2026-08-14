"""
Unit TC BE context filter — PRIMARY-only Knowledge for Unit gen.

E2E must not import/call these helpers on its path.
Portable: no product nouns.
"""

from __future__ import annotations

import re
from typing import Any

# Analysis record `type` values that feed Unit TC generation.
UNIT_ANALYSIS_TYPES = frozenset(
    {
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
    }
)

# Clear presentation-only AC (OUT) — drop from Unit pack.
_UI_ONLY_AC_RE = re.compile(
    r"(?i)("
    r"màn\s*hình|giao\s*diện|toast|popup|modal|wizard|hover|animation|"
    r"layout|bố\s*cục|pixel|css\b|"
    r"\bclick\b|bấm\s*nút|điền\s*(vào\s*)?(form|ô)|"
    r"hiển\s*thị\s*(nút|button|form|dialog|popup|toast|wizard)|"
    r"button\s*(visible|enabled|disabled)|"
    r"mở\s*(popup|dialog|modal)|đóng\s*(popup|dialog)"
    r")"
)

# Backend outcome cues — keep AC when both UI wording + BE exist (MIXED → BE).
_BE_AC_RE = re.compile(
    r"(?i)("
    r"từ\s*chối|reject|validate|validation|persist|lưu\b|"
    r"bắt\s*buộc|required|unique|trùng|giới\s*hạn|maxlength|minlength|"
    r"authz|phân\s*quyền|không\s*cho\s*phép|phải\s*có|tồn\s*tại|"
    r"trạng\s*thái|state|tính\s*toán|filter|query|"
    r"exception|error|lỗi\s*nghiệp\s*vụ|HTTP|API\b"
    r")"
)


def _row_text(row: Any) -> str:
    if row is None:
        return ""
    if isinstance(row, str):
        return row
    if not isinstance(row, dict):
        return str(row)
    parts = [
        row.get("id"),
        row.get("code"),
        row.get("name"),
        row.get("title"),
        row.get("text"),
        row.get("description"),
        row.get("rule"),
        row.get("field"),
        row.get("constraint"),
    ]
    return " ".join(str(p) for p in parts if p)


def acceptance_is_ui_only(row: Any) -> bool:
    """True when AC is presentation-only (no backend outcome cue)."""
    blob = _row_text(row)
    if not blob.strip():
        return False
    ui = _UI_ONLY_AC_RE.search(blob)
    if not ui:
        return False
    # Strong UI surface (screen/button display) → OUT unless clear BE outcome verbs
    strong_ui = re.search(
        r"(?i)màn\s*hình|toast|popup|wizard|modal|hiển\s*thị\s*(nút|button)|"
        r"bấm\s*nút|điền\s*(form|ô)",
        blob,
    )
    strong_be = re.search(
        r"(?i)từ\s*chối|reject|validate|validation|persist|"
        r"bắt\s*buộc|required|unique|trùng|authz|exception|"
        r"không\s*cho\s*phép|HTTP\b|API\b",
        blob,
    )
    if strong_ui:
        return not bool(strong_be)
    if _BE_AC_RE.search(blob):
        return False
    return True


def filter_acceptance_be_only(rows: list[Any] | None) -> list[Any]:
    if not isinstance(rows, list):
        return []
    return [r for r in rows if not acceptance_is_ui_only(r)]


def feature_name_only(row: Any, *, fallback: str = "") -> dict[str, str]:
    """FEATURES → module label only (no journey description)."""
    name = ""
    if isinstance(row, dict):
        name = str(row.get("name") or row.get("title") or "").strip()
    elif isinstance(row, str):
        name = row.strip()
    if not name:
        name = (fallback or "").strip() or "Module"
    return {"name": name[:200], "description": ""}


def filter_knowledge_primary_be(
    knowledge: dict[str, Any] | None,
    *,
    module: str = "",
) -> dict[str, Any]:
    """
    Slim Knowledge for Unit TC prompt:
    BR + VALIDATION + ERROR + AC(BE) only.
    FEATURES = name-only stub for module. FLOWS/useCases/actors/API/UI → empty.
    """
    kw = knowledge if isinstance(knowledge, dict) else {}
    features_in = kw.get("features") if isinstance(kw.get("features"), list) else []
    feat_stub: list[dict[str, str]] = []
    mod = (module or "").strip()
    if mod:
        feat_stub = [feature_name_only({"name": mod})]
    elif features_in:
        # Keep at most one name stub (first) — never pack descriptions/journeys
        feat_stub = [feature_name_only(features_in[0], fallback=mod)]

    summary = kw.get("documentSummary") or kw.get("summary") or ""
    if not isinstance(summary, str):
        summary = str(summary or "")

    return {
        "documentSummary": summary[:400],
        "summary": summary[:400],
        "features": feat_stub[:1],
        "actors": [],
        "useCases": [],
        "executionContexts": [],
        "businessRules": list(kw.get("businessRules") or [])
        if isinstance(kw.get("businessRules"), list)
        else [],
        "validationRules": list(kw.get("validationRules") or [])
        if isinstance(kw.get("validationRules"), list)
        else [],
        "apiSummary": [],
        "exceptions": list(kw.get("exceptions") or [])
        if isinstance(kw.get("exceptions"), list)
        else [],
        "acceptanceCriteria": filter_acceptance_be_only(
            kw.get("acceptanceCriteria") if isinstance(kw.get("acceptanceCriteria"), list) else []
        ),
        "constraints": [],
        "gaps": list(kw.get("gaps") or [])[:8]
        if isinstance(kw.get("gaps"), list)
        else [],
    }


def is_unit_analysis_type(record_type: str | None) -> bool:
    t = str(record_type or "").strip().upper()
    return t in UNIT_ANALYSIS_TYPES
