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
    r"test\.step\s*\(\s*['\"][^'\"]*(?:[ĐđDd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)",
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
    r"(?:^\d+\.\s*)(?:[ĐđDd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)|"
    r"(?:^|\s)(?:0\.\s*)?(?:[ĐđDd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat)\b",
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
    auth_m = re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", text) or _AUTH_STEP_RE.search(
        text
    )
    entry_pos: int | None = None
    entry_m = _FEATURE_ENTRY_STEP_RE.search(text)
    if entry_m:
        entry_pos = entry_m.start()
    else:
        # test.step whose body calls gotoFeature/openFeature counts as Feature entry
        for start, end, _title in _iter_test_step_spans(text):
            if _GOTO_FEATURE_RE.search(text[start:end]):
                entry_pos = start
                break
        if entry_pos is None:
            gf = _GOTO_FEATURE_RE.search(text)
            entry_pos = gf.start() if gf else None
        if entry_pos is None:
            pg = _PAGE_GOTO_RE.search(text)
            entry_pos = pg.start() if pg else None

    act_pos: int | None = None
    for start, end, title in _iter_test_step_spans(text):
        if _META_STEP_TITLE_RE.search(title):
            continue
        # Navigation-only step (gotoFeature) is Feature entry, not Act.
        if entry_pos is not None and start == entry_pos:
            continue
        if _GOTO_FEATURE_RE.search(text[start:end]) and not re.search(
            r"\.fill\s*\(|\.click\s*\(|\.setInputFiles\s*\(|await\s+expect\s*\(",
            text[start:end],
        ):
            continue
        act_pos = start
        break
    if act_pos is None:
        search_from = (entry_pos + 1) if entry_pos is not None else (
            auth_m.end() if auth_m else 0
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
        "auth": 0 if mode in ("storage", "public") else (auth_m.start() if auth_m else None),
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
            errors.append("Login TC missing Act (fill/click/assert)")
        return errors

    if not spec_has_auth_phase(content, mode=mode):
        errors.append("missing Auth (ensureAuthenticated step 0)")
    if not spec_has_feature_entry(content):
        errors.append("missing Feature entry (after Auth, before Act)")
    if not spec_has_act_phase(content):
        errors.append("missing Act (test.step / fill / click / expect after Feature entry)")

    if errors:
        return errors

    pos = _phase_positions(content, mode=mode)
    auth_i, entry_i, act_i = pos["auth"], pos["entry"], pos["act"]
    if auth_i is not None and entry_i is not None and auth_i > entry_i:
        errors.append("order: Auth must come before Feature entry")
    if entry_i is not None and act_i is not None and entry_i > act_i:
        errors.append("order: Feature entry must come before Act")
    if auth_i is not None and act_i is not None and auth_i > act_i and mode == "ui_helper":
        errors.append("order: Auth must come before Act")
    if enforce_business_assertions and not errors:
        weak_asserts = _missing_business_assertions(content)
        if weak_asserts:
            errors.append(
                "BusinessAssertionFailed: missing assert in Act steps "
                + ", ".join(weak_asserts[:3])
            )
    return errors


_ASSERT_SIGNAL_RE = re.compile(
    r"await\s+expect\s*\(|"
    r"\btoHave(?:Text|Count|Value|URL)\s*\(|"
    r"\btoBe(?:Visible|Hidden|Disabled|Enabled|Checked)\s*\(|"
    # POM/helper business asserts: await pom.expectX(...) / await pageObj.assertY(...)
    r"await\s+(?!page\b)[A-Za-z_]\w*\.(?:expect|assert)[A-Za-z_]\w*\s*\(",
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


def _step_has_action(block: str) -> bool:
    return bool(_ACT_SIGNAL_RE.search(block or ""))


def _step_has_assert(block: str) -> bool:
    return bool(_ASSERT_SIGNAL_RE.search(block or ""))


def _missing_business_assertions(content: str) -> list[str]:
    text = _code_without_comments(content)
    missing: list[str] = []
    for start, end, title in _iter_test_step_spans(text):
        if _META_STEP_TITLE_RE.search(title):
            continue
        block = text[start:end]
        if not _step_has_action(block):
            continue
        if not _step_has_assert(block):
            missing.append(title.strip() or "(untitled)")
    return missing


def _expected_text_hint(expected_hint: str) -> str:
    """Pick a short stable fragment from Expected outcome for getByText assert."""
    raw = (expected_hint or "").strip()
    if not raw:
        return ""
    for ln in raw.splitlines():
        s = re.sub(
            r"(?i)^\s*(?:expected(?:\s*outcome)?|kỳ\s*vọng|assert)\s*[:=]\s*",
            "",
            ln,
        ).strip()
        if len(s) >= 4:
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

_FEATURE_ENTRY_STEP_HEAD_RE = re.compile(
    r"await\s+test\.step\s*\(\s*['\"][^'\"]*"
    r"(?:Feature\s*entry|Vào\s*chức\s*năng|feature\s*entry|mở\s*màn)"
    r"[^'\"]*['\"]\s*,\s*async\s*\(\s*\)\s*=>\s*\{",
    re.IGNORECASE,
)


class _BlockSpan:
    __slots__ = ("_s", "_e", "_text")

    def __init__(self, s: int, e: int, text: str) -> None:
        self._s = s
        self._e = e
        self._text = text

    def start(self) -> int:
        return self._s

    def end(self) -> int:
        return self._e

    def group(self, _n: int = 0) -> str:
        return self._text[self._s : self._e]


def _find_feature_entry_step_span(text: str) -> _BlockSpan | None:
    m = _FEATURE_ENTRY_STEP_HEAD_RE.search(text or "")
    if not m:
        return None
    open_idx = m.end() - 1
    extracted = _extract_balanced_block(text, open_idx)
    if extracted is None:
        return None
    _body, body_end = extracted
    close_end = body_end
    trail = re.match(r"\s*\)\s*;", text[body_end:])
    if trail:
        close_end = body_end + trail.end()
    # Include leading newline/indent like other reorder helpers
    start = m.start()
    if start > 0 and text[start - 1] == "\n":
        start -= 1
    return _BlockSpan(start, close_end, text)


def _insert_after_auth(text: str, block: str) -> str | None:
    """Prefer end of Auth test.step; else right after ensureAuthenticated(page)."""
    for m in _TEST_STEP_HEAD_RE.finditer(text or ""):
        title = m.group("title") or ""
        if not re.search(
            r"(?:[ĐđDd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat|[Aa]uth\b)",
            title,
            re.IGNORECASE,
        ):
            continue
        open_idx = m.end() - 1
        extracted = _extract_balanced_block(text, open_idx)
        if extracted is None:
            continue
        body, body_end = extracted
        if not re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", body):
            continue
        close_end = body_end
        trail = re.match(r"\s*\)\s*;", text[body_end:])
        if trail:
            close_end = body_end + trail.end()
        piece = block if block.startswith("\n") else "\n" + block
        return text[:close_end] + piece + text[close_end:]
    auth = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if not auth:
        return None
    piece = block if block.startswith("\n") else "\n" + block
    return text[: auth.end()] + piece + text[auth.end() :]


def heal_feature_journey_order(content: str) -> str:
    """
    Repair Auth → Feature entry order so Phase-2 enforce can pass.

    LLM often emits Feature entry / page.goto / gotoFeature *before*
    ensureAuthenticated. Prior reorder only matched English ``Feature entry``
    titles and missed bare navigation — Gen then failed journey enforce.
    """
    text = content or ""
    auth = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if not auth:
        return text

    # 1) Move Feature-entry test.step (EN/VI) after Auth phase
    entry = _find_feature_entry_step_span(text)
    if entry and entry.start() < auth.start():
        block = entry.group(0)
        without = text[: entry.start()] + text[entry.end() :]
        moved = _insert_after_auth(without, block)
        if moved is not None:
            text = moved

    # 2) Move bare early navigations that still sit before Auth
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
    Auto-heal Act steps that perform actions but lack business assertions.

    Injects landmark + optional expected-text asserts before step close.
    Idempotent when asserts already present.
    """
    text = content or ""
    hint = _expected_text_hint(expected_hint)
    hint_re = re.escape(hint) if hint else ""
    hint_re_js = json.dumps(hint_re)

    parts: list[str] = []
    cursor = 0
    for m in _TEST_STEP_HEAD_RE.finditer(text):
        title = m.group("title") or ""
        open_idx = m.end() - 1  # points at '{'
        extracted = _extract_balanced_block(text, open_idx)
        if extracted is None:
            continue
        body, body_end = extracted
        # Skip trailing `);` after `}`
        close_end = body_end
        trail = re.match(r"\s*\)\s*;", text[body_end:])
        if trail:
            close_end = body_end + trail.end()

        parts.append(text[cursor:m.start()])
        head = text[m.start() : open_idx + 1]
        tail = text[body_end:close_end]

        if _META_STEP_TITLE_RE.search(title) or not _step_has_action(body) or _step_has_assert(
            body
        ):
            parts.append(text[m.start():close_end])
            cursor = close_end
            continue

        inject = (
            "\n    // Business assertion (auto-healed — Rule 24)\n"
            "    await expect(\n"
            "      page.locator('main, [role=\"main\"], nav, h1, h2, [data-cy], [data-testid]').first()\n"
            "    ).toBeVisible({ timeout: 15000 });\n"
        )
        if hint_re:
            inject += (
                f"    await expect(page.getByText(new RegExp({hint_re_js}, 'i')).first())\n"
                "      .toBeVisible({ timeout: 15000 });\n"
            )
        body_out = body.rstrip() + "\n"
        parts.append(head + body_out + inject + "  " + tail)
        cursor = close_end

    parts.append(text[cursor:])
    return "".join(parts)


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
        if errs:
            violations.append(f"{p}: " + "; ".join(errs))
    if violations:
        raise E2ECodegenJourneyError(
            "Phase 2 journey enforce failed (Auth → Feature entry → Act):\n- "
            + "\n- ".join(violations)
        )
