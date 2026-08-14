"""
Phase 2 — enforce Auth → Feature entry → Act on generated Playwright Specs.

Called from ``e2e_codegen_guard.apply_e2e_codegen_guards`` after auth/entry inject.
Missing phases or wrong order → ``E2ECodegenJourneyError`` (fail codegen).
"""

from __future__ import annotations

import json
import re

_FEATURE_ENTRY_STEP_RE = re.compile(
    r"test\.step\s*\(\s*['\"][^'\"]*(?:Feature entry|Vào chức năng|feature entry|mở màn)",
    re.IGNORECASE,
)
# Auth step titles — NEVER match bare ``0.`` alone (renumber makes Feature entry ``0.`` too).
# Vietnamese «Đăng» uses U+0110 Đ — not ASCII D.
_AUTH_STEP_RE = re.compile(
    r"test\.step\s*\(\s*['\"][^'\"]*(?:[ĐđDd]ăng\s*nhập|[Xx]ác\s*thực|xac\s*thuc|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)",
    re.IGNORECASE,
)
_TEST_STEP_TITLE_RE = re.compile(
    r"test\.step\s*\(\s*['\"]([^'\"]+)['\"]",
    re.IGNORECASE,
)
_ACT_SIGNAL_RE = re.compile(
    r"(?:\.fill\s*\(|\.click\s*\(|\.selectOption\s*\(|\.check\s*\(|\.setInputFiles\s*\(|"
    r"await\s+expect\s*\(|\.toBeVisible\s*\(|\.toHaveText\s*\(|\.toBeDisabled\s*\(|"
    # POM / helper actions — exclude bare page.goto / page.locator (Feature entry)
    r"await\s+(?!page\b)[A-Za-z_]\w*\.[A-Za-z_]\w*\s*\()",
    re.IGNORECASE,
)
_META_STEP_TITLE_RE = re.compile(
    r"(?:Feature entry|Vào chức năng|mở màn)|"
    r"(?:^\d+\.\s*)(?:[ĐđDd]ăng\s*nhập|[Xx]ác\s*thực|xac\s*thuc|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)|"
    r"(?:^|\s)(?:0\.\s*)?(?:[ĐđDd]ăng\s*nhập|[Xx]ác\s*thực|xac\s*thuc|[Ll]ogin|[Aa]uthenticat)\b",
    re.IGNORECASE,
)
_GOTO_FEATURE_RE = re.compile(r"\b(?:gotoFeature|openFeature)\s*\(", re.IGNORECASE)
_PAGE_GOTO_RE = re.compile(r"\bpage\.goto\s*\(", re.IGNORECASE)


def _code_without_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text or "", flags=re.DOTALL)
    return re.sub(r"//.*?$", " ", text, flags=re.MULTILINE)


def spec_has_feature_entry(content: str) -> bool:
    text = _code_without_comments(content)
    if _FEATURE_ENTRY_STEP_RE.search(text):
        return True
    if _GOTO_FEATURE_RE.search(text):
        return True
    # Fallback for legacy specs: direct page.goto(...) still counts as feature entry.
    if _PAGE_GOTO_RE.search(text):
        return True
    if re.search(r"E2E_FEATURE_PATH", text) and re.search(r"page\.goto\s*\(", text):
        return True
    return False


def spec_has_auth_phase(content: str, *, mode: str) -> bool:
    if mode in ("storage", "public", "none"):
        return True
    text = _code_without_comments(content)
    return bool(
        re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", text)
        or _AUTH_STEP_RE.search(text)
    )


