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


def severity_vi(value: str | None) -> str:
    key = _norm_key(value)
    return SEVERITY_VI.get(key) or (value.strip() if value and value.strip() else "Nặng")
