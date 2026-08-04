"""
E2E feature-journey rules — Phase C Feature entry ONLY.

Auth/role/locator/assert/Act-Arrange → ``e2e_codegen_rules.py`` (E2ECG 1–19). Do not restate.
Spec order Auth→Feature→Arrange→Act → E2ECG Rule 7 (Phase 2 guard enforces).

Cursor: ``.cursor/rules/e2e-feature-journey.mdc`` — keep in sync (Phase C only).
"""

from __future__ import annotations

# Unique value = Feature entry. Everything else → E2ECG + E2E_GROUNDING.
E2E_FEATURE_JOURNEY_RULES = """\
## Feature entry (Phase C — after auth, before fill)

Also follow E2E_GROUNDING (path+landmark+fail-closed). Prefer deep-link **per TC**:
1. Spec/POM Feature-entry prose / `E2E_FEATURE_PATH` — highest
2. TC `path:` / `featurePath:` + path tokens (required on post-login TC)
3. FE route file → URL segment (e.g. `app/foo/routes.ts` or `pages/foo/` → `/foo` — **from this project only**)
4. Inspect routes scored vs TC tokens
Guard force-bakes into Spec↔POM. Do NOT invent app routes (`/admin/...`, `/app/...`) without a signal.
Menu only if path still unknown — label from this project's Inspect DOM.
Landmark visible; open Create/Edit before fills if fields live in dialog.
`gotoFeature` alone does not auto-click Create.

### Anti-patterns
- Fill on login/home · invented routes · assert dialog fields on list page ·
  inventing `button.first()` when DOM/FE empty (fail-closed → Phase-3)
"""


def e2e_journey_user_checklist(
    *,
    test_case_title: str = "",
    test_case_type: str = "",
    precondition: str = "",
    steps: str = "",
    expected_result: str = "",
) -> str:
    """Per-TC Feature-entry hints only — auth/context live in Execution Context block + E2ECG."""
    blob = f"{test_case_title}\n{test_case_type}\n{precondition}\n{steps}\n{expected_result}".lower()
    hints: list[str] = []
    if any(
        k in blob
        for k in (
            "valid",
            "validation",
            "boundary",
            "giới hạn",
            "tối đa",
            "bắt buộc",
            "required",
            "không chấp nhận",
            "invalid",
            "whitespace",
            "khoảng trắng",
        )
    ):
        hints.append(
            "VALIDATION/BOUNDARY → disable/error asserts; never force happy-submit."
        )
    if any(
        k in blob
        for k in (
            "permission",
            "rbac",
            "role",
            "unauthorized",
            "forbidden",
            "phân quyền",
            "không có quyền",
        )
    ):
        hints.append("RBAC → correct E2E_ROLE / multi-context; assert hidden/disabled/forbidden.")
    if any(k in blob for k in ("empty", "không có", "not found", "no data", "trống")):
        hints.append("EMPTY/NOT-FOUND → empty-state only; do not invent rows.")
    if any(k in blob for k in ("cancel", "hủy", "đóng", "dismiss", "rollback")):
        hints.append("CANCEL/DISMISS → form closed + no persist.")
    if any(
        k in blob
        for k in (
            "tạo mới",
            "create",
            "thêm",
            "popup",
            "dialog",
            "modal",
            "chỉnh sửa",
            "edit",
        )
    ):
        hints.append(
            "Needs dialog/form → open Create/Edit BEFORE filling fields (E2ECG 19)."
        )
    extra = ("\n".join(f"- {h}" for h in hints) + "\n") if hints else ""
    return (
        "## Feature entry checklist\n"
        "Follow E2ECG 7–19 + Phase C. After auth: deep-link Feature path "
        "(see ## Feature path if present) + landmark before Act.\n"
        f"{extra}"
    )