def spec_has_act_phase(content: str) -> bool:
    text = _code_without_comments(content)
    for m in _TEST_STEP_TITLE_RE.finditer(text):
        if _META_STEP_TITLE_RE.search(m.group(1)):
            continue
        return True
    entry = _FEATURE_ENTRY_STEP_RE.search(text)
    body = text[entry.end() :] if entry else text
    body = re.sub(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", " ", body)
    body = _GOTO_FEATURE_RE.sub(" ", body)
    return bool(_ACT_SIGNAL_RE.search(body))


def _iter_test_step_spans(text: str) -> list[tuple[int, int, str]]:
    """Return (start, end, title) for each test.step — end is next step or EOF."""
    matches = list(_TEST_STEP_TITLE_RE.finditer(text))
    spans: list[tuple[int, int, str]] = []
    for i, m in enumerate(matches):
        start = m.start()
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        spans.append((start, end, m.group(1)))
    return spans


def _phase_positions(content: str, *, mode: str) -> dict[str, int | None]:
    text = _code_without_comments(content)
    auth_call_m = re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", text)
    auth_step_m = _AUTH_STEP_RE.search(text)
    auth_pos_candidates = [
        m.start()
        for m in (auth_call_m, auth_step_m)
        if m is not None
    ]
    auth_pos = min(auth_pos_candidates) if auth_pos_candidates else None
    # Brace-safe top-level step detection (prevents false order on nested test.step).
    entry_span = _find_feature_entry_step_span(text)
    entry_pos: int | None = entry_span.start() if entry_span is not None else None

    act_span = _first_act_step_span(text)
    act_pos: int | None = act_span.start() if act_span is not None else None

    # If first non-meta step is the detected feature-entry, skip to the next real Act.
    if act_span is not None and entry_span is not None and act_span.start() == entry_span.start():
        for span in _top_level_step_spans(text):
            if span.start() <= entry_span.start():
                continue
            title = span.title
            body = span.group(0)
            if _is_auth_step_title(title) or _is_feature_entry_step_title(title):
                continue
            if _META_STEP_TITLE_RE.search(title):
                continue
            if _GOTO_FEATURE_RE.search(body) and not re.search(
                r"\.fill\s*\(|\.click\s*\(|\.setInputFiles\s*\(|await\s+expect\s*\(",
                body,
            ):
                continue
            act_pos = span.start()
            break

    if act_pos is None:
        search_from = (entry_pos + 1) if entry_pos is not None else (
            (auth_call_m.end() if auth_call_m is not None else 0)
        )
        while True:
            act_m = _ACT_SIGNAL_RE.search(text, search_from)
            if not act_m:
                break
            frag = text[max(0, act_m.start() - 32) : act_m.end() + 8]
            if re.search(
                r"ensureAuthenticated|gotoFeature|openFeature", frag, re.IGNORECASE
            ):
                search_from = act_m.end()
                continue
            act_pos = act_m.start()
            break
    return {
        "auth": 0 if mode in ("storage", "public") else auth_pos,
        "entry": entry_pos,
        "act": act_pos,
    }


def validate_feature_journey_order(
    content: str,
    *,
    mode: str,
    is_login_tc: bool = False,
    enforce_business_assertions: bool = False,
) -> list[str]:
    """Return violation messages (empty = OK)."""
    errors: list[str] = []
    titles_hint = _step_titles_hint(content)
    if is_login_tc or mode == "none":
        text = _code_without_comments(content)
        # Guard unit fixtures sometimes use empty login.spec stubs (no page).
        if not re.search(r"\bpage\b", text):
            return errors
        if not (
            spec_has_act_phase(content)
            or re.search(
                r"\.fill\s*\(|\.click\s*\(|getByLabel|getByRole|getByPlaceholder|"
                r"ensureAuthenticated|type\s*=\s*['\"]password['\"]",
                text,
            )
        ):
            errors.append("Login TC missing Act (fill/click/assert)" + titles_hint)
        return errors

    if not spec_has_auth_phase(content, mode=mode):
        errors.append("missing Auth (ensureAuthenticated step 0)" + titles_hint)
    if not spec_has_feature_entry(content):
        errors.append("missing Feature entry (after Auth, before Act)" + titles_hint)
    if not spec_has_act_phase(content):
        errors.append(
            "missing Act (test.step / fill / click / expect after Feature entry)"
            + titles_hint
        )

    if errors:
        return errors

    pos = _phase_positions(content, mode=mode)
    auth_i, entry_i, act_i = pos["auth"], pos["entry"], pos["act"]
    if auth_i is not None and entry_i is not None and auth_i > entry_i:
        errors.append("order: Auth must come before Feature entry" + titles_hint)
    if entry_i is not None and act_i is not None and entry_i > act_i:
        errors.append("order: Feature entry must come before Act" + titles_hint)
    if auth_i is not None and act_i is not None and auth_i > act_i and mode == "ui_helper":
        errors.append("order: Auth must come before Act" + titles_hint)
    if enforce_business_assertions and not errors:
        weak_asserts = _missing_business_assertions(content)
        if weak_asserts:
            errors.append(
                "BusinessAssertionFailed: missing assert in Act steps "
                + ", ".join(weak_asserts[:3])
            )
    return errors


def _step_titles_hint(content: str, limit: int = 3) -> str:
    """S4.3 — append first N top-level step titles for debug."""
    titles: list[str] = []
    for span in _top_level_step_spans(content or ""):
        title = (span.title or "").strip()
        if title:
            titles.append(title)
        if len(titles) >= limit:
            break
    if not titles:
        # Fallback: title-only regex (may include nested)
        for m in _TEST_STEP_TITLE_RE.finditer(_code_without_comments(content or "")):
            titles.append(m.group(1).strip())
            if len(titles) >= limit:
                break
    if not titles:
        return ""
    quoted = ", ".join(json.dumps(t, ensure_ascii=False) for t in titles)
    return f" (steps: {quoted})"


_ASSERT_SIGNAL_RE = re.compile(
    r"await\s+expect\s*\(|"
    r"\btoHave(?:Text|Count|Value|URL)\s*\(|"
    r"\btoBe(?:Visible|Hidden|Disabled|Enabled|Checked)\s*\(|"
    # POM/helper business asserts: await pom.expectX(...) / await pageObj.assertY(...)
    r"await\s+(?!page\b)[A-Za-z_]\w*\.(?:expect|assert)[A-Za-z_]\w*\s*\(",
    re.IGNORECASE,
)

# R6 — generic shell / auto-heal must NOT count as business proof
_FAKE_ASSERT_BLOCK_RE = re.compile(
    r"(?://"
    r"[^\n]*Business assertion \(auto-healed[^\n]*\n)?"
    r"\s*await\s+expect\s*\(\s*"
    r"page\.locator\(\s*['\"]main,\s*\[role=[\"']main[\"']\].*?['\"]\s*\)"
    r"[\s\S]*?\)\.toBeVisible\(\s*\{[^}]*\}\s*\)\s*;",
    re.IGNORECASE,
)
_FAKE_HEAL_COMMENT_RE = re.compile(
    r"[ \t]*//[^\n]*Business assertion \(auto-healed[^\n]*\n?",
    re.IGNORECASE,
)
# getByText(RegExp) built from featurePath / auth metadata (not BR)
_FAKE_METADATA_TEXT_ASSERT_RE = re.compile(
    r"await\s+expect\s*\(\s*page\.getByText\s*\(\s*new\s+RegExp\s*\(\s*"
    r"(?:['\"]featurePath|['\"]authRole|['\"]path\\\\|['\"]admin\\\\)",
    re.IGNORECASE,
)

# Title capture only — body extracted with brace counting (objects in steps break .*?).
_TEST_STEP_HEAD_RE = re.compile(
    r"await\s+test\.step\s*\(\s*['\"](?P<title>[^'\"]+)['\"]\s*,\s*"
    r"async\s*\(\s*\)\s*=>\s*\{",
    re.IGNORECASE,
)


def _extract_balanced_block(text: str, open_brace_idx: int) -> tuple[str, int] | None:
    """Return (inner_body, end_exclusive) for `{...}` starting at open_brace_idx."""
    if open_brace_idx < 0 or open_brace_idx >= len(text) or text[open_brace_idx] != "{":
        return None
    depth = 0
    i = open_brace_idx
    in_squote = False
    in_dquote = False
    in_template = False
    escape = False
    while i < len(text):
        ch = text[i]
        if escape:
            escape = False
            i += 1
            continue
        if ch == "\\" and (in_squote or in_dquote or in_template):
            escape = True
            i += 1
            continue
        if not in_dquote and not in_template and ch == "'":
            in_squote = not in_squote
        elif not in_squote and not in_template and ch == '"':
            in_dquote = not in_dquote
        elif not in_squote and not in_dquote and ch == "`":
            in_template = not in_template
        elif not in_squote and not in_dquote and not in_template:
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    return text[open_brace_idx + 1 : i], i + 1
        i += 1
    return None


class _BlockSpan:
    __slots__ = ("_s", "_e", "_text", "title")

    def __init__(self, s: int, e: int, text: str, title: str = "") -> None:
        self._s = s
        self._e = e
        self._text = text
        self.title = title or ""

    def start(self) -> int:
        return self._s

    def end(self) -> int:
        return self._e

    def group(self, _n: int = 0) -> str:
        return self._text[self._s : self._e]


def _step_span_from_head(text: str, m: re.Match[str]) -> _BlockSpan | None:
    title = ""
    if "title" in (m.re.groupindex or {}):
        title = m.group("title") or ""
    elif m.group(0):
        tm = re.search(r"['\"]([^'\"]+)['\"]", m.group(0))
        title = tm.group(1) if tm else ""
    open_idx = m.end() - 1
    extracted = _extract_balanced_block(text, open_idx)
    if extracted is None:
        return None
    _body, body_end = extracted
    close_end = body_end
    trail = re.match(r"\s*\)\s*;", text[body_end:])
    if trail:
        close_end = body_end + trail.end()
    start = m.start()
    if start > 0 and text[start - 1] == "\n":
        start -= 1
    return _BlockSpan(start, close_end, text, title=title or "")


def _iter_balanced_step_spans(text: str) -> list[_BlockSpan]:
    spans: list[_BlockSpan] = []
    for m in _TEST_STEP_HEAD_RE.finditer(text or ""):
        span = _step_span_from_head(text, m)
        if span is not None:
            spans.append(span)
    return spans


def _top_level_step_spans(text: str) -> list[_BlockSpan]:
    """Top-level await test.step blocks (excludes nested steps inside another step)."""
    all_spans = _iter_balanced_step_spans(text or "")
    top: list[_BlockSpan] = []
    for s in all_spans:
        nested = any(
            o.start() < s.start() and s.end() <= o.end() for o in all_spans if o is not s
        )
        if not nested:
            top.append(s)
    return top


def _is_auth_step_title(title: str) -> bool:
    return bool(
        re.search(
            r"(?:[ĐđDd]ăng\s*nhập|[Xx]ác\s*thực|xac\s*thuc|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)",
            title or "",
            re.IGNORECASE,
        )
    )


def _is_feature_entry_step_title(title: str) -> bool:
    return bool(
        re.search(
            r"(?:Feature\s*entry|Vào\s*chức\s*năng|feature\s*entry|mở\s*màn)",
            title or "",
            re.IGNORECASE,
        )
    )


_FEATURE_ENTRY_STEP_HEAD_RE = re.compile(
    r"await\s+test\.step\s*\(\s*['\"][^'\"]*"
    r"(?:Feature\s*entry|Vào\s*chức\s*năng|feature\s*entry|mở\s*màn)"
    r"[^'\"]*['\"]\s*,\s*async\s*\(\s*\)\s*=>\s*\{",
    re.IGNORECASE,
)


def _find_auth_step_span(text: str) -> _BlockSpan | None:
    for span in _top_level_step_spans(text):
        body = span.group(0)
        if _is_auth_step_title(span.title) or re.search(
            r"ensureAuthenticated\s*\(\s*page\s*\)", body
        ):
            return span
    return None


def _find_feature_entry_step_span(text: str) -> _BlockSpan | None:
    m = _FEATURE_ENTRY_STEP_HEAD_RE.search(text or "")
    if m:
        span = _step_span_from_head(text, m)
        if span is not None:
            return span
    # Fallback: top-level step whose title matches or body is nav-only gotoFeature
    for span in _top_level_step_spans(text):
        if _is_feature_entry_step_title(span.title):
            return span
        body = span.group(0)
        if _GOTO_FEATURE_RE.search(body) and not re.search(
            r"\.fill\s*\(|\.click\s*\(|\.setInputFiles\s*\(|await\s+expect\s*\(",
            body,
        ):
            return span
    return None


def _first_act_step_span(text: str) -> _BlockSpan | None:
    for span in _top_level_step_spans(text):
        if _is_auth_step_title(span.title) or _is_feature_entry_step_title(span.title):
            continue
        if _META_STEP_TITLE_RE.search(span.title):
            continue
        return span
    return None


def _cut_span(text: str, span: _BlockSpan) -> str:
    return text[: span.start()] + text[span.end() :]


def reorder_feature_entry_after_auth(spec_content: str) -> str:
    """Brace-safe: move Feature-entry test.step to immediately after Auth."""
    text = spec_content or ""
    entry = _find_feature_entry_step_span(text)
    auth = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if not entry or not auth:
        return text
    if entry.start() > auth.end():
        return text
    block = entry.group(0)
    without = _cut_span(text, entry)
    moved = _insert_after_auth(without, block)
    return moved if moved is not None else text


def reorder_feature_entry_before_act(spec_content: str) -> str:
    """Brace-safe: move Feature entry before the first Act test.step when misplaced."""
    text = spec_content or ""
    entry = _find_feature_entry_step_span(text)
    if not entry:
        return text
    first_act = _first_act_step_span(text)
    if not first_act:
        return text
    if entry.start() < first_act.start():
        return text
    block = entry.group(0)
    without = _cut_span(text, entry)
    act2 = _first_act_step_span(without)
    if not act2:
        return text
    return without[: act2.start()] + block + without[act2.start() :]


def _move_auth_step_before_feature_and_act(text: str) -> str:
    """S4.2 — Auth step after Act/Entry → move Auth to front of top-level steps."""
    auth_span = _find_auth_step_span(text)
    if not auth_span:
        return text
    tops = _top_level_step_spans(text)
    if not tops:
        return text
    first = tops[0]
    if auth_span.start() <= first.start():
        return text
    # Already first among meta? still move if any Act/Entry precedes Auth
    earlier = [s for s in tops if s.start() < auth_span.start()]
    if not earlier:
        return text
    block = auth_span.group(0)
    without = _cut_span(text, auth_span)
    tops2 = _top_level_step_spans(without)
    if not tops2:
        return text
    return without[: tops2[0].start()] + block + without[tops2[0].start() :]


def _step_has_action(block: str) -> bool:
    return bool(_ACT_SIGNAL_RE.search(block or ""))


def _strip_fake_asserts(block: str) -> str:
    """Remove R6-forbidden generic / auto-heal asserts so real BR signals remain."""
    text = block or ""
    text = _FAKE_ASSERT_BLOCK_RE.sub("", text)
    text = _FAKE_HEAL_COMMENT_RE.sub("", text)
    # Only drop getByText(RegExp) that clearly came from featurePath/auth metadata
    text = re.sub(
        r"[ \t]*await\s+expect\s*\(\s*page\.getByText\s*\(\s*new\s+RegExp\s*\(\s*"
        r"(?:[\"']featurePath|[\"']authRole|[\"']path\\\\|[\"']admin\\\\)[^;]*;"
        r"(?:\s*\n[ \t]*\.toBeVisible\([^;]*;)?",
        "",
        text,
        flags=re.IGNORECASE | re.DOTALL,
    )
    return text


def _step_has_assert(block: str) -> bool:
    """True only for non-fake business asserts (R6)."""
    cleaned = _strip_fake_asserts(block or "")
    return bool(_ASSERT_SIGNAL_RE.search(cleaned))


def _missing_business_assertions(content: str) -> list[str]:
    """
    Suite-level BR check (R6): at least one Act/Expected step must prove outcome.

    Intermediate fill/click steps may lack assert if a later step asserts —
    requiring every Act to assert was blocking Gen (HTTP 400) after fake-heal ban.
    """
    text = _code_without_comments(content)
    act_titles: list[str] = []
    any_real = False
    for span in _top_level_step_spans(text):
        title = span.title
        if _META_STEP_TITLE_RE.search(title) or _is_auth_step_title(title):
            continue
        if _is_feature_entry_step_title(title):
            continue
        block = span.group(0)
        if _step_has_assert(block):
            any_real = True
            continue
        if _step_has_action(block):
            act_titles.append(title.strip() or "(untitled)")
    if any_real:
        return []
    return act_titles


def list_fake_business_assertion_hits(content: str) -> list[str]:
    """
    Forbidden fake *business* asserts (R6).

    Feature-entry shell landmark via waitFor(main|nav|h1) is allowed —
    only ``await expect(...main...).toBeVisible`` / auto-heal / metadata text is banned.
    """
    text = content or ""
    hits: list[str] = []
    if _FAKE_HEAL_COMMENT_RE.search(text) or _FAKE_ASSERT_BLOCK_RE.search(text):
        hits.append("generic main|nav|h1 auto-heal assert")
    if _FAKE_METADATA_TEXT_ASSERT_RE.search(text) or re.search(
        r"getByText\s*\(\s*new\s+RegExp\s*\(\s*[\"']featurePath",
        text,
        re.I,
    ):
        hits.append("assert text from featurePath/metadata")
    return hits


def strip_fake_business_assertions(content: str) -> str:
    """Remove forbidden fake asserts; does not invent replacements (R6)."""
    return _strip_fake_asserts(content or "")


def _expected_text_hint(expected_hint: str) -> str:
    """Pick a short stable fragment from Expected outcome (tests / future real asserts)."""
    raw = (expected_hint or "").strip()
    if not raw:
        return ""
    skip_line = re.compile(
        r"(?i)^\s*(?:featurePath|path|route|url|authRole|auth_role|role|roles|"
        r"authRequired|landmark|multiRole|trace|storageState)\s*[:=]",
    )
    preferred: list[str] = []
    other: list[str] = []
    for ln in raw.splitlines():
        s = ln.strip()
        if not s or skip_line.search(s):
            continue
        cleaned = re.sub(
            r"(?i)^\s*(?:expected(?:\s*outcome)?|expectedOutcome|kỳ\s*vọng|assert)\s*[:=]\s*",
            "",
            s,
        ).strip()
        if len(cleaned) < 4:
            continue
        if re.search(r"(?i)^\s*(?:expected|expectedOutcome|kỳ\s*vọng|assert)\s*[:=]", s):
            preferred.append(cleaned)
        else:
            other.append(cleaned)
    for s in preferred + other:
        words = re.findall(r"[A-Za-zÀ-ỹ0-9]{3,}", s)
        if words:
            return " ".join(words[:6])[:80]
    return ""


_EARLY_NAV_LINE_RE = re.compile(
    r"^[ \t]*await\s+(?:"
    r"page\.goto\s*\([^;]*\)|"
    r"[A-Za-z_]\w*\.(?:gotoFeature|openFeature)\s*\([^;]*\)"
    r")\s*;?[ \t]*\n?",
    re.MULTILINE | re.IGNORECASE,
)


def _insert_after_auth(text: str, block: str) -> str | None:
    """Prefer end of Auth test.step; else right after ensureAuthenticated(page)."""
    auth_span = _find_auth_step_span(text)
    if auth_span is not None:
        piece = block if block.startswith("\n") else "\n" + block
        return text[: auth_span.end()] + piece + text[auth_span.end() :]
    auth = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if not auth:
        return None
    piece = block if block.startswith("\n") else "\n" + block
    return text[: auth.end()] + piece + text[auth.end() :]


def heal_feature_journey_order(content: str) -> str:
    """
    Repair Auth → Feature entry → Act so Phase-2 enforce can pass.

    S4: brace-safe nested steps; move Auth to front when after Act;
    Feature entry after Auth; Feature entry before Act; early page.goto after Auth.
    """
    text = content or ""
    if not re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text):
        return text

    # 0) Auth step after Act/Entry → move Auth first
    text = _move_auth_step_before_feature_and_act(text)

    # 1) Feature-entry test.step (EN/VI, nested-safe) after Auth
    text = reorder_feature_entry_after_auth(text)

    # 2) Feature entry before first Act when still misplaced
    text = reorder_feature_entry_before_act(text)

    # 3) Bare early navigations that still sit before Auth
    auth = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if not auth:
        return text
    early = list(_EARLY_NAV_LINE_RE.finditer(text[: auth.start()]))
    if early:
        chunks = "".join(m.group(0) for m in early)
        without = text
        for m in reversed(early):
            without = without[: m.start()] + without[m.end() :]
        moved = _insert_after_auth(without, chunks)
        if moved is not None:
            text = moved

    return text


