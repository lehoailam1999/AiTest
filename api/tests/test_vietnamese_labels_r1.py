"""R1 — normalize_engine_type / type_vi."""

from __future__ import annotations

from app.services.vietnamese_labels import normalize_engine_type, type_vi


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
