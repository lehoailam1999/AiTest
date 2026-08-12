"""
Soft-annotate E2E TC drafts after LLM generation.

Marks post-login TCs that lack usable path: or only have vague steps with [Thiếu Context]
so Desktop DoR / UI can warn before Gen — does not invent missing fields.
"""

from __future__ import annotations

import re
from typing import Iterable

from app.llm.base import TestCaseDraft

_PATH_MARKER_RE = re.compile(
    r"(?im)^\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)"
)
_AUTH_ROLE_RE = re.compile(
    r"(?im)(?:authRole|auth_role|role)\s*[:=]\s*([A-Za-z0-9_-]+)"
)
_LOGIN_PUBLIC_RE = re.compile(
    r"login|log\s*in|đăng\s*nhập|sign\s*in|logout|đăng\s*xuất|"
    r"public|guest|anonymous|không cần đăng nhập|without auth|no auth",
    re.I,
)
_POST_LOGIN_RE = re.compile(
    r"đã\s*đăng\s*nhập|authenticated|logged\s*in",
    re.I,
)
_LOGIN_TITLE_RE = re.compile(
    r"^(?:[A-Za-z0-9_-]+\s*-\s*)?(?:đăng\s*nhập|login|log\s*in|sign\s*in)\s*$",
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


def _is_usable_feature_path(raw: str) -> bool:
    p = (raw or "").strip().strip("\"'")
    if re.match(r"^https?://", p, re.I):
        try:
            from urllib.parse import urlparse

            p = urlparse(p).path or ""
        except Exception:
            return False
    p = re.sub(r"\s*[\[(#].*$", "", p).strip()
    if not p or p == "/":
        return False
    if re.search(r"thi[eế]u\s*context|missing\s*context|[\[\]]", p, re.I):
        return False
    return bool(re.match(r"^/?[A-Za-z][A-Za-z0-9_\-./]*$", p.replace(" ", "")))


def _blob(d: TestCaseDraft) -> str:
    return "\n".join(
        filter(
            None,
            [d.title, d.precondition or "", d.steps or "", d.test_data or ""],
        )
    )


def _is_login_or_public(d: TestCaseDraft) -> bool:
    title = (d.title or "").strip()
    if _LOGIN_TITLE_RE.match(title):
        return True
    blob = _blob(d)
    if _POST_LOGIN_RE.search(blob):
        return False
    return bool(_LOGIN_PUBLIC_RE.search(blob))


def _has_usable_path(d: TestCaseDraft) -> bool:
    blob = "\n".join(filter(None, [d.precondition or "", d.test_data or "", d.steps or ""]))
    m = _PATH_MARKER_RE.search(blob)
    if not m:
        return False
    return _is_usable_feature_path(m.group(1))


def _has_auth_role(d: TestCaseDraft) -> bool:
    return bool(_AUTH_ROLE_RE.search(_blob(d)))


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
        if not _has_usable_path(d):
            missing.append("thiếu path/featurePath usable (AbsolutePath ASCII)")
        if not _has_auth_role(d):
            missing.append("thiếu authRole (post-login)")
        if not _has_actionable_step(d):
            missing.append("step quá chung (cần Hành động→Element→Data)")
        if missing:
            d.test_data = _append_thieu(d.test_data, "; ".join(missing))
        out.append(d)
    return out
