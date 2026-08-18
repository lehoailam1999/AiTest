"""
Auto-enrich E2E TC before Approve — fill path/auth/scenario from TC text (no index.db).

Portable: infer from module/title/precondition/steps only; never invent product routes.
Strips [MISSING CONTEXT] / [Thiếu Context] when resolvable gaps are filled.
"""

from __future__ import annotations

import re

from app.models.domain import TestCase

_PATH_MARKER_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:path|featurePath|feature_path|route)\s*[:=]\s*([^\n]+)"
)
_URL_MARKER_RE = re.compile(
    r"(?im)(?:^|\n)\s*(?:url|baseURL|base_url|targetUrl)\s*[:=]\s*([^\n]+)"
)
_KV_RE = re.compile(r"(?im)^\s*([A-Za-z_][\w]*)\s*[:=]\s*(.+)$")
_MISSING_CTX_LINE_RE = re.compile(
    r"\[(?:MISSING CONTEXT|Thiếu Context)\]", re.I
)
_LOGIN_PUBLIC_RE = re.compile(
    r"logout|đăng\s*xuất|public|guest|anonymous|without auth|no auth|"
    r"không\s*cần\s*đăng\s*nhập",
    re.I,
)
_LOGIN_TITLE_RE = re.compile(
    r"^(?:[A-Za-z0-9_-]+\s*-\s*)?(?:đăng\s*nhập|login|log\s*in|sign\s*in)\s*$",
    re.I,
)
_POST_LOGIN_RE = re.compile(
    r"đã\s*đăng\s*nhập|authenticated|logged\s*in",
    re.I,
)


def _is_login_or_public(tc: TestCase) -> bool:
    """True for login/public TC — not for post-login ('đã đăng nhập') feature TCs."""
    title = (tc.title or "").strip()
    if _LOGIN_TITLE_RE.match(title):
        return True
    if _POST_LOGIN_RE.search(_blob(tc)):
        return False
    return bool(_LOGIN_PUBLIC_RE.search(_blob(tc)))

_ROLE_KV_RE = re.compile(
    r"(?i)(?:authRole|auth_role)\s*[:=]\s*([A-Za-z0-9_-]+)"
)
_ROLE_COLON_RE = re.compile(r"(?i)\brole\s*[:=]\s*([A-Za-z0-9_-]+)")
_ROLE_LOGGED_AS_RE = re.compile(
    r"(?i)(?:logged\s+in\s+as|với\s+quyền|as\s+user)\s+([A-Za-z0-9_-]+)"
)
_ROLE_RE = re.compile(
    r"(?i)(?:authRole|auth_role|role|actor|vai\s*trò|quyền)\s*[:=]?\s*([A-Za-z0-9_-]+)|"
    r"(?:với\s+quyền|logged\s+in\s+as)\s+([A-Za-z0-9_-]+)"
)
_RULE_REF_RE = re.compile(r"\b((?:BR|FR|AC|REQ|UC)-[\w-]+)\b", re.I)
_INLINE_ROUTE_RE = re.compile(
    r"(?:^|\s)(/(?:[A-Za-z][A-Za-z0-9_-]*/)*[A-Za-z][A-Za-z0-9_-]*)(?:\s|$|[,;.]|\n)"
)
_STD_ACTION_RE = re.compile(
    r"^\s*(?:\d+[\).\-\s]*)?"
    r"(NAVIGATE|INPUT|SELECT|CHECK|CLICK|SUBMIT|WAIT|ASSERT)\b",
    re.I,
)
_VAGUE_STEP_RE = re.compile(
    r"^\s*(?:\d+[\).\-\s]*)?(?:thực\s*hiện\s*thao\s*tác|tiếp\s*tục|"
    r"kiểm\s*tra|nhập\s*thông\s*tin\s*cần\s*thiết)\s*$",
    re.I,
)
_AUTO_TAG = "# auto-enriched (E2E approve)"


def _blob(tc: TestCase) -> str:
    return "\n".join(
        filter(
            None,
            [
                tc.precondition or "",
                tc.test_data or "",
                tc.steps or "",
                tc.expected_result or "",
                tc.title or "",
                tc.module or "",
            ],
        )
    )


def _coerce_to_pathname(raw: str) -> str:
    p = (raw or "").strip().strip("\"'")
    if not p:
        return ""
    if re.match(r"^https?://", p, re.I):
        try:
            from urllib.parse import urlparse

            p = urlparse(p).path or ""
        except Exception:
            return ""
    return p