def heal_missing_business_assertions(
    content: str,
    *,
    expected_hint: str = "",
) -> str:
    """
    R6 — strip fake landmark heals; optionally inject BR from expectedOutcome only.

    Never injects ``main|nav|h1`` shell asserts. If suite already has a real assert,
    only strip fakes. If missing BR and a usable expected hint exists, inject
    ``getByText(RegExp)`` into the last Act step (brace-safe).
    """
    text = strip_fake_business_assertions(content)
    if not _missing_business_assertions(text):
        return text

    hint = _expected_text_hint(expected_hint)
    if not hint or len(hint) < 4:
        return text
    # Refuse metadata-looking hints
    if re.search(r"(?i)featurePath|authRole|^admin\b|^path\b", hint):
        return text

    hint_re = re.escape(hint)
    hint_re_js = json.dumps(hint_re)

    # Prefer Expected-titled step; else last Act without assert
    targets = _top_level_step_spans(text)
    inject_span: _BlockSpan | None = None
    for span in targets:
        if _is_auth_step_title(span.title) or _is_feature_entry_step_title(span.title):
            continue
        if _META_STEP_TITLE_RE.search(span.title):
            continue
        if re.search(r"(?i)expected|kỳ\s*vọng|assert|verify|kiểm\s*tra", span.title or ""):
            inject_span = span
            break
    if inject_span is None:
        for span in reversed(targets):
            if _is_auth_step_title(span.title) or _is_feature_entry_step_title(span.title):
                continue
            if _META_STEP_TITLE_RE.search(span.title):
                continue
            if _step_has_action(span.group(0)) and not _step_has_assert(span.group(0)):
                inject_span = span
                break
    if inject_span is None:
        return text

    open_idx = text.find("{", inject_span.start())
    # Prefer the step body's opening brace: after `async () =>`
    m_head = _TEST_STEP_HEAD_RE.search(text[inject_span.start() : inject_span.end()])
    if m_head:
        # Absolute index of '{'
        open_idx = inject_span.start() + m_head.end() - 1
    extracted = _extract_balanced_block(text, open_idx)
    if extracted is None:
        return text
    body, body_end = extracted
    close_end = body_end
    trail = re.match(r"\s*\)\s*;", text[body_end:])
    if trail:
        close_end = body_end + trail.end()

    inject = (
        "\n    // Business assertion (expectedOutcome — R6)\n"
        f"    await expect(page.getByText(new RegExp({hint_re_js}, 'i')).first())\n"
        "      .toBeVisible({ timeout: 15000 });\n"
    )
    head = text[inject_span.start() : open_idx + 1]
    closing = text[body_end - 1 : close_end]
    body_out = body.rstrip() + "\n"
    return text[: inject_span.start()] + head + body_out + inject + closing + text[close_end:]


