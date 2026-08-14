"""
Post-gen guard for Unit TC drafts (preferred_engine=unit).

Drop presentation / interaction-only drafts (portable heuristics — no product nouns).
Drop FEATURES-only / missing primaryBucket when IR markers present.
Strip Latin Class.Method segments from title (SUT = Approve path:/code: only).

E2E path must not call this module.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from typing import Any, Literal

Decision = Literal["keep", "drop"]

# Multi-step / wizard / screen navigation as Unit (presentation flow)
_WIZARD_RE = re.compile(
    r"(?i)("
    r"\bwizard\b|\bpopup\b|\bmodal\b|\bdialog\b|"
    r"\bform\b|\bdropdown\b|\btoast\b|"
    r"bước\s*\d+|\d+\s*bước|hai\s*bước|step\s*\d+|\d+\s*steps?|"
    r"chuyển\s*bước|quay\s*lại\s*bước|điều\s*hướng\s*bước|"
    r"chuyển\s*giai\s*đoạn|sang\s*giai\s*đoạn|hoàn\s*tất\s*giai\s*đoạn|"
    r"giai\s*đoạn\s+(thông\s*tin|tài\s*liệu|tiếp)|"
    r"màn\s*hình|\bpage\b|\bcomponent\b|\bscreen\b|"
    r"theo\s+\d+\s*bước|quy\s*trình\s+[^\n]{0,40}\d+\s*bước|"
    r"checkmark|tick\s*display|green\s*check|"
    r"hiển\s*thị\s*(dấu\s*)?(tick|check)|bố\s*cục|layout"
    r")"
)

# Interaction verbs (presentation layer)
_UI_VERB_RE = re.compile(
    r"(?i)\b("
    r"click|điền|nhập\s+vào\s+ô|fill\b|navigate|toast|"
    r"kéo\s*thả|drag[\s-]?drop|mở\s+popup|đóng\s+popup|"
    r"chọn\s+dropdown|bấm\s+nút"
    r")\b"
)

# Soft UI narrative without backend outcome (still looks like E2E)
_SOFT_UI_RE = re.compile(
    r"(?i)("
    r"người\s*dùng\s+(nhấn|bấm|click|chọn|điền|mở|xem|kéo)|"
    r"\b(nhấn|bấm)\s+(nút|button|link)|"
    r"hiển\s*thị\s+(danh\s*sách|form|màn|popup|toast|dialog|nút|button)|"
    r"xem\s+chi\s*tiết|"
    r"mở\s+(màn\s*hình|form|trang)|"
    r"điền\s+(form|thông\s*tin\s*trên)|"
    r"chọn\s+từ\s+(dropdown|danh\s*sách)"
    r")"
)

_BE_OUTCOME_RE = re.compile(
    r"(?i)("
    r"từ\s*chối|reject|validate|validation|persist|"
    r"lưu\s*(thành\s*công|bản\s*ghi|entity)|"
    r"authz|không\s*cho\s*phép|bắt\s*buộc|unique|trùng|"
    r"exception|handler|query|filter\s*(theo|dữ\s*liệu)|"
    r"cập\s*nhật\s*trạng\s*thái|state\s*transition|"
    r"primaryBucket|behaviorId|target\.(field|constraint)"
    r")"
)

# Enable/disable control (presentation state)
_UI_ENABLE_RE = re.compile(
    r"(?i)("
    r"\benable\b|\bdisable\b|"
    r"chỉ\s+enable|mặc\s+định\s+disable|"
    r"trạng\s*thái\s+enable|"
    r"dropdown\s+(enable|disable)"
    r")"
)

# Invented HTTP / MaxLength without source grounding signal
_INVENT_HTTP_RE = re.compile(
    r"(?i)\b(HTTP\s*[:=]?\s*)?(status\s*)?(code\s*)?(400|401|403|404|409|422|500)\b|"
    r"\bMaxLength\s*\(\s*\d+\s*\)|\bStringLength\s*\(\s*\d+"
)

# Exempt invent-HTTP/MaxLength(digits) only with retrieval/hint grounding — not mere IR markers
# (trace/behaviorId/primaryBucket alone = SRS IR; vẫn cấm invent HTTP status / MaxLength(n)).
_SOURCE_SIGNAL_RE = re.compile(
    r"(?i)\blayerHint\s*:|\bsourceSignal\s*:|\bpath\s*:|\bcode\s*:"
)

_TRACE_FEATURES_RE = re.compile(r"(?i)\btrace\s*:\s*FEATURES\b")
_TRACE_PRIMARY_RE = re.compile(
    r"(?i)\btrace\s*:\s*(BUSINESS_RULES|VALIDATION_DATA|ERROR_HANDLING|ACCEPTANCE)\b"
)
_PRIMARY_BUCKET_RE = re.compile(r"(?i)\bprimaryBucket\s*:")
_IR_MARKER_RE = re.compile(
    r"(?i)\b(behaviorId\s*:|target\.(field|constraint)\s*:)"
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
    """Fail-closed for clear presentation/interaction Unit drafts."""
    # Never keep E2E/UI engine labels as Unit (do not coerce UI → Unit).
    typ = str(type or "").strip().upper()
    if typ in ("E2E", "E2E_UI", "UI"):
        return UnitTcGuardResult("drop", "FAIL_E2E_TYPE")

    text = _blob(title, module, steps, expected_result, test_data)
    td = test_data or ""

    if _TRACE_FEATURES_RE.search(td):
        return UnitTcGuardResult("drop", "FAIL_FEATURES_ONLY")
    # IR-shaped drafts must carry primaryBucket (or recoverable PRIMARY trace)
    if _IR_MARKER_RE.search(td) and not (
        _PRIMARY_BUCKET_RE.search(td) or _TRACE_PRIMARY_RE.search(td)
    ):
        return UnitTcGuardResult("drop", "FAIL_NO_PRIMARY_BUCKET")
    # FEATURES-only without any PRIMARY marker
    if (
        re.search(r"(?i)\btrace\s*:", td)
        and not _TRACE_PRIMARY_RE.search(td)
        and not _PRIMARY_BUCKET_RE.search(td)
        and re.search(r"(?i)\bFEATURES\b", td)
    ):
        return UnitTcGuardResult("drop", "FAIL_FEATURES_ONLY")

    if _WIZARD_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_WIZARD")
    if _UI_VERB_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_VERBS")
    if _UI_ENABLE_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_UI_ENABLE")
    if _SOFT_UI_RE.search(text) and not _BE_OUTCOME_RE.search(text):
        return UnitTcGuardResult("drop", "FAIL_SOFT_UI")
    # Invented HTTP/MaxLength without path/layerHint/sourceSignal grounding
    if _INVENT_HTTP_RE.search(text) and not _SOURCE_SIGNAL_RE.search(td):
        return UnitTcGuardResult("drop", "FAIL_NO_SOURCE_SIGNAL")
    return UnitTcGuardResult("keep")


def apply_unit_tc_readiness_to_draft(draft: Any) -> bool:
    """
    Downgrade automation_ready when flat test_data markers fail readiness.
    Returns True when draft was downgraded.
    """
    from app.services.unit_tc_ir_ready import decide_unit_tc_markers_ready

    test_data = getattr(draft, "test_data", None) or (
        draft.get("test_data") if isinstance(draft, dict) else None
    )
    if test_data is None and isinstance(draft, dict):
        test_data = draft.get("testData")
    steps = getattr(draft, "steps", None) or (
        draft.get("steps") if isinstance(draft, dict) else None
    )
    expected = getattr(draft, "expected_result", None) or (
        draft.get("expected_result") if isinstance(draft, dict) else None
    )
    if expected is None and isinstance(draft, dict):
        expected = draft.get("expectedResult")

    ready, reasons = decide_unit_tc_markers_ready(
        test_data=test_data,
        steps=steps,
        expected_result=expected,
    )
    if ready:
        return False

    if isinstance(draft, dict):
        draft["automation_ready"] = False
        draft["automationReady"] = False
        td = str(draft.get("test_data") or draft.get("testData") or "")
        if "status: NOT_READY" not in td:
            draft["test_data"] = f"{td}\nstatus: NOT_READY".strip()
            draft["testData"] = draft["test_data"]
    else:
        draft.automation_ready = False
        td = str(getattr(draft, "test_data", None) or "")
        if "status: NOT_READY" not in td:
            draft.test_data = f"{td}\nstatus: NOT_READY".strip()
    return True


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
    downgraded = 0
    for d in drafts:
        title = getattr(d, "title", None) or (d.get("title") if isinstance(d, dict) else None)
        module = getattr(d, "module", None) or (d.get("module") if isinstance(d, dict) else None)
        steps = getattr(d, "steps", None) or (d.get("steps") if isinstance(d, dict) else None)
        expected = getattr(d, "expected_result", None) or (
            d.get("expected_result") if isinstance(d, dict) else None
        )
        if expected is None and isinstance(d, dict):
            expected = d.get("expectedResult")
        test_data = getattr(d, "test_data", None) or (
            d.get("test_data") if isinstance(d, dict) else None
        )
        if test_data is None and isinstance(d, dict):
            test_data = d.get("testData")
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
        if apply_unit_tc_readiness_to_draft(d):
            downgraded += 1
        kept.append(d)
    return kept, dropped, sanitized