def is_usable_feature_path(raw: str | None) -> bool:
    p = _coerce_to_pathname(raw or "")
    p = re.sub(r"\s*[\[(#].*$", "", p).strip()
    if not p or p == "/":
        return False
    low = p.lower().replace("\\", "/")
    if re.search(
        r"thi[eế]u\s*context|missing\s*context|\[thi[eế]u|todo|tbd|n/a|null|undefined",
        low,
        re.I,
    ):
        return False
    if re.search(r"[\[\]{}]|featurepath\s*$", low, re.I):
        return False
    # Traceability ids from Analysis (`trace: BR/BR-4`, `ruleRef: BR-4`) are ASCII
    # and would otherwise pass as a route.
    if re.match(r"^/?(?:br|fr|ac|req)-\d[\w-]*$", low):
        return False
    if re.match(r"^/?(login|signin|sign-in|auth|register)$", low):
        return False
    # ASCII path segments only — (?a:\w) / explicit class rejects VN slug invent
    return bool(re.match(r"^/?[A-Za-z][A-Za-z0-9_\-./]*$", p.replace(" ", "")))


def normalize_feature_path(raw: str | None) -> str | None:
    p = _coerce_to_pathname(raw or "")
    p = re.sub(r"\s*[\[(#].*$", "", p).strip()
    if not p:
        return None
    if not p.startswith("/"):
        p = f"/{p}"
    p = re.sub(r"/{2,}", "/", p)
    if len(p) > 1 and p.endswith("/"):
        p = p[:-1]
    return p if is_usable_feature_path(p) else None


def _slug_path_segment(raw: str) -> str:
    s = (raw or "").strip().lower()
    s = re.sub(r"[\\/:*?\"<>|]+", "-", s)
    s = re.sub(r"\s+", "-", s)
    s = re.sub(r"-+", "-", s).strip("-")
    return s


def infer_e2e_route_path(tc: TestCase) -> str | None:
    """Usable AbsolutePath only — never invent /{module-slug} or treat baseURL as path."""
    blob = _blob(tc)
    m = _PATH_MARKER_RE.search(blob)
    if m:
        n = normalize_feature_path(m.group(1))
        if n:
            return n
    u = _URL_MARKER_RE.search(blob)
    if u:
        n = normalize_feature_path(u.group(1))
        if n:
            return n
    route = _INLINE_ROUTE_RE.search(blob)
    if route:
        n = normalize_feature_path(route.group(1))
        if n:
            return n
    return None


def infer_scenario_type(tc: TestCase) -> str | None:
    blob = _blob(tc)
    if re.search(r"scenarioType\s*[:=]", blob, re.I):
        return None
    low = blob.lower()
    if re.search(r"phủ\s*định|negative|từ\s*chối|invalid|reject|error\s*flow|lỗi", low):
        return "Negative"
    if re.search(r"biên|boundary|\bmax\b|\bmin\b|limit|giới\s*hạn", low):
        return "Boundary"
    if re.search(r"validation|validate|định\s*dạng|format|required|bắt\s*buộc", low):
        return "Validation"
    if re.search(r"exception|ngoại\s*lệ|timeout|500|crash", low):
        return "Exception"
    if re.search(r"positive|happy|thành\s*công|success", low):
        return "Positive"
    tc_type = (tc.type or "").strip().lower()
    if tc_type in {"phủ định", "negative"}:
        return "Negative"
    if tc_type in {"biên", "boundary"}:
        return "Boundary"
    return "Positive"


def _clean_role_slug(raw: str | None) -> str | None:
    role = (raw or "").strip()
    if not role or re.search(r"thi[eế]u|tbd|n/a", role, re.I):
        return None
    if role.lower() in {"role", "actor", "user", "auth"}:
        return None
    return role


def infer_auth_role(tc: TestCase) -> str | None:
    blob = _blob(tc)
    for pat in (_ROLE_KV_RE, _ROLE_COLON_RE, _ROLE_LOGGED_AS_RE):
        m = pat.search(blob)
        if m:
            role = _clean_role_slug(m.group(1))
            if role:
                return role
    for m in _ROLE_RE.finditer(blob):
        role = _clean_role_slug(m.group(1) or m.group(2))
        if role:
            return role
    return None


def infer_rule_ref(tc: TestCase) -> str | None:
    m = _RULE_REF_RE.search(_blob(tc))
    return m.group(1).upper() if m else None


