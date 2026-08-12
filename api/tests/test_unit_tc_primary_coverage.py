"""Unit TC PRIMARY coverage anti-miss."""

from __future__ import annotations

from types import SimpleNamespace

from app.features.requirement_studio.snapshot_prompt import slice_knowledge_payload_for_module
from app.services.unit_tc_primary_coverage import (
    build_primary_inventory,
    coverage_summary,
    format_primary_miss_block,
    missing_primary_signals,
)


def test_build_primary_inventory_from_knowledge_buckets():
    kw = {
        "businessRules": [{"id": "BR-7", "text": "Gắn hồ sơ theo mã"}],
        "validationRules": [{"id": "VAL-Ngăn", "field": "Ngăn", "rule": "bắt buộc"}],
        "exceptions": [{"code": "EXC-IMG-FORMAT", "text": "Từ chối định dạng ảnh"}],
        "acceptanceCriteria": [{"text": "Người dùng hoàn tất tạo vật chứng"}],
    }
    inv = build_primary_inventory(kw)
    assert len(inv) == 4
    buckets = {s.bucket for s in inv}
    assert buckets == {
        "BUSINESS_RULES",
        "VALIDATION_DATA",
        "ERROR_HANDLING",
        "ACCEPTANCE",
    }
    ids = {s.req_id for s in inv}
    assert "BR-7" in ids
    assert "VAL-Ngăn" in ids or "VAL-NGĂN" in {x.upper() for x in ids} or any(
        "VAL" in x.upper() for x in ids
    )
    assert any("EXC-IMG-FORMAT" in s.req_id.upper() for s in inv)


def test_missing_primary_detects_uncovered_and_covered_by_trace():
    inv = build_primary_inventory(
        {
            "businessRules": [{"id": "BR-7", "text": "Tìm theo mã"}],
            "validationRules": [{"id": "VAL-1", "rule": "bắt buộc"}],
            "exceptions": [],
            "acceptanceCriteria": [],
        }
    )
    drafts = [
        SimpleNamespace(
            title="Tìm theo mã - ok",
            module="Gắn hồ sơ",
            steps="1. search",
            expected_result="ok",
            precondition="",
            test_data="trace: BUSINESS_RULES/BR-7\nbehaviorId: BR-7-B01\nprimaryBucket: BUSINESS_RULES",
        )
    ]
    missing = missing_primary_signals(inv, drafts)
    assert len(missing) == 1
    assert missing[0].req_id == "VAL-1"
    assert coverage_summary(inv, missing)["covered"] == 1


def test_format_primary_miss_block_lists_ids():
    inv = build_primary_inventory(
        {
            "businessRules": [{"id": "BR-9", "text": "Policy X"}],
            "validationRules": [],
            "exceptions": [{"id": "EXC-1", "text": "Reject"}],
            "acceptanceCriteria": [],
        }
    )
    block = format_primary_miss_block(inv, limit=10)
    assert "BR-9" in block
    assert "EXC-1" in block
    assert "PRIMARY coverage gap" in block


def test_module_slice_keeps_unmatched_primary_inventory():
    kw = {
        "features": [{"name": "Upload ảnh"}],
        "businessRules": [
            {"id": "BR-1", "text": "Upload ảnh phải quét virus"},
            {"id": "BR-99", "text": "Policy toàn cục không gắn feature"},
        ],
        "validationRules": [{"id": "VAL-1", "rule": "jpg only"}],
        "exceptions": [{"id": "EXC-1", "text": "bad format"}],
        "acceptanceCriteria": [{"id": "AC-1", "text": "done"}],
    }
    sliced = slice_knowledge_payload_for_module(kw, "Upload ảnh")
    br_ids = {
        str(r.get("id"))
        for r in sliced["businessRules"]
        if isinstance(r, dict)
    }
    assert "BR-1" in br_ids
    assert "BR-99" in br_ids  # anti-miss: unmatched still kept
    assert len(sliced["validationRules"]) >= 1
    assert len(sliced["exceptions"]) >= 1
