"""
Post-gen guard for Unit TC drafts (preferred_engine=unit).

Clear UI/wizard violations → drop from persist.
Strip Latin Class.Method segments from title (SUT = Approve path:/code: only).
Portable — no product nouns.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

Decision = Literal["keep", "drop"]

# Wizard / multi-step UI as Unit
_WIZARD_RE = re.compile(
    r"(?i)("
    r"\bwizard\b|\bpopup\b|\bmodal\b|\bdialog\b|"
    r"\bform\b|\bdropdown\b|\btoast\b|"
    r"bước\s*\d+|\d+\s*bước|hai\s*bước|step\s*\d+|\d+\s*steps?|"
    r"chuyển\s*bước|quay\s*lại\s*bước|"
    r"màn\s*hình|\bpage\b|\bcomponent\b|"
    r"theo\s+\d+\s*bước|quy\s*trình\s+[^\n]{0,40}\d+\s*bước"
    r")"
)

# UI interaction verbs
_UI_VERB_RE = re.compile(
    r"(?i)\b("
    r"click|điền|nhập\s+vào\s+ô|fill\b|navigate|toast|"
    r"kéo\s*thả|drag[\s-]?drop|mở\s+popup|đóng\s+popup|"
    r"chọn\s+dropdown|bấm\s+nút"
    r")\b"
)

# Enable/disable UI control (presentation state)
_UI_ENABLE_RE = re.compile(
    r"(?i)("
    r"\benable\b|\bdisable\b|"
    r"chỉ\s+enable|mặc\s+định\s+disable|"
    r"trạng\s*thái\s+enable|"
    r"dropdown\s+(enable|disable)"
    r")"
)

# Middle segment: Feature - Class.Method - Result → strip Class.Method
_TITLE_LATIN_SUT_RE = re.compile(
    r"\s*-\s*[A-Za-z_][\w]*\.[A-Za-z_][\w]*\s*-",
)


@dataclass(frozen=True)
class UnitTcGuardResult:
    decision: Decision
    code: str | None = None


def _blob(*parts: str | None) -> str:
    return "\n".join(p for p in parts if p)


def sanitize_unit_tc_title(title: str | None) -> tuple[str, bool]:
    """
    Remove Latin Class.Method middle segments from Unit TC title.
    Returns (cleaned_title, changed).
    """
    t = (title or "").strip()
    if not t or not _TITLE_LATIN_SUT_RE.search(t):
        return t, False
    cleaned = _TITLE_LATIN_SUT_RE.sub(" - ", t)
    cleaned = re.sub(r"\s*-\s*-\s*", " - ", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip(" -")
    return cleaned, cleaned != t


def decide_unit_tc_draft(
    *,
    title: str | None = None,
    module: str | None = None,
    steps: str | None = None,
    expected_result: str | None = None,
    test_data: str | None = None,
    type: str | None = None,  # noqa: A002 — draft field name
) -> UnitTcGuardResult:
    """Fail-closed for clear UI/wizard Unit drafts."""
    text = _blob(title, module, steps, expected_result, test_data)

    if _WIZARD_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_WIZARD")
    if _UI_VERB_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_VERBS")
    if _UI_ENABLE_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_ENABLE")
    return UnitTcGuardResult("keep")


def filter_unit_tc_drafts(
    drafts: list[Any],
) -> tuple[list[Any], int, int]:
    """
    Filter mutable draft objects (attrs: title, steps, expected_result, test_data, …).
    Returns (kept_drafts, dropped_count, title_sanitized_count).
    Strips Class.Method from kept draft titles.
    """
    kept: list[Any] = []
    dropped = 0
    sanitized = 0
    for d in drafts:
        title = getattr(d, "title", None) or (d.get("title") if isinstance(d, dict) else None)
        module = getattr(d, "module", None) or (d.get("module") if isinstance(d, dict) else None)
        steps = getattr(d, "steps", None) or (d.get("steps") if isinstance(d, dict) else None)
        expected = getattr(d, "expected_result", None) or (
            d.get("expected_result") if isinstance(d, dict) else None
        )
        test_data = getattr(d, "test_data", None) or (
            d.get("test_data") if isinstance(d, dict) else None
        )
        typ = getattr(d, "type", None) or (d.get("type") if isinstance(d, dict) else None)

        result = decide_unit_tc_draft(
            title=title,
            module=module,
            steps=steps,
            expected_result=expected,
            test_data=test_data,
            type=typ,
        )
        if result.decision == "drop":
            dropped += 1
            continue

        new_title, changed = sanitize_unit_tc_title(title)
        if changed:
            sanitized += 1
            if isinstance(d, dict):
                d["title"] = new_title
            else:
                d.title = new_title
        kept.append(d)
    return kept, dropped, sanitized