def _is_placeholder_value(raw: str | None) -> bool:
    return bool(raw and _MISSING_CTX_LINE_RE.search(raw))


def _has_kv(test_data: str, key: str) -> bool:
    """True only when key exists with a real (non-placeholder) value."""
    for m in _KV_RE.finditer(test_data or ""):
        if m.group(1).strip().lower() != key.lower():
            continue
        if _is_placeholder_value(m.group(2)):
            continue
        return True
    return False


def strip_unusable_path_markers(text: str) -> str:
    if not text:
        return ""
    kept: list[str] = []
    for ln in text.splitlines():
        m = re.match(
            r"^\s*(path|featurePath|feature_path|route|url)\s*[:=]\s*(.+)$",
            ln.strip(),
            re.I,
        )
        if m and not normalize_feature_path(m.group(2)):
            continue
        if ln.strip():
            kept.append(ln)
    return "\n".join(kept).strip()


def _append_kv_lines(test_data: str, pairs: list[tuple[str, str]]) -> str:
    # Drop unusable / placeholder path KVs only — keep DoR [Thiếu Context] notes
    # until enrich confirms a usable path.
    td = strip_unusable_path_markers(test_data or "")
    # Also drop path/auth KVs whose value is still a placeholder token
    cleaned_lines: list[str] = []
    for ln in (td or "").splitlines():
        m = _KV_RE.match(ln.strip())
        if m and _is_placeholder_value(m.group(2)):
            continue
        if ln.strip():
            cleaned_lines.append(ln)
    td = "\n".join(cleaned_lines).strip()
    lines: list[str] = []
    for key, value in pairs:
        if not value or _has_kv(td + "\n" + "\n".join(lines), key):
            continue
        lines.append(f"{key}: {value}")
    if not lines:
        return td
    block = "\n".join(lines)
    if _AUTO_TAG not in td:
        block = f"{block}\n{_AUTO_TAG}"
    return f"{td}\n{block}".strip() if td else block


def strip_missing_context_markers(text: str) -> str:
    """
    Remove DoR soft-flags and unusable placeholder KV values.
    Examples dropped:
      - `[Thiếu Context] thiếu path...`
      - `path: [Thiếu Context]`
      - `featurePath: [MISSING CONTEXT]`
    """
    if not text:
        return ""
    kept: list[str] = []
    for ln in text.splitlines():
        if not ln.strip():
            continue
        # Whole-line DoR note
        if re.match(
            r"^\s*\[(?:MISSING CONTEXT|Thiếu Context)\]",
            ln,
            re.I,
        ):
            continue
        m = _KV_RE.match(ln.strip())
        if m and _is_placeholder_value(m.group(2)):
            continue
        # Inline remnant: strip the bracket token, keep rest if useful
        cleaned = _MISSING_CTX_LINE_RE.sub("", ln).rstrip()
        if cleaned.strip():
            kept.append(cleaned)
    return "\n".join(kept).strip()


def _infer_postcondition(tc: TestCase) -> str | None:
    blob = _blob(tc)
    if re.search(r"postcondition\s*[:=]", blob, re.I):
        return None
    expected = (tc.expected_result or "").strip()
    low = expected.lower()
    if re.search(r"không\s*(tạo|cập\s*nhật|xóa)|no\s+(new|update|delete)", low):
        return "Không tạo/cập nhật dữ liệu mới"
    if expected:
        short = expected[:120].strip()
        return f"Sau test: {short}"
    return None


def _extract_target_from_line(line: str) -> str:
    m = re.search(
        r"(?:nút|button|btn|ô|field|input|dropdown|menu|tab|link|màn\s*hình|trang)\s+(.+?)$",
        line,
        re.I,
    )
    if m:
        return m.group(1).strip().strip("\"'")
    m2 = re.search(r"(?:target|đối\s*tượng)\s*[:=]\s*([^→\n]+)", line, re.I)
    if m2:
        return m2.group(1).strip()
    return "UI element"


def _extract_value_from_line(line: str) -> str | None:
    m = re.search(
        r"(?:value|giá\s*trị)\s*[:=]\s*([^\n→]+)|"
        r"(?:nhập|điền|fill|enter)\s+(.+?)(?:\s+vào|\s*$)",
        line,
        re.I,
    )
    if not m:
        return None
    val = (m.group(1) or m.group(2) or "").strip().strip("\"'")
    return val or None


