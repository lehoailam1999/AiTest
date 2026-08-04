"""
Phase 3 — POM stubs grounded in DOM selector_candidates.

- Prefer Inspect DOM hooks when creating/healing page methods.
- Empty / comment-only method bodies = fake pass → fail codegen.
"""

from __future__ import annotations

import json
import re
from typing import Any


class E2ECodegenStubError(ValueError):
    """Phase 3 — empty or ungrounded POM stub (no fake-pass voids)."""


_PREFIX_STRIP = re.compile(
    r"^(?:click|tap|press|fill|type|enter|set|select|check|uncheck|open|close|"
    r"goto|go|expect|assert|get|find|locate|ensure|wait|upload|choose|pick|"
    r"complete|finish|submit|advance|arrange|prepare|setup)",
    re.IGNORECASE,
)

_EMPTY_METHOD_RE = re.compile(
    r"(?:async\s+)?(\w+)\s*\(([^)]*)\)\s*(?::\s*[^{;]+)?\s*\{([^{}]*)\}",
    re.DOTALL,
)

_UNGROUNDED_MARK = "Phase 3: ungrounded POM stub"

# Tokens that never help match UI labels (wizard/step verbs)
_TOKEN_STOP = frozenset(
    {
        "async",
        "await",
        "page",
        "the",
        "and",
        "or",
        "to",
        "for",
        "from",
        "with",
        "step",
        "reach",
        "into",
        "onto",
    }
)


def method_tokens(method: str) -> list[str]:
    """clickUploadEvidence → [upload, evidence]; completeStep1ToReachStep2 → [1, 2] filtered."""
    raw = method or ""
    parts = re.findall(r"[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+", raw)
    tokens = [p.lower() for p in parts if len(p) >= 1]
    # Drop leading action verbs, but keep the last token (clickUpload → upload)
    while len(tokens) > 1 and _PREFIX_STRIP.match(tokens[0]):
        tokens = tokens[1:]
    return [t for t in tokens if t not in _TOKEN_STOP and (len(t) >= 2 or t.isdigit())]


def parse_dom_elements(dom_snapshot: str) -> list[dict[str, Any]]:
    text = (dom_snapshot or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except Exception:
        return []
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict)]
    if isinstance(data, dict):
        els = data.get("elements")
        if isinstance(els, list):
            return [e for e in els if isinstance(e, dict)]
    return []


def _el_blob(el: dict[str, Any]) -> str:
    bits = [
        str(el.get("name") or ""),
        str(el.get("testId") or el.get("test_id") or ""),
        str(el.get("ariaLabel") or el.get("aria_label") or ""),
        str(el.get("placeholder") or ""),
        str(el.get("role") or ""),
        str(el.get("tag") or ""),
        str(el.get("type") or ""),
        str(el.get("href") or ""),
    ]
    cands = el.get("selectorCandidates") or el.get("selector_candidates") or []
    if isinstance(cands, list):
        bits.extend(str(c) for c in cands)
    return " ".join(bits).lower()


def score_element_for_method(method: str, el: dict[str, Any]) -> int:
    tokens = method_tokens(method)
    if not tokens:
        return 0
    blob = _el_blob(el)
    if not blob.strip():
        return 0
    score = 0
    for t in tokens:
        if t.isdigit():
            continue  # step numbers alone are weak matches
        if t in blob:
            score += 3 if len(t) >= 4 else 1
    # Prefer interactive hooks for click/fill/wizard
    low = (method or "").lower()
    role = str(el.get("role") or el.get("tag") or "").lower()
    typ = str(el.get("type") or "").lower()
    if low.startswith(("click", "tap", "press", "complete", "finish", "advance")) and role in (
        "button",
        "link",
        "menuitem",
        "tab",
    ):
        score += 2
    if any(x in low for x in ("step", "next", "continue", "wizard")) and role == "button":
        score += 2
    if low.startswith(("fill", "type", "enter")) and (
        role in ("textbox", "searchbox", "combobox")
        or typ in ("text", "email", "password", "search", "number")
        or str(el.get("tag") or "").lower() in ("input", "textarea")
    ):
        score += 2
    if low.startswith(("expect", "assert", "get")) and (
        el.get("testId") or el.get("test_id") or el.get("name")
    ):
        score += 1
    return score


