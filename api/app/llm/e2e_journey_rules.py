"""
E2E feature-journey rules — Phase A–F + Feature entry ONLY.

Auth/role/locator/assert/session → ``e2e_codegen_rules.py`` (E2ECG). Do not restate.

Cursor: ``.cursor/rules/e2e-feature-journey.mdc`` — keep in sync with this skeleton.
"""

from __future__ import annotations

# Unique value = Feature entry. Everything else points at E2ECG / auth_mode overlay.
E2E_FEATURE_JOURNEY_RULES = """\
## Feature journey skeleton (after Execution Context + auth_mode resolved)

### Spec skeleton (order)
```
0. Auth…     → per auth_mode overlay + E2ECG 1–6 (skip if PUBLIC / storage already loaded)
1. Feature…  → gotoFeature/goto + landmark on FEATURE screen
2. Arrange…  → dialog/tab/filter from Precondition
3..N Act…    → one test.step per numbered TC Step
final Assert → Expected on feature UI (E2ECG 14)
```

### Phase A START
- `page.goto('/')` or baseURL only. No deep-link before auth (except PUBLIC / Login TC).

### Phase B AUTH
- Follow AUTH overlay only — details in E2ECG Rules 1–6.

### Phase C FEATURE ENTRY (AFTER auth, BEFORE fill) — do not skip
Resolve path STRICTLY; comment `// Feature entry: …`:
1) TC Precondition / Steps / `path:` / `route:`
2) FE source: routerLink, href, Routes, path:
3) `process.env.E2E_FEATURE_PATH` (or module E2E_*_PATH)
4) Sidebar/menu by **exact** FE visible name / data-cy — never paraphrase
Else menu-click FE labels — do NOT invent `/admin/...`.
Landmark = heading/module OR `[data-cy=…]` list/form OR dialog title from Precondition.
List vs form: open Create/Edit (FE button) BEFORE fills if fields only exist in dialog.

### Phase D–F
- Arrange / Act / Assert per E2ECG 7–14 (incl. Validation/Boundary/RBAC non-happy).

### Anti-patterns (Feature entry)
- Fill feature fields while still on home/login
- Invented feature path not in TC/FE/env
- Assert list-page fields that only exist inside Create/Edit dialog
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
            "Needs dialog/form → Phase D open Create/Edit BEFORE filling fields."
        )
    extra = ("\n".join(f"- {h}" for h in hints) + "\n") if hints else ""
    return (
        "## Feature entry checklist\n"
        "1. After auth: write `// Feature entry: <path|menu>` from "
        "Precondition / FE source / E2E_FEATURE_PATH — then goto + landmark visible.\n"
        "2. Prefer FE menu labels over inventing a path when route is unknown.\n"
        f"{extra}"
    )