def normalize_e2e_steps(steps: str, expected: str = "") -> str:
    """Best-effort: Vietnamese/free-form → Action Target/Value/Expected."""
    raw_lines = [ln.strip() for ln in (steps or "").splitlines() if ln.strip()]
    if not raw_lines:
        return steps or ""
    if any(_STD_ACTION_RE.match(ln) for ln in raw_lines):
        return steps

    out: list[str] = []
    exp_fallback = (expected or "Kết quả khớp Expected Result").strip()
    for idx, raw in enumerate(raw_lines, start=1):
        if _VAGUE_STEP_RE.match(raw):
            out.append(raw)
            continue
        line = re.sub(r"^\d+[\).\-\s]*", "", raw).strip()
        low = line.lower()
        target = _extract_target_from_line(line)
        value = _extract_value_from_line(line)

        if re.search(r"^(?:mở|open|goto|navigate|truy\s*cập|vào)\b", low):
            norm = f"NAVIGATE Target: {target} Expected: Màn hình/route hiển thị"
        elif re.search(r"^(?:nhập|điền|fill|enter|type)\b", low):
            val = value or "theo testData"
            norm = f"INPUT Target: {target} Value: {val} Expected: Giá trị được điền"
        elif re.search(r"^(?:chọn|select)\b", low):
            val = value or "theo testData"
            norm = f"SELECT Target: {target} Value: {val} Expected: Lựa chọn được áp dụng"
        elif re.search(r"^(?:nhấn|bấm|click|chọn)\b", low):
            norm = f"CLICK Target: {target} Expected: Thao tác được thực hiện"
        elif re.search(r"^(?:lưu|save|submit|gửi)\b", low):
            norm = f"SUBMIT Target: {target} Expected: {exp_fallback}"
        elif re.search(r"^(?:kiểm\s*tra|verify|assert|xem|đảm\s*bảo)\b", low):
            norm = f"ASSERT Target: {target} Expected: {exp_fallback}"
        else:
            out.append(raw)
            continue
        out.append(f"{idx}. {norm}")
    return "\n".join(out) if out else steps


def enrich_e2e_tc_before_approve(
    tc: TestCase,
    *,
    project_default_role: str | None = None,
) -> bool:
    """Mutate E2E TC in place before Approve validation. Returns True if changed."""
    changed = False

    # Resolve path from original text BEFORE step normalize (normalize drops inline routes).
    login_or_public = _is_login_or_public(tc)
    path = None if login_or_public else infer_e2e_route_path(tc)

    # Steps: normalize free-form → standard actions when possible
    normalized_steps = normalize_e2e_steps(tc.steps or "", tc.expected_result or "")
    if normalized_steps != (tc.steps or ""):
        tc.steps = normalized_steps
        changed = True

    pairs: list[tuple[str, str]] = []
    if path:
        pairs.append(("path", path))

    if not login_or_public:
        role = infer_auth_role(tc)
        if not role and project_default_role:
            role = project_default_role.strip() or None
        if role:
            pairs.append(("authRole", role))
            pairs.append(("authRequired", "true"))
        elif _POST_LOGIN_RE.search(_blob(tc)) or not re.search(
            r"authRequired\s*[:=]\s*(false|no|0)", _blob(tc), re.I
        ):
            # Feature / post-login TC — never leave authoritative authRequired=false
            pairs.append(("authRequired", "true"))

    scenario = infer_scenario_type(tc)
    if scenario:
        pairs.append(("scenarioType", scenario))

    rule = infer_rule_ref(tc)
    if rule:
        pairs.append(("ruleRef", rule))
    elif (tc.module or "").strip() and not re.search(
        r"requirement\s*[:=]", _blob(tc), re.I
    ):
        pairs.append(("requirement", (tc.module or "").strip()))

    post = _infer_postcondition(tc)
    if post:
        pairs.append(("postcondition", post))

    next_td = _append_kv_lines(tc.test_data or "", pairs)
    if next_td != (tc.test_data or ""):
        tc.test_data = next_td
        changed = True

    # Strip DoR soft-flags only when path is usable (or login/public exempt).
    usable = bool(path) or login_or_public
    if usable:
        for attr in ("test_data", "precondition", "steps", "expected_result"):
            cur = getattr(tc, attr, None) or ""
            cleaned = strip_missing_context_markers(cur)
            if cleaned != cur:
                setattr(tc, attr, cleaned or None)
                changed = True

    return changed

