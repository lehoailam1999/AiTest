"""Phase 6 — failure taxonomy for Unit / E2E validate + auto-fix.

Bounded repair loops classify the error, then send a slim repair packet
(error excerpt + failing file + Top-K deps). Standard E2E names match
docs/AI_TEST_RULES.md.
"""

from __future__ import annotations

import re
from typing import Literal

# --- Unit ---
UnitFailClass = Literal[
    "CompileError",
    "ImportError",
    "AssertionFailed",
    "RuntimeError",
    "Timeout",
    "Other",
]

# --- E2E (AI_TEST_RULES) ---
E2eStandardTaxonomy = Literal[
    "ContextMissing",
    "PreconditionFailed",
    "LocatorNotFound",
    "BusinessAssertionFailed",
    "Other",
]

UNIT_TOP_K_RELATED = 3
UNIT_SUT_REPAIR_CHARS = 8000
ERROR_LOG_TAIL = 2500

_UNIT_RULES: list[tuple[UnitFailClass, re.Pattern[str]]] = [
    (
        "CompileError",
        re.compile(
            r"TS\d{3,5}|error CS\d+|javac?:|cannot find symbol|SyntaxError|"
            r"Unexpected token|failed to compile|Type error:|error\[E\d+\]",
            re.I,
        ),
    ),
    (
        "ImportError",
        re.compile(
            r"Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|"
            r"ImportError|Unable to resolve|Could not find a declaration|"
            r"package .+ does not exist|CS0246",
            re.I,
        ),
    ),
    (
        "Timeout",
        re.compile(r"Timeout|timed?\s*out|Jest did not exit|async tests", re.I),
    ),
    (
        "AssertionFailed",
        re.compile(
            r"AssertionError|expect\(|Expected:|toEqual|toBe\(|assert\.|"
            r"Xunit\.Sdk|NUnit\.Framework\.AssertionException|Failed:\s*",
            re.I,
        ),
    ),
    (
        "RuntimeError",
        re.compile(
            r"TypeError|ReferenceError|NullReferenceException|"
            r"is not a function|Cannot read propert|Unhandled|RuntimeError",
            re.I,
        ),
    ),
]

_E2E_LOG_RULES: list[tuple[E2eStandardTaxonomy, re.Pattern[str]]] = [
    (
        "ContextMissing",
        re.compile(
            r"ContextMissing|E2E_GROUNDING|featurePath.*MISSING|no FE source|"
            r"domSnapshot.*empty|missing featurePath|seed.*missing",
            re.I,
        ),
    ),
    (
        "PreconditionFailed",
        re.compile(
            r"PreconditionFailed|login wall|storageState|E2E_USERNAME|"
            r"ExecutionGateFailed|auth required|still on (?:the )?login",
            re.I,
        ),
    ),
    (
        "LocatorNotFound",
        re.compile(
            r"LocatorNotFound|strict mode violation|getBy(?:Role|Text|Label|TestId)|"
            r"locator\(|not visible|resolved to \d+ elements|Timeout \d+ms exceeded|"
            r"waiting for (?:locator|selector)",
            re.I,
        ),
    ),
    (
        "BusinessAssertionFailed",
        re.compile(
            r"BusinessAssertionFailed|expect\(|AssertionError|toHave(?:Text|URL|Count)|"
            r"toContainText|toBeVisible",
            re.I,
        ),
    ),
]

# Desktop E2eFailCategory → standard taxonomy
_DESKTOP_CAT_TO_STANDARD: dict[str, E2eStandardTaxonomy] = {
    "auth": "PreconditionFailed",
    "feature_entry": "ContextMissing",
    "locator": "LocatorNotFound",
    "timeout": "LocatorNotFound",
    "assert": "BusinessAssertionFailed",
    "stub": "ContextMissing",
    "crash": "ContextMissing",
    "codegen": "ContextMissing",
    "execution_gate": "PreconditionFailed",
    "other": "Other",
}


def classify_unit_failure(error_log: str | None) -> UnitFailClass:
    text = (error_log or "").strip()
    if not text:
        return "Other"
    for cls, pat in _UNIT_RULES:
        if pat.search(text):
            return cls
    return "Other"


def classify_e2e_standard(error_log: str | None) -> E2eStandardTaxonomy:
    text = (error_log or "").strip()
    if not text:
        return "Other"
    for tax, pat in _E2E_LOG_RULES:
        if pat.search(text):
            return tax
    return "Other"


def map_desktop_e2e_category(category: str | None) -> E2eStandardTaxonomy:
    if not category:
        return "Other"
    return _DESKTOP_CAT_TO_STANDARD.get(category.strip().lower(), "Other")


def slim_related_for_repair(
    related: list[tuple[str, str]],
    *,
    test_file_rel: str,
    test_code: str,
    top_k: int = UNIT_TOP_K_RELATED,
) -> list[tuple[str, str]]:
    """Failing test file first, then up to top_k other deps (deduped)."""
    test_norm = (test_file_rel or "").replace("\\", "/").lstrip("./")
    out: list[tuple[str, str]] = [(test_file_rel, test_code)]
    seen = {test_norm}
    for path, content in related:
        if len(out) > top_k:  # test + top_k deps
            break
        p = (path or "").replace("\\", "/").lstrip("./")
        if not p or p in seen:
            continue
        seen.add(p)
        out.append((path, content))
    return out


def truncate_sut_for_repair(source_code: str, limit: int = UNIT_SUT_REPAIR_CHARS) -> str:
    s = source_code or ""
    if len(s) <= limit:
        return s
    return s[:limit] + "\n…[truncated for Phase 6 repair]\n"


def format_unit_repair_taxonomy_block(fail_class: UnitFailClass) -> str:
    return (
        f"Failure taxonomy (Phase 6): {fail_class}\n"
        "Fix ONLY the unit test file to address this class of error. "
        "Do not invent SUT APIs; use Related + Source under test as SoT.\n"
    )


def format_e2e_heal_taxonomy_block(taxonomy: E2eStandardTaxonomy) -> str:
    hints = {
        "ContextMissing": "Restore grounding (featurePath / FE seed / DOM); do not invent routes.",
        "PreconditionFailed": "Fix auth/storageState/precondition before Act assertions.",
        "LocatorNotFound": "Rewrite locators from FE/DOM contract; scope strict-mode matches.",
        "BusinessAssertionFailed": "Assert business outcomes from the Approved TC expected result.",
        "Other": "Minimal heal: fix the failing file(s) only.",
    }
    return (
        f"Failure taxonomy (Phase 6 / AI_TEST_RULES): {taxonomy}\n"
        f"{hints.get(taxonomy, hints['Other'])}\n"
    )
