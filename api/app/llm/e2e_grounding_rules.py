"""
E2E grounding — cross-project conventions (learned from mature suites like Forensic.E2E).

Portable signals + fail-closed when ground truth is missing.
NOT app-specific routes, roles, or data-cy strings.

Auth/locator detail → ``e2e_codegen_rules.py`` (E2ECG).
Feature entry priority → ``e2e_codegen_rules.py`` (E2ECG Phase C).
TC ``path:`` contract → ``e2e_tc_analysis_rules.py``.

Cursor: ``.cursor/rules/e2e-grounding.mdc`` — keep in sync.
"""

from __future__ import annotations

# Compact — pointers only; do not duplicate E2ECG essays.
E2E_GROUNDING_RULES = """\
## E2E Grounding (portable — all projects)

1. FEATURE PATH: post-login TC → `path:` / `featurePath:` in testData (or Spec Feature-entry).
   Source: FE routes / Analysis FLOWS|API_UI|FEATURES — never invent `/admin/...`.
2. FEATURE ENTRY: after auth → `goto(canonicalPath)` + landmark (heading|testid|table from DOM/FE).
   Menu only if path unknown. `gotoFeature` ≠ auto-Create.
3. AUTH: prefer per-role storageState; feature Specs no UI login. Login-wall Inspect ≠ feature locators.
4. LOCATORS: data-cy|data-testid → label → role+name → #id|formControlName|name → visible text last.
   Prefer a single hook. Fallback via Playwright `.or(...)`, not CSS comma-OR lists.
   Never invent testids.
5. CREATE/EDIT: list Create control + modal visible BEFORE fill (openCreateModal pattern).
6. POM VERBS: gotoFeature / openCreate* / fill* / save* / expect* — Spec `test.step` calls verbs.
7. VALIDATION: disable/error/cancel — never force happy-submit.
8. FAIL-CLOSED: no DOM/FE hook for a verb → Phase-3 ungrounded **throw** (no `button.first()` invent, no warn+return Act skip).
9. SPEC HYGIENE: `*.spec.ts` + aligned primarySpec (avoid "No tests found").
10. HOST OPS: Cursor timeout/concurrency = env/desktop knobs — not LLM prompt bulk.
"""


def e2e_grounding_system_pointer() -> str:
    """One-liner for E2ECG / journey — avoids essay duplication in system prompt."""
    return (
        "- Grounding SoT: path+landmark+data-cy priority+fail-closed stubs "
        "(see E2E_GROUNDING / e2e_grounding_rules)."
    )
