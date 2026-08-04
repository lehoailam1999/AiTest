"""Chuẩn hoá nhãn test case sang tiếng Việt khi lưu DB + engine type (R1)."""

from __future__ import annotations

TYPE_VI = {
    "functional": "Chức năng",
    "negative": "Phủ định",
    "boundary": "Biên",
    "api": "API",
    "chức năng": "Chức năng",
    "phủ định": "Phủ định",
    "biên": "Biên",
    # R1 — engine kinds (canonical English product labels)
    "unit": "Unit",
    "unittest": "Unit",
    "unit test": "Unit",
    "e2e": "E2E",
    "end-to-end": "E2E",
    "end to end": "E2E",
    "endtoend": "E2E",
    "journey": "E2E",
    "ui": "E2E",
}

PRIORITY_VI = {
    "low": "Thấp",
    "medium": "Trung bình",
    "high": "Cao",
    "critical": "Nghiêm trọng",
    "thấp": "Thấp",
    "trung bình": "Trung bình",
    "cao": "Cao",
    "nghiêm trọng": "Nghiêm trọng",
}

# High → low for list/display (0 = highest).
PRIORITY_RANK = {
    "nghiêm trọng": 0,
    "critical": 0,
    "p0": 0,
    "cao": 1,
    "high": 1,
    "p1": 1,
    "trung bình": 2,
    "medium": 2,
    "p2": 2,
    "thấp": 3,
    "low": 3,
    "p3": 3,
}

# Canonical + legacy spellings stored in DB (after priority_vi + older EN).
_PRIORITY_SQL_GROUPS: tuple[tuple[int, tuple[str, ...]], ...] = (
    (0, ("Nghiêm trọng", "Critical", "critical", "CRITICAL", "P0", "p0")),
    (1, ("Cao", "High", "high", "HIGH", "P1", "p1")),
    (2, ("Trung bình", "Medium", "medium", "MEDIUM", "P2", "p2")),
    (3, ("Thấp", "Low", "low", "LOW", "P3", "p3")),
)

SEVERITY_VI = {
    "minor": "Nhẹ",
    "major": "Nặng",
    "critical": "Nghiêm trọng",
    "nhẹ": "Nhẹ",
    "nặng": "Nặng",
    "nghiêm trọng": "Nghiêm trọng",
}

# Synonyms → canonical engine type stored on approve
_ENGINE_CANONICAL = {
    "e2e": "E2E",
    "end-to-end": "E2E",
    "end to end": "E2E",
    "endtoend": "E2E",
    "journey": "E2E",
    "ui": "E2E",
    "unit": "Unit",
    "unittest": "Unit",
    "unit test": "Unit",
    "api": "API",
    "apitest": "API",
}


def _norm_key(value: str | None) -> str:
    return (value or "").strip().lower()


def type_vi(value: str | None) -> str:
    key = _norm_key(value)
    if key in _ENGINE_CANONICAL:
        return _ENGINE_CANONICAL[key]
    return TYPE_VI.get(key) or (value.strip() if value and value.strip() else "Chức năng")


def normalize_engine_type(value: str | None) -> str:
    """
    R1.5 — on Approve: map Journey/UI/e2e → E2E, unit → Unit, api → API.
    Other types keep type_vi() result (Chức năng…).
    """
    key = _norm_key(value)
    if not key:
        return "Chức năng"
    if key in _ENGINE_CANONICAL:
        return _ENGINE_CANONICAL[key]
    # Already canonical
    if value and value.strip() in ("Unit", "E2E", "API"):
        return value.strip()
    return type_vi(value)


def priority_vi(value: str | None) -> str:
    key = _norm_key(value)
    return PRIORITY_VI.get(key) or (value.strip() if value and value.strip() else "Trung bình")


def priority_rank(value: str | None) -> int:
    """0 = highest (Nghiêm trọng/Critical) … 3 = Thấp/Low; unknown → 4."""
    return PRIORITY_RANK.get(_norm_key(value), 4)


def priority_order_expr(column):
    """
    SQLAlchemy ORDER BY helper: độ ưu tiên cao → thấp, rồi tie-break khác.
    Dùng: ``query.order_by(priority_order_expr(TestCase.priority), …)``
    """
    from sqlalchemy import case

    whens = []
    for rank, labels in _PRIORITY_SQL_GROUPS:
        whens.append((column.in_(list(labels)), rank))
    return case(*whens, else_=4)


def severity_vi(value: str | None) -> str:
    key = _norm_key(value)
    return SEVERITY_VI.get(key) or (value.strip() if value and value.strip() else "Nặng")