def best_element_for_method(
    method: str, elements: list[dict[str, Any]]
) -> dict[str, Any] | None:
    if not elements:
        return None
    ranked = sorted(
        ((score_element_for_method(method, el), i, el) for i, el in enumerate(elements)),
        key=lambda x: (-x[0], x[1]),
    )
    if ranked and ranked[0][0] > 0:
        return ranked[0][2]
    return None


def locator_expr_from_element(el: dict[str, Any]) -> str | None:
    """Return a TypeScript expression starting at this.page.…"""
    cands = el.get("selectorCandidates") or el.get("selector_candidates") or []
    if not isinstance(cands, list):
        cands = []
    for raw in cands:
        c = str(raw).strip()
        if not c:
            continue
        if c.startswith("getBy") or c.startswith("locator("):
            return f"this.page.{c}"
        if c.startswith("page."):
            return c.replace("page.", "this.page.", 1)
        if c.startswith("[") or c.startswith("#") or c.startswith(".") or c.startswith("input"):
            esc = c.replace("\\", "\\\\").replace("'", "\\'")
            return f"this.page.locator('{esc}')"
    tid = str(el.get("testId") or el.get("test_id") or "").strip()
    if tid:
        return f'this.page.getByTestId("{tid}")'
    role = str(el.get("role") or "").strip()
    name = str(
        el.get("name") or el.get("ariaLabel") or el.get("aria_label") or ""
    ).strip()
    if role and name:
        return f'this.page.getByRole("{role}", {{ name: {json.dumps(name)} }})'
    if name:
        tag = str(el.get("tag") or "").lower()
        if tag == "button" or role == "button":
            return f'this.page.getByRole("button", {{ name: {json.dumps(name)} }})'
        return f"this.page.getByText({json.dumps(name)}, {{ exact: false }}).first()"
    ph = str(el.get("placeholder") or "").strip()
    if ph:
        return f"this.page.getByPlaceholder({json.dumps(ph)})"
    return None


def render_dom_grounded_stub(method: str, el: dict[str, Any]) -> str | None:
    loc = locator_expr_from_element(el)
    if not loc:
        return None
    name = method or "action"
    low = name.lower()
    loc_first = loc if ".first(" in loc else f"{loc}.first()"
    note = (
        "    // Phase 3 — locator from DOM selector_candidates / testId / role+name\n"
    )
    if low.startswith(("get", "find", "locate")):
        return (
            f"\n  {name}(..._args: unknown[]): Locator {{\n"
            f"{note}"
            f"    return {loc_first};\n"
            "  }\n"
        )
    note_loc = note + f"    const loc = {loc_first};\n"
    if low.startswith(("expect", "assert")):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            f"{note_loc}"
            "    await expect(loc).toBeVisible({ timeout: 15000 });\n"
            "  }\n"
        )
    if low.startswith(("fill", "type", "enter")):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            f"{note_loc}"
            "    const value = _args.length > 1 ? _args[1] : _args[0];\n"
            "    const q = value == null ? '' : String(value);\n"
            "    await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "    await loc.fill(q);\n"
            "  }\n"
        )
    if low.startswith(("click", "tap", "press", "open", "upload", "choose", "select")):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            f"{note_loc}"
            "    await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "    await loc.click();\n"
            "  }\n"
        )
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        f"{note_loc}"
        "    await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
        "    if (await loc.isVisible().catch(() => false)) {\n"
        "      await loc.click().catch(async () => { await expect(loc).toBeVisible(); });\n"
        "    } else {\n"
        "      await expect(loc).toBeVisible({ timeout: 15000 });\n"
        "    }\n"
        "  }\n"
    )