def assert_e2e_ts_syntax_ok(files: list) -> None:
    """
    R9 — fail-closed on Spec/POM brace imbalance before publish/Verify.
    Lightweight (no tsc); catches heal/codegen broken `});` / Unexpected token.
    """
    from app.services.e2e_codegen_guard import E2EStrictGateError

    def _balance(src: str) -> str | None:
        depth_brace = depth_paren = 0
        in_s = in_d = in_t = in_line = in_block = False
        escape = False
        i = 0
        while i < len(src):
            ch = src[i]
            nxt = src[i + 1] if i + 1 < len(src) else ""
            if in_line:
                if ch == "\n":
                    in_line = False
                i += 1
                continue
            if in_block:
                if ch == "*" and nxt == "/":
                    in_block = False
                    i += 2
                    continue
                i += 1
                continue
            if escape:
                escape = False
                i += 1
                continue
            if (in_s or in_d or in_t) and ch == "\\":
                escape = True
                i += 1
                continue
            if not (in_s or in_d or in_t):
                if ch == "/" and nxt == "/":
                    in_line = True
                    i += 2
                    continue
                if ch == "/" and nxt == "*":
                    in_block = True
                    i += 2
                    continue
            if not in_d and not in_t and ch == "'":
                in_s = not in_s
            elif not in_s and not in_t and ch == '"':
                in_d = not in_d
            elif not in_s and not in_d and ch == "`":
                in_t = not in_t
            elif not in_s and not in_d and not in_t:
                if ch == "{":
                    depth_brace += 1
                elif ch == "}":
                    depth_brace -= 1
                    if depth_brace < 0:
                        return "unmatched }"
                elif ch == "(":
                    depth_paren += 1
                elif ch == ")":
                    depth_paren -= 1
                    if depth_paren < 0:
                        return "unmatched )"
            i += 1
        if depth_brace != 0:
            return f"brace imbalance ({depth_brace})"
        if depth_paren != 0:
            return f"paren imbalance ({depth_paren})"
        return None

    violations: list[str] = []
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        kind = getattr(f, "kind", "") or ""
        is_ts = (
            kind in ("spec", "page")
            or "/specs/" in f"/{p}/"
            or "/pages/" in f"/{p}/"
            or p.endswith(".spec.ts")
            or p.endswith(".page.ts")
        )
        if not is_ts:
            continue
        content = getattr(f, "content", "") or ""
        if not content.strip():
            continue
        err = _balance(content)
        if err:
            violations.append(f"{p}: {err}")
    if violations:
        raise E2EStrictGateError(
            "ContextMissing",
            "E2E_GROUNDING: syntax/brace gate failed (R9) — "
            + "; ".join(violations[:4]),
        )


