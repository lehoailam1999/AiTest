"""Requirement Coverage analyzer — Complete / Partial / Missing (R4, SoT §6.4)."""

from __future__ import annotations

import re
from datetime import datetime, timezone
from typing import Any

COVERAGE_DIMENSIONS: tuple[str, ...] = (
    "Authentication",
    "Authorization",
    "Validation",
    "Exception",
    "Permission",
    "Notification",
    "Logging",
    "Audit",
    "Performance",
    "Security",
)

# Keyword signals (VI + EN). Score: hits → complete / partial / missing.
_DIMENSION_SIGNALS: dict[str, tuple[str, ...]] = {
    "Authentication": (
        "authentication",
        "authenticate",
        "login",
        "đăng nhập",
        "sign in",
        "password",
        "mật khẩu",
        "otp",
        "sso",
        "oauth",
        "jwt",
        "session",
        "token",
    ),
    "Authorization": (
        "authorization",
        "authorize",
        "rbac",
        "role-based",
        "phân quyền",
        "ủy quyền",
        "access control",
        "forbidden",
        "403",
    ),
    "Validation": (
        "validation",
        "validate",
        "kiểm tra",
        "validate input",
        "required field",
        "bắt buộc",
        "regex",
        "schema",
        "invalid",
    ),
    "Exception": (
        "exception",
        "error handling",
        "xử lý lỗi",
        "fault",
        "retry",
        "fallback",
        "timeout error",
        "http 5",
        "500",
    ),
    "Permission": (
        "permission",
        "permissions",
        "quyền",
        "privilege",
        "acl",
        "grant",
        "deny",
        "can_access",
    ),
    "Notification": (
        "notification",
        "notify",
        "thông báo",
        "email",
        "sms",
        "push",
        "webhook",
        "alert user",
    ),
    "Logging": (
        "logging",
        "logger",
        "log ",
        "nhật ký",
        "trace id",
        "correlation",
        "audit log",
    ),
    "Audit": (
        "audit trail",
        "audit",
        "kiểm toán",
        "who changed",
        "history of changes",
        "activity log",
    ),
    "Performance": (
        "performance",
        "latency",
        "throughput",
        "sla",
        "hiệu năng",
        "cache",
        "pagination",
        "rate limit",
        "timeout",
    ),
    "Security": (
        "security",
        "bảo mật",
        "encrypt",
        "mã hóa",
        "xss",
        "csrf",
        "injection",
        "https",
        "tls",
        "sanitize",
    ),
}


def _corpus_from_knowledge(payload: dict[str, Any] | None, chunk_texts: list[str]) -> str:
    parts: list[str] = []
    if payload:
        if payload.get("summary"):
            parts.append(str(payload["summary"]))
        for key in (
            "features",
            "businessRules",
            "actors",
            "useCases",
            "validationRules",
            "apiSummary",
            "exceptions",
            "acceptanceCriteria",
            "constraints",
            "gaps",
            "glossary",
            "databaseSummary",
            "openQuestions",
            "missingInformation",
        ):
            items = payload.get(key) or []
            if not isinstance(items, list):
                continue
            for it in items:
                if isinstance(it, dict):
                    parts.append(" ".join(str(v) for v in it.values() if v))
                else:
                    parts.append(str(it))
    parts.extend(chunk_texts[:80])
    return "\n".join(parts).lower()


def _count_hits(corpus: str, signals: tuple[str, ...]) -> list[str]:
    found: list[str] = []
    for s in signals:
        if s.lower() in corpus:
            found.append(s)
    return found


def analyze_requirement_coverage(
    payload: dict[str, Any] | None,
    *,
    chunk_texts: list[str] | None = None,
) -> dict[str, Any]:
    """
    Heuristic Coverage matrix (Complete / Partial / Missing).
    complete: ≥3 distinct signals; partial: 1–2; missing: 0.
    """
    corpus = _corpus_from_knowledge(payload, chunk_texts or [])
    dimensions: list[dict[str, Any]] = []
    totals = {"complete": 0, "partial": 0, "missing": 0}

    for dim in COVERAGE_DIMENSIONS:
        hits = _count_hits(corpus, _DIMENSION_SIGNALS[dim])
        # Prefer word-ish matches for short tokens like "log "
        n = len(hits)
        if n >= 3:
            status = "complete"
        elif n >= 1:
            status = "partial"
        else:
            status = "missing"
        totals[status] += 1
        note = (
            f"Khớp {n} tín hiệu: {', '.join(hits[:5])}"
            if hits
            else "Chưa thấy mô tả rõ trong Knowledge / chunks"
        )
        dimensions.append(
            {
                "dimension": dim,
                "status": status,
                "notes": note,
                "signals": hits[:8],
            }
        )

    return {
        "analyzer": "heuristic-v1",
        "analyzedAt": datetime.now(timezone.utc).isoformat(),
        "dimensions": dimensions,
        "totals": totals,
        "missingDimensions": [
            d["dimension"] for d in dimensions if d["status"] == "missing"
        ],
        "partialDimensions": [
            d["dimension"] for d in dimensions if d["status"] == "partial"
        ],
    }


def coverage_score_pct(coverage: dict[str, Any] | None) -> float | None:
    if not coverage:
        return None
    totals = coverage.get("totals") or {}
    complete = int(totals.get("complete") or 0)
    partial = int(totals.get("partial") or 0)
    missing = int(totals.get("missing") or 0)
    n = complete + partial + missing
    if n <= 0:
        return None
    # Partial counts as half
    return round(100.0 * (complete + 0.5 * partial) / n, 1)