def render_ungrounded_fail_stub(method: str) -> str:
    """Never empty void — runtime + codegen both treat as failure."""
    name = method or "action"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        f"    throw new Error('{_UNGROUNDED_MARK} `{name}` — "
        "no DOM selector_candidates; regenerate after Inspect');\n"
        "  }\n"
    )


def method_body_is_empty_pass(body: str) -> bool:
    """True when body is empty or comments-only (fake pass)."""
    text = body or ""
    text = re.sub(r"/\*.*?\*/", "", text, flags=re.DOTALL)
    text = re.sub(r"//.*?$", "", text, flags=re.MULTILINE)
    return not text.strip()


def find_empty_pass_methods(page_content: str) -> list[str]:
    """Method names with empty/comment-only bodies (excluding constructor)."""
    found: list[str] = []
    for m in _EMPTY_METHOD_RE.finditer(page_content or ""):
        name = m.group(1)
        if name in ("constructor", "if", "for", "while", "switch", "catch"):
            continue
        # Skip sync path helpers that return a value in a one-liner — body not empty
        if method_body_is_empty_pass(m.group(3)):
            found.append(name)
    return found


def rewrite_empty_methods_with_dom(
    page_content: str, *, dom_snapshot: str = ""
) -> tuple[str, list[str]]:
    """
    Replace empty method bodies with DOM-grounded stubs when possible.
    Returns (new_content, still_empty_or_ungrounded_names).
    """
    elements = parse_dom_elements(dom_snapshot)
    text = page_content or ""
    leftover: list[str] = []

    pattern = re.compile(
        r"(async\s+)(\w+)(\s*\([^)]*\)\s*(?::\s*[^{;]+)?\s*)\{([^{}]*)\}",
        re.DOTALL,
    )

    def repl_async(m: re.Match[str]) -> str:
        prefix, name, sig, body = m.group(1), m.group(2), m.group(3), m.group(4)
        if name == "constructor":
            return m.group(0)
        if not method_body_is_empty_pass(body):
            return m.group(0)
        # goto() without DOM — safe navigation stub (not fake-pass empty)
        if name == "goto":
            return (
                f"{prefix}{name}{sig}{{\n"
                "    await this.page.goto('/', { waitUntil: 'domcontentloaded' });\n"
                "  }"
            )
        el = best_element_for_method(name, elements)
        stub = render_dom_grounded_stub(name, el) if el else None
        if not stub:
            leftover.append(name)
            stub = render_ungrounded_fail_stub(name)
        # Keep "async name(...)" — stub already includes full signature
        return stub.strip()

    new_text = pattern.sub(repl_async, text)
    still = find_empty_pass_methods(new_text)
    leftover = list(dict.fromkeys(leftover + still))
    return new_text, leftover


def assert_no_empty_pass_stubs(files: list, *, dom_snapshot: str = "") -> None:
    """
    Phase 3 enforce: no empty/comment-only POM methods after rewrite attempt.
    Empty fake-pass is forbidden. Ungrounded throw stubs are kept for runtime fail
    when DOM has no match (do not soft-pass).
    """
    violations: list[str] = []
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        low = p.lower()
        is_page = getattr(f, "kind", "") == "page" or "/pages/" in f"/{low}/"
        if not is_page:
            continue
        content = getattr(f, "content", "") or ""
        fixed, _leftover = rewrite_empty_methods_with_dom(
            content, dom_snapshot=dom_snapshot
        )
        if fixed != content:
            f.content = fixed
        empty = find_empty_pass_methods(f.content or "")
        if empty:
            violations.append(f"{p}: empty fake-pass methods {empty}")
    if violations:
        raise E2ECodegenStubError(
            "Phase 3 stub enforce failed (empty fake-pass forbidden; "
            "use DOM selector_candidates):\n- " + "\n- ".join(violations)
        )