def assert_feature_journey_ok(
    files: list,
    *,
    mode: str,
    test_case_title: str = "",
    enforce_business_assertions: bool = False,
) -> None:
    from app.services.e2e_auth_mode import is_login_or_auth_tc
    from app.services.e2e_codegen_guard import (
        E2ECodegenJourneyError,
        _is_login_or_auth_spec,
    )

    violations: list[str] = []
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        is_spec = getattr(f, "kind", "") == "spec" or "/specs/" in f"/{p}/" or p.endswith(
            ".spec.ts"
        )
        if not is_spec:
            continue
        content = getattr(f, "content", "") or ""
        # Skip non-journey stubs (no page fixture) — used by unit guard fixtures.
        if not re.search(
            r"async\s*\(\s*\{[^}]*\bpage\b",
            content or "",
        ):
            continue
        login = _is_login_or_auth_spec(p, content) or is_login_or_auth_tc(
            test_case_title, p
        )
        errs = validate_feature_journey_order(
            content,
            mode=mode,
            is_login_tc=login,
            enforce_business_assertions=enforce_business_assertions,
        )
        fake = list_fake_business_assertion_hits(content)
        if fake:
            errs.append(
                "BusinessAssertionFailed: forbidden fake assert (R6) — "
                + ", ".join(fake)
            )
        if errs:
            violations.append(f"{p}: " + "; ".join(errs))
    if violations:
        raise E2ECodegenJourneyError(
            "Phase 2 journey enforce failed (Auth → Feature entry → Act):\n- "
            + "\n- ".join(violations)
        )
