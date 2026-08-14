"""Unit BE context filter — PRIMARY only; E2E must not depend on this."""

from __future__ import annotations

from app.services.unit_tc_be_context import (
    UNIT_ANALYSIS_TYPES,
    acceptance_is_ui_only,
    filter_acceptance_be_only,
    filter_knowledge_primary_be,
    is_unit_analysis_type,
)


def test_unit_analysis_types_are_primary_four():
    assert UNIT_ANALYSIS_TYPES == {
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
    }
    assert is_unit_analysis_type("BUSINESS_RULES")
    assert not is_unit_analysis_type("FEATURES")
    assert not is_unit_analysis_type("BUSINESS_FLOWS")
    assert not is_unit_analysis_type("API_UI")


def test_filter_knowledge_drops_flows_api_keeps_primary():
    slim = filter_knowledge_primary_be(
        {
            "summary": "S",
            "features": [
                {"name": "Tạo mới", "description": "FR-01 mở form wizard click"}
            ],
            "useCases": [{"name": "UC", "steps": "1. mở form"}],
            "actors": [{"name": "A"}],
            "apiSummary": [{"method": "POST", "path": "/x"}],
            "businessRules": [{"id": "BR-1", "text": "mã duy nhất"}],
            "validationRules": [{"id": "VAL-1", "field": "mã", "rule": "required"}],
            "exceptions": [{"id": "EXC-1", "text": "từ chối thiếu mã"}],
            "acceptanceCriteria": [
                {"id": "AC-1", "text": "When lưu Then persist thành công"},
                {"id": "AC-UI", "text": "Hiển thị nút Lưu trên màn hình"},
            ],
            "constraints": [{"text": "nfr"}],
        },
        module="Tạo mới",
    )
    assert slim["useCases"] == []
    assert slim["actors"] == []
    assert slim["apiSummary"] == []
    assert slim["constraints"] == []
    assert len(slim["businessRules"]) == 1
    assert len(slim["validationRules"]) == 1
    assert len(slim["exceptions"]) == 1
    assert slim["features"][0]["name"] == "Tạo mới"
    assert slim["features"][0]["description"] == ""
    ac_ids = {a.get("id") for a in slim["acceptanceCriteria"]}
    assert "AC-1" in ac_ids
    assert "AC-UI" not in ac_ids


def test_acceptance_ui_only_heuristic():
    assert acceptance_is_ui_only({"text": "Hiển thị nút trên màn hình"})
    assert not acceptance_is_ui_only(
        {"text": "Khi thiếu mã hệ thống từ chối lưu (reject)"}
    )
    assert filter_acceptance_be_only(
        [
            {"text": "toast popup wizard"},
            {"text": "validate required field bắt buộc"},
        ]
    ) == [{"text": "validate required field bắt buộc"}]
