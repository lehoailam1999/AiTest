"""Phase 6 failure taxonomy + slim repair helpers."""

from app.services.failure_taxonomy import (
    classify_e2e_standard,
    classify_unit_failure,
    format_e2e_heal_taxonomy_block,
    format_unit_repair_taxonomy_block,
    map_desktop_e2e_category,
    slim_related_for_repair,
    truncate_sut_for_repair,
)
from app.services.unit_test_orchestrator import build_repair_prompt_context


def test_classify_unit_failure():
    assert classify_unit_failure("Cannot find module './x'") == "ImportError"
    assert classify_unit_failure("error TS2304") == "CompileError"
    assert classify_unit_failure("AssertionError: expected 1") == "AssertionFailed"
    assert classify_unit_failure("") == "Other"


def test_classify_e2e_standard():
    assert classify_e2e_standard("ContextMissing: no FE") == "ContextMissing"
    assert "LocatorNotFound" in classify_e2e_standard(
        "strict mode violation getByRole"
    ) or classify_e2e_standard("strict mode violation getByRole") == "LocatorNotFound"
    assert (
        classify_e2e_standard("BusinessAssertionFailed: missing assert")
        == "BusinessAssertionFailed"
    )


def test_map_desktop_category():
    assert map_desktop_e2e_category("auth") == "PreconditionFailed"
    assert map_desktop_e2e_category("locator") == "LocatorNotFound"
    assert map_desktop_e2e_category("assert") == "BusinessAssertionFailed"


def test_slim_related_for_repair():
    related = [("a.ts", "a"), ("b.ts", "b"), ("c.ts", "c"), ("d.ts", "d")]
    slim = slim_related_for_repair(
        related,
        test_file_rel="AItest/t.spec.ts",
        test_code="test",
        top_k=3,
    )
    assert slim[0][0] == "AItest/t.spec.ts"
    assert len(slim) == 4  # test + 3 deps


def test_truncate_sut():
    long = "x" * 10000
    out = truncate_sut_for_repair(long, limit=100)
    assert len(out) < 200
    assert "truncated" in out


def test_build_repair_includes_taxonomy():
    ctx = build_repair_prompt_context(
        test_file_rel="t.spec.ts",
        run_command=["npx", "vitest"],
        error_log="AssertionError",
        attempt=1,
        max_retries=3,
        failure_class="AssertionFailed",
    )
    assert "AssertionFailed" in ctx
    assert "Phase 6" in ctx
    assert format_unit_repair_taxonomy_block("ImportError")
    assert "ContextMissing" in format_e2e_heal_taxonomy_block("ContextMissing")
