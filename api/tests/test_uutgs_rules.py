"""UUTGS — Universal Unit Test Generation Specification."""

from __future__ import annotations

from app.llm.base import unit_system_prompt, unit_user_prompt, UnitRequest
from app.llm.uutgs_rules import UUTGS_SPEC, uutgs_system_block


def test_uutgs_is_specification_not_checklist_dump():
    text = UUTGS_SPEC
    assert text.startswith("# UUTGS") or "UUTGS" in text
    assert "SHALL" in text
    assert "Single Source of Truth" in text
    assert "Analyze Before Generate" in text
    assert "Forbidden" in text
    # Compact enough for system prompt budget
    assert len(text) < 4000


def test_unit_system_prompt_embeds_uutgs_once():
    p = unit_system_prompt("jest", "TypeScript", testing_framework="jest", mock_framework="jest")
    assert p.count("UUTGS") >= 1
    assert uutgs_system_block()[:40] in p
    assert "Emit constraints" in p
    # Old checklist opener removed
    assert "You are a senior software engineer writing automated unit tests." not in p


def test_unit_user_prompt_is_data_only():
    req = UnitRequest(
        test_case_title="Add item",
        test_case_type="Unit",
        priority="High",
        steps="1. call add",
        expected_result="ok",
        precondition="",
        test_data="",
        source_file_name="cart.service.ts",
        source_code="export class CartService { add() {} }",
        class_name="CartService",
        method_name="add",
        framework="jest",
        language="TypeScript",
        testing_framework="jest",
    )
    user = unit_user_prompt(req)
    assert "scenario intent" in user.lower() or "Approved test case" in user
    assert "Source under test" in user
    # Full UUTGS body must not be duplicated in user prompt
    assert "Analyze Before Generate" not in user
    assert "UUTGS" in user  # pointer only
