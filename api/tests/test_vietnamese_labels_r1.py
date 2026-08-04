"""R1 — normalize_engine_type / type_vi / priority_rank."""

from __future__ import annotations

from app.services.vietnamese_labels import (
    normalize_engine_type,
    priority_order_expr,
    priority_rank,
    type_vi,
)


def test_type_vi_engine_kinds():
    assert type_vi("e2e") == "E2E"
    assert type_vi("Journey") == "E2E"
    assert type_vi("unit") == "Unit"
    assert type_vi("Api") == "API"
    assert type_vi("Functional") == "Chức năng"


def test_normalize_engine_type_on_approve():
    assert normalize_engine_type("journey") == "E2E"
    assert normalize_engine_type("UI") == "E2E"
    assert normalize_engine_type("end-to-end") == "E2E"
    assert normalize_engine_type("unit test") == "Unit"
    assert normalize_engine_type("api") == "API"
    assert normalize_engine_type("Chức năng") == "Chức năng"
    assert normalize_engine_type("") == "Chức năng"


def test_priority_rank_high_to_low():
    assert priority_rank("Nghiêm trọng") == 0
    assert priority_rank("Critical") == 0
    assert priority_rank("Cao") == 1
    assert priority_rank("High") == 1
    assert priority_rank("Trung bình") == 2
    assert priority_rank("Medium") == 2
    assert priority_rank("Thấp") == 3
    assert priority_rank("Low") == 3
    assert priority_rank(None) == 4
    assert priority_rank("???") == 4

    ordered = sorted(
        ["Thấp", "Nghiêm trọng", "Cao", "Trung bình"],
        key=priority_rank,
    )
    assert ordered == ["Nghiêm trọng", "Cao", "Trung bình", "Thấp"]


def test_priority_order_expr_builds():
    from app.models.domain import TestCase

    expr = priority_order_expr(TestCase.priority)
    assert expr is not None
