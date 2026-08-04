"""VALIDATION_DATA — keep full fields; optional module grouping."""

from __future__ import annotations

from app.features.requirement_studio.knowledge_builder import (
    _normalize_validation_items,
    normalize_knowledge_payload,
)


def test_drops_vague_and_fieldless_validation():
    rows = _normalize_validation_items(
        [
            {"field": "", "rule": "dữ liệu phải hợp lệ"},
            {"field": "email", "rule": "dữ liệu hợp lệ"},
            {"field": "email", "rule": "email"},
            {"field": "email", "rule": "required"},
        ]
    )
    assert len(rows) == 1
    assert rows[0]["field"] == "email"
    assert rows[0]["rule"] == "required"
    assert rows[0]["module"] == "Chung"


def test_keeps_vietnamese_field_names():
    rows = _normalize_validation_items(
        [
            {"field": "Họ tên", "rule": "bắt buộc", "module": "Đăng ký"},
            {"field": "Mật khẩu", "rule": "tối thiểu 8 ký tự", "module": "Đăng ký"},
            {"field": "Email", "rule": "Có — format email", "module": "Đăng nhập"},
        ]
    )
    fields = {r["field"] for r in rows}
    assert "Họ tên" in fields
    assert "Mật khẩu" in fields
    assert any(r["module"] == "Đăng ký" for r in rows)
    email = next(r for r in rows if r["field"].lower() == "email")
    assert "required" in email["rule"].lower() or "email" in email["rule"].lower()


def test_strips_field_echo_and_table_dump():
    rows = _normalize_validation_items(
        [
            {
                "field": "title",
                "rule": "title — String — Có — Độ dài 3–100",
            },
            {
                "field": "email",
                "rule": "email: required, format email",
            },
        ]
    )
    assert len(rows) == 2
    title = next(r for r in rows if r["field"] == "title")
    assert "title —" not in title["rule"]
    assert "required" in title["rule"] or "3" in title["rule"] or "100" in title["rule"]
    email = next(r for r in rows if r["field"] == "email")
    assert not email["rule"].lower().startswith("email:")
    assert "required" in email["rule"].lower()


def test_dedupe_same_field_rule_keeps_different_fields():
    rows = _normalize_validation_items(
        [
            {"field": "email", "rule": "required"},
            {"field": "email", "rule": "required"},
            {"field": "password", "rule": "required"},
        ]
    )
    assert len(rows) == 2
    fields = {r["field"] for r in rows}
    assert fields == {"email", "password"}


def test_normalize_payload_compacts_validation_rules():
    out = normalize_knowledge_payload(
        {
            "validationRules": [
                {
                    "field": "title",
                    "rule": "title — String — Có — max 100",
                    "module": "Todo",
                },
                {"field": "x", "rule": "nhập đúng"},
                {"field": "Họ tên", "rule": "không được trống", "module": "Hồ sơ"},
            ]
        }
    )
    rules = out["validationRules"]
    fields = {r["field"] for r in rules}
    assert "title" in fields
    assert "Họ tên" in fields
    assert "x" not in fields
    title = next(r for r in rules if r["field"] == "title")
    assert title.get("module") == "Todo"
    assert "title —" not in title["rule"]
