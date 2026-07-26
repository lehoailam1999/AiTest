"""Salvage complete TCs when LLM JSON is truncated mid-string."""

from __future__ import annotations

import pytest

from app.llm.base import parse_test_cases_json, salvage_test_cases_from_truncated


def _tc(title: str, steps: str = "1. Do x", expected: str = "y happens") -> str:
    return (
        "{"
        f'"title":"{title}",'
        f'"steps":"{steps}",'
        f'"expectedResult":"{expected}",'
        '"type":"Functional","priority":"High","module":"Login"'
        "}"
    )


def test_salvage_keeps_complete_objects_from_truncated_array():
    raw = (
        '{"testCases":['
        + _tc("TC A")
        + ","
        + _tc("TC B")
        + ","
        + '{"title":"TC C","steps":"1. Start","expectedResult":"cut mid'
    )
    salvaged = salvage_test_cases_from_truncated(raw)
    assert [x["title"] for x in salvaged] == ["TC A", "TC B"]


def test_parse_returns_salvaged_instead_of_unterminated_error():
    raw = (
        '{"testCases":['
        + _tc("Đăng nhập thành công")
        + ","
        + '{"title":"Partial","steps":"1. Open","expectedResult":"Unterminated'
    )
    drafts = parse_test_cases_json(raw)
    assert len(drafts) == 1
    assert drafts[0].title == "Đăng nhập thành công"
    assert drafts[0].steps == "1. Do x"


def test_parse_still_errors_when_nothing_complete():
    raw = '{"testCases":[{"title":"Only","steps":"1. x","expectedResult":"cut'
    with pytest.raises(ValueError, match="parse LLM JSON|no valid"):
        parse_test_cases_json(raw)
