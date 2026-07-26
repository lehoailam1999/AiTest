"""Chuẩn hoá nhãn test case sang tiếng Việt khi lưu DB."""

from __future__ import annotations

TYPE_VI = {
    "functional": "Chức năng",
    "negative": "Phủ định",
    "boundary": "Biên",
    "api": "API",
    "chức năng": "Chức năng",
    "phủ định": "Phủ định",
    "biên": "Biên",
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


def _norm_key(value: str | None) -> str:
    return (value or "").strip().lower()


def type_vi(value: str | None) -> str:
    key = _norm_key(value)
    return TYPE_VI.get(key) or (value.strip() if value and value.strip() else "Chức năng")


def priority_vi(value: str | None) -> str:
    key = _norm_key(value)
    return PRIORITY_VI.get(key) or (value.strip() if value and value.strip() else "Trung bình")


def severity_vi(value: str | None) -> str:
    key = _norm_key(value)
    return SEVERITY_VI.get(key) or (value.strip() if value and value.strip() else "Nặng")
