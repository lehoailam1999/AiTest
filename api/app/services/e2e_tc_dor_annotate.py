"""
Soft-annotate E2E TC drafts after LLM generation.

Marks post-login TCs that lack path: or only have vague steps with [Thiếu Context]
so Desktop DoR / UI can warn before Gen — does not invent missing fields.
"""

from __future__ import annotations

import re
from typing import Iterable

from app.llm.base import TestCaseDraft

_PATH_MARKER_RE = re.compile(
    r"(?im)^\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)"
)
_LOGIN_PUBLIC_RE = re.compile(
    r"login|log\s*in|đăng\s*nhập|sign\s*in|logout|đăng\s*xuất|"
    r"public|guest|anonymous|không cần đăng nhập|without auth|no auth",
    re.I,
)
_ACTIONABLE_RE = re.compile(
    r"(?:nhấn|bấm|click|chọn|select|điền|fill|nhập|type|enter|mở|open|"
    r"tạo|create|thêm|add|xóa|delete|upload|lưu|save|submit|goto|navigate)",
    re.I,
)
_VAGUE_RE = re.compile(
    r"^(?:\d+[\).\]]?\s*)?(?:kiểm\s*tra|verify|check|assert|xem|đảm\s*bảo|ensure|validate)\b",
    re.I,
)
_THIEU_FLAG = "[Thiếu Context]"


def _is_login_or_public(d: TestCaseDraft) -> bool:
    blob = "\n".join(
        filter(
            None,
            [d.title, d.precondition or "", d.steps or "", d.test_data or ""],
        )
    )
    return bool(_LOGIN_PUBLIC_RE.search(blob))


def _has_path(d: TestCaseDraft) -> bool:
    blob = "\n".join(filter(None, [d.precondition or "", d.test_data or "", d.steps or ""]))
    m = _PATH_MARKER_RE.search(blob)
    if not m:
        return False
    raw = m.group(1).strip().strip("\"'")
    return bool(raw) and raw != "/"


def _has_actionable_step(d: TestCaseDraft) -> bool:
    steps = (d.steps or "").strip()
    if not steps:
        return False
    for line in steps.splitlines():
        line = line.strip()
        if not line:
            continue
        if _ACTIONABLE_RE.search(line) and not (
            _VAGUE_RE.match(line)
            and not re.search(
                r"(?:nút|button|ô|field|input|dropdown|menu|tab|link|testid)",
                line,
                re.I,
            )
        ):
            return True
    return False


def _append_thieu(test_data: str | None, note: str) -> str:
    td = (test_data or "").rstrip()
    if _THIEU_FLAG in td:
        return td
    line = f"{_THIEU_FLAG} {note}"
    return f"{td}\n{line}".strip() if td else line


def annotate_e2e_tc_drafts(drafts: Iterable[TestCaseDraft]) -> list[TestCaseDraft]:
    """Mutate/return drafts: soft-flag thin post-login TCs in test_data."""
    out: list[TestCaseDraft] = []
    for d in drafts:
        if (d.type or "").strip().upper() not in ("E2E", "E2E_UI", "UI", ""):
            # Only annotate when type looks E2E; empty type still check path rules for e2e jobs
            if d.type and d.type.strip().upper() not in (
                "E2E",
                "FUNCTIONAL",
                "E2E_UI",
            ):
                out.append(d)
                continue
        if _is_login_or_public(d):
            out.append(d)
            continue
        missing: list[str] = []
        if not _has_path(d):
            missing.append("thiếu path hoặc featurePath")
        if not _has_actionable_step(d):
            missing.append("step quá chung (cần Hành động→Element→Data)")
        if missing:
            d.test_data = _append_thieu(d.test_data, "; ".join(missing))
        out.append(d)
    return out
