"""
Phase 2 — enforce Auth → Feature entry → Act on generated Playwright Specs.

Called from ``e2e_codegen_guard.apply_e2e_codegen_guards`` after auth/entry inject.
Missing phases or wrong order → ``E2ECodegenJourneyError`` (fail codegen).
"""

from __future__ import annotations

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


def _code_without_comments(text: str) -> str:
    text = re.sub(r"/\*.*?\*/", " ", text or "", flags=re.DOTALL)
    return re.sub(r"//.*?$", " ", text, flags=re.MULTILINE)


def spec_has_feature_entry(content: str) -> bool:
    text = _code_without_comments(content)
    if _FEATURE_ENTRY_STEP_RE.search(text):
        return True
    if _GOTO_FEATURE_RE.search(text):
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
    return errors


def assert_feature_journey_ok(
    files: list,
    *,
    mode: str,
    test_case_title: str = "",
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
        errs = validate_feature_journey_order(content, mode=mode, is_login_tc=login)
        if errs:
            violations.append(f"{p}: " + "; ".join(errs))
    if violations:
        raise E2ECodegenJourneyError(
            "Phase 2 journey enforce failed (Auth → Feature entry → Act):\n- "
            + "\n- ".join(violations)
        )
