"""
E2E feature-journey adapter.

Single rule SoT is ``api/app/llm/e2e_codegen_rules.py``.
This file stays as a thin compatibility layer because ``e2e_system_prompt()``
imports ``E2E_FEATURE_JOURNEY_RULES``.
"""

from __future__ import annotations

# Runtime uses only this concise pointer to avoid duplicated rule text.
E2E_FEATURE_JOURNEY_RULES = """\
## Feature entry policy
Use `api/app/llm/e2e_codegen_rules.py` as the single rule source (E2ECG Rules 1–27).
Do not restate or override journey/auth/locator/order rules here.
"""


def e2e_journey_user_checklist(
    *,
    test_case_title: str = "",
    test_case_type: str = "",
    precondition: str = "",
    steps: str = "",
    expected_result: str = "",
) -> str:
    """Per-TC hints only. Authoritative behavior is in E2ECG (single SoT)."""
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
