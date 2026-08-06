"""Phase 5 generate-input helpers — additive, legacy-safe."""

from app.llm.base import UnitRequest, unit_user_prompt
from app.services.phase5_gen_input import (
    format_e2e_planner_hint,
    format_unit_planner_hint,
    merge_related_from_context_files,
    parse_context_files,
    parse_index_version,
    parse_planner,
)


def test_parse_planner_ignores_invalid():
    assert parse_planner(None) is None
    assert parse_planner([]) is None
    assert parse_planner({"testType": "Unit", "module": "Auth"})["module"] == "Auth"


def test_parse_context_files():
    files = parse_context_files(
        [
            {"path": "src/a.ts", "content": "export const a=1"},
            {"pathRel": "src/b.ts", "content": "export const b=2"},
            {"path": "skip", "content": None},
            "bad",
        ]
    )
    assert files == [
        ("src/a.ts", "export const a=1"),
        ("src/b.ts", "export const b=2"),
    ]


def test_merge_related_keeps_existing():
    related = [("a.ts", "a")]
    merged = merge_related_from_context_files(
        related,
        [("b.ts", "b")],
        primary_path="a.ts",
    )
    assert merged == related


def test_merge_related_from_empty_skips_primary():
    merged = merge_related_from_context_files(
        [],
        [("src/a.ts", "a"), ("src/b.ts", "b")],
        primary_path="src/a.ts",
    )
    assert merged == [("src/b.ts", "b")]


def test_unit_planner_hint_in_prompt():
    hint = format_unit_planner_hint(
        {
            "testType": "Unit",
            "module": "Orders",
            "action": "create",
            "keywords": ["order", "create"],
            "hints": {"framework": "jest"},
        }
    )
    assert "Mock → Arrange → Act → Assert" in hint
    assert "Orders" in hint
    req = UnitRequest(
        test_case_title="Create order",
        test_case_type="Unit",
        priority="High",
        steps="1. call create",
        expected_result="ok",
        precondition="",
        test_data="",
        source_file_name="src/order.ts",
        source_code="export function create() { return 1 }",
        class_name="",
        method_name="create",
        framework="jest",
        language="TypeScript",
        planner_hint=hint,
        index_version="aitest-code-index-v1",
    )
    prompt = unit_user_prompt(req)
    assert "Generation plan (Phase 5" in prompt
    assert "aitest-code-index-v1" in prompt


def test_e2e_planner_hint():
    hint = format_e2e_planner_hint(
        {
            "testType": "E2E",
            "module": "Login",
            "action": "login",
            "keywords": ["auth"],
            "hints": {"featurePath": "/login"},
        }
    )
    assert "Fixture → Locator → Action → Assertion → Cleanup" in hint
    assert "/login" in hint


def test_parse_index_version():
    assert parse_index_version(None) == ""
    assert parse_index_version("aitest-code-index-v1") == "aitest-code-index-v1"
