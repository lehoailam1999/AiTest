"""
E2E DOM / FE source inspector — Phase E1.

Extract interactive elements for AI prompt context.
Browser runner is injectable so unit tests do not need Chromium.
"""

from __future__ import annotations

import json
import re
from dataclasses import asdict, dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Sequence


@dataclass
class InteractiveElement:
    tag: str
    role: str | None = None
    name: str | None = None
    test_id: str | None = None
    aria_label: str | None = None
    placeholder: str | None = None
    type: str | None = None
    href: str | None = None
    selector_candidates: list[str] = field(default_factory=list)


@dataclass
class InspectResult:
    target_url: str = ""
    elements: list[InteractiveElement] = field(default_factory=list)
    routes: list[str] = field(default_factory=list)
    source: str = "none"  # url | source | empty
    raw_snippet: str = ""

    def to_prompt_json(self, *, limit: int = 80) -> str:
        payload = {
            "targetUrl": self.target_url or None,
            "source": self.source,
            "routes": self.routes[:40],
            "elements": [asdict(e) for e in self.elements[:limit]],
        }
        return json.dumps(payload, ensure_ascii=False, indent=2)


BrowserFetchFn = Callable[[str], Awaitable[str]]


_INTERACTIVE_RE = re.compile(
    r"<(?P<tag>button|input|a|select|textarea|option)"
    r"(?P<attrs>[^>]*)>",
    re.IGNORECASE,
)
# SPA / a11y: div/span with role, any data-testid, contenteditable
_ROLE_EL_RE = re.compile(
    r"<(?P<tag>\w+)(?P<attrs>[^>]*\brole\s*=\s*['\"]"
    r"(?P<role>button|link|textbox|checkbox|radio|combobox|switch|tab|menuitem)"
    r"['\"][^>]*)>",
    re.IGNORECASE,
)
_TESTID_EL_RE = re.compile(
    r"<(?P<tag>\w+)(?P<attrs>[^>]*(?:data-testid|data-test-id|data-cy)\s*=\s*['\"][^'\"]+['\"][^>]*)>",
    re.IGNORECASE,
)
_ATTR_RE = re.compile(
    r"""(?P<k>[\w:-]+)\s*=\s*(?P<q>['"])(?P<v>.*?)(?P=q)""",
    re.IGNORECASE | re.DOTALL,
)
_TESTID_JSX = re.compile(
    r"""(?:data-testid|data-test-id|data-cy)\s*=\s*(?:\{\s*)?['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
_ROUTE_RE = re.compile(
    r"""(?:path|route)\s*[:=]\s*['"](/[^'"]*)['"]""",
    re.IGNORECASE,
)
_ARIA_ROLE_JSX = re.compile(
    r"""(?:role|aria-label)\s*=\s*(?:\{\s*)?['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
# Angular / reactive forms — common stable hooks in templates
_FORM_CONTROL_JSX = re.compile(
    r"""formControlName\s*=\s*(?:\{\s*)?['"]([^'"]+)['"]""",
    re.IGNORECASE,
)
_ID_ATTR_JSX = re.compile(
    r"""\bid\s*=\s*(?:\{\s*)?['"]([^'"]+)['"]""",
    re.IGNORECASE,
)


def _attr_map(attrs: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for m in _ATTR_RE.finditer(attrs or ""):
        out[m.group("k").lower()] = m.group("v").strip()
    return out


def _candidates_from_attrs(tag: str, attrs: dict[str, str]) -> list[str]:
    """
    Prefer stable HTML hooks used by real apps (JHipster data-cy, testid, name, id).
    Playwright config defaults testIdAttribute to data-cy — emit getByTestId for both.
    """
    cands: list[str] = []
    tid = (
        attrs.get("data-cy")
        or attrs.get("data-testid")
        or attrs.get("data-test-id")
    )
    if tid:
        # Runtime often maps getByTestId → data-cy via testIdAttribute
        cands.append(f'getByTestId("{tid}")')
        if attrs.get("data-cy"):
            cands.append(f'[data-cy="{tid}"]')
        else:
            cands.append(f'[data-testid="{tid}"]')
    fcn = attrs.get("formcontrolname")
    if fcn:
        cands.append(f'[formControlName="{fcn}"]')
        cands.append(f'locator(`[formcontrolname="{fcn}"]`)')
    name_attr = attrs.get("name")
    if name_attr and name_attr not in (tid or "",):
        cands.append(f'[name="{name_attr}"]')
    role = attrs.get("role")
    accessible = (
        attrs.get("aria-label")
        or attrs.get("placeholder")
        or attrs.get("title")
    )
    if role and accessible:
        cands.append(f'getByRole("{role}", {{ name: "{accessible}" }})')
    elif tag == "button" and accessible:
        cands.append(f'getByRole("button", {{ name: "{accessible}" }})')
    elif tag == "a" and accessible:
        cands.append(f'getByRole("link", {{ name: "{accessible}" }})')
    elif tag == "select" and accessible:
        cands.append(f'getByRole("combobox", {{ name: "{accessible}" }})')
    if attrs.get("aria-label"):
        cands.append(f'getByLabel("{attrs["aria-label"]}")')
    if attrs.get("placeholder"):
        cands.append(f'getByPlaceholder("{attrs["placeholder"]}")')
    if attrs.get("id"):
        cands.append(f'#{attrs["id"]}')
        cands.append(f'locator("#{attrs["id"]}")')
    # de-dupe preserve order
    seen: set[str] = set()
    out: list[str] = []
    for c in cands:
        if c in seen:
            continue
        seen.add(c)
        out.append(c)
    return out[:8]


def parse_html_interactive(html: str) -> list[InteractiveElement]:
    elements: list[InteractiveElement] = []
    seen_spans: set[tuple[int, int]] = set()

    def _add(tag: str, attrs: dict[str, str], span: tuple[int, int]) -> None:
        if span in seen_spans:
            return
        seen_spans.add(span)
        elements.append(
            InteractiveElement(
                tag=tag,
                role=attrs.get("role"),
                name=attrs.get("name") or attrs.get("aria-label"),
                test_id=(
                    attrs.get("data-cy")
                    or attrs.get("data-testid")
                    or attrs.get("data-test-id")
                ),
                aria_label=attrs.get("aria-label"),
                placeholder=attrs.get("placeholder"),
                type=attrs.get("type"),
                href=attrs.get("href"),
                selector_candidates=_candidates_from_attrs(tag, attrs),
            )
        )

    for m in _INTERACTIVE_RE.finditer(html or ""):
        _add(m.group("tag").lower(), _attr_map(m.group("attrs")), m.span())
    for m in _ROLE_EL_RE.finditer(html or ""):
        _add(m.group("tag").lower(), _attr_map(m.group("attrs")), m.span())
    for m in _TESTID_EL_RE.finditer(html or ""):
        _add(m.group("tag").lower(), _attr_map(m.group("attrs")), m.span())
    return elements


def parse_source_interactive(source: str) -> tuple[list[InteractiveElement], list[str]]:
    """Heuristic parse of React/Vue/Angular templates for testids / roles / routes."""
    elements: list[InteractiveElement] = []
    for tid in _TESTID_JSX.findall(source or ""):
        elements.append(
            InteractiveElement(
                tag="unknown",
                test_id=tid,
                selector_candidates=[
                    f'getByTestId("{tid}")',
                    f'[data-cy="{tid}"]',
                    f'[data-testid="{tid}"]',
                ],
            )
        )
    for fcn in _FORM_CONTROL_JSX.findall(source or ""):
        elements.append(
            InteractiveElement(
                tag="input",
                name=fcn,
                selector_candidates=[
                    f'[formControlName="{fcn}"]',
                    f'[name="{fcn}"]',
                ],
            )
        )
    for eid in _ID_ATTR_JSX.findall(source or ""):
        if eid.startswith("field_") or eid.startswith("jh-") or "field" in eid.lower():
            elements.append(
                InteractiveElement(
                    tag="unknown",
                    name=eid,
                    selector_candidates=[f"#{eid}", f'locator("#{eid}")'],
                )
            )
    # Also reuse HTML regex for template strings
    elements.extend(parse_html_interactive(source or ""))
    routes = list(dict.fromkeys(_ROUTE_RE.findall(source or "")))
    return elements, routes


async def _default_fetch_html(url: str) -> str:
    """Best-effort HTTP GET (no JS render). Prefer injectable Playwright fetch in Desktop."""
    import urllib.request

    req = urllib.request.Request(url, headers={"User-Agent": "AITest-E2E-Inspector/1.0"})
    with urllib.request.urlopen(req, timeout=15) as resp:  # noqa: S310 — user-provided target URL
        return resp.read().decode("utf-8", errors="replace")


async def _playwright_fetch_html(url: str, *, timeout_ms: int = 20000) -> str:
    """
    EX4.2 — Chromium render via Playwright sync API in a worker thread.
    Falls back to raising if playwright / browser missing.
    """
    import asyncio

    def _sync_fetch() -> str:
        from playwright.sync_api import sync_playwright

        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                page = browser.new_page()
                page.goto(url, wait_until="domcontentloaded", timeout=timeout_ms)
                # SPA: wait a beat for client render (avoid networkidle — can hang)
                page.wait_for_timeout(1200)
                return page.content()
            finally:
                browser.close()

    return await asyncio.to_thread(_sync_fetch)


async def _node_playwright_fetch_html_with_runner(url: str, runner: Path) -> str:
    """
    Render SPA via Node Playwright runner dir (shared or project package root).
    """
    import asyncio
    import os
    import shutil
    import subprocess
    import sys

    from app.llm.cli.process_runner import _CREATE_NO_WINDOW
    if not (runner / "node_modules" / "@playwright" / "test").is_dir():
        raise RuntimeError(f"Runner chưa có @playwright/test: {runner}")

    src_script = Path(__file__).with_name("playwright_dump_html.mjs")
    dst = runner / "dump-html.mjs"
    if src_script.is_file():
        dst.write_text(src_script.read_text(encoding="utf-8"), encoding="utf-8")
    elif not dst.is_file():
        raise RuntimeError("dump-html.mjs missing")

    node = shutil.which("node") or shutil.which("node.exe")
    if not node:
        raise RuntimeError("Không tìm thấy node trên PATH của API")

    def _sync() -> str:
        kwargs: dict = {
            "cwd": str(runner),
            "stdout": subprocess.PIPE,
            "stderr": subprocess.PIPE,
            "env": os.environ.copy(),
        }
        if sys.platform == "win32" and _CREATE_NO_WINDOW:
            kwargs["creationflags"] = _CREATE_NO_WINDOW
        completed = subprocess.run(  # noqa: S603
            [node, str(dst), url],
            **kwargs,
        )
        out = (completed.stdout or b"").decode("utf-8", errors="replace")
        err = (completed.stderr or b"").decode("utf-8", errors="replace")
        if completed.returncode != 0:
            raise RuntimeError(err.strip() or f"dump-html exit {completed.returncode}")
        if not out.strip():
            raise RuntimeError("dump-html returned empty HTML")
        return out

    return await asyncio.to_thread(_sync)


async def _node_shared_playwright_fetch_html(url: str) -> str:
    """
    Render SPA via AITest shared Node runner (~/.aitest/playwright-runner).
    Uses same Chromium as Headless — không cần pip install playwright.
    """
    from app.services.aitest_playwright_runner import (
        shared_playwright_installed,
        shared_playwright_runner_dir,
    )

    runner = shared_playwright_runner_dir()
    if not shared_playwright_installed(runner):
        raise RuntimeError(
            "AITest Playwright runner chưa cài — bấm «Cài Playwright trên AITest»"
        )
    return await _node_playwright_fetch_html_with_runner(url, runner)


async def resolve_fetch_fn(
    *,
    use_playwright: bool,
    project_root: str = "",
) -> tuple[BrowserFetchFn, str]:
    """
    Returns (fetch_fn, mode_label).
    mode_label: playwright | playwright-node | http
    """
    if not use_playwright:
        return _default_fetch_html, "http"

    # 1) Python playwright (optional)
    try:
        import playwright  # noqa: F401

        return _playwright_fetch_html, "playwright"
    except Exception:
        pass

    # 2) Project-local Node Playwright (monorepo/frontend package)
    try:
        from app.services.e2e_orchestrator import find_playwright_package_root

        if project_root.strip():
            pkg = find_playwright_package_root(project_root.strip())
            if pkg is not None:
                return (
                    lambda url: _node_playwright_fetch_html_with_runner(url, pkg),
                    "playwright-node(project)",
                )
    except Exception:
        pass

    # 3) AITest shared Node Chromium (same as Headless)
    try:
        from app.services.aitest_playwright_runner import (
            shared_playwright_installed,
            shared_playwright_runner_dir,
        )

        if shared_playwright_installed(shared_playwright_runner_dir()):
            return _node_shared_playwright_fetch_html, "playwright-node"
    except Exception:
        pass

    return _default_fetch_html, "http"


async def inspect_target(
    *,
    target_url: str = "",
    source_code: str = "",
    source_paths: Sequence[tuple[str, str]] | None = None,
    fetch_fn: BrowserFetchFn | None = None,
    use_playwright: bool = False,
    project_root: str = "",
) -> InspectResult:
    """
    Inspect live URL and/or FE source for interactive elements.
    use_playwright=True → Chromium render (Python or AITest Node runner); falls back to HTTP GET.
    """
    elements: list[InteractiveElement] = []
    routes: list[str] = []
    source = "empty"
    raw = ""
    render_mode = "none"

    url = (target_url or "").strip()
    if url:
        if fetch_fn is not None:
            fetcher = fetch_fn
            render_mode = "custom"
        else:
            try:
                fetcher, render_mode = await resolve_fetch_fn(
                    use_playwright=use_playwright,
                    project_root=project_root,
                )
            except TypeError:
                # Backward-compatible with tests/monkeypatch expecting old signature.
                fetcher, render_mode = await resolve_fetch_fn(
                    use_playwright=use_playwright
                )
        try:
            html = await fetcher(url)
            raw = html[:20000]
            elements.extend(parse_html_interactive(html))
            source = f"url:{render_mode}"
        except Exception as exc:  # noqa: BLE001
            # Chromium fail → one retry with static GET
            if use_playwright and fetch_fn is None and render_mode.startswith(
                "playwright"
            ):
                try:
                    html = await _default_fetch_html(url)
                    raw = html[:20000]
                    elements.extend(parse_html_interactive(html))
                    source = "url:http(fallback)"
                    raw = f"(playwright failed: {exc})\n" + raw
                except Exception as exc2:  # noqa: BLE001
                    raw = f"(fetch failed: playwright={exc}; http={exc2})"
            else:
                raw = f"(fetch failed: {exc})"

    if source_code.strip():
        el, rt = parse_source_interactive(source_code)
        elements.extend(el)
        routes.extend(rt)
        source = "source" if source == "empty" else f"{source}+source"

    for _path, content in source_paths or []:
        el, rt = parse_source_interactive(content)
        elements.extend(el)
        routes.extend(rt)
        if source == "empty":
            source = "source"

    # Dedupe by test_id / tag+name
    seen: set[str] = set()
    unique: list[InteractiveElement] = []
    for e in elements:
        key = f"{e.tag}|{e.test_id}|{e.name}|{e.aria_label}|{e.placeholder}"
        if key in seen:
            continue
        seen.add(key)
        unique.append(e)

    return InspectResult(
        target_url=url,
        elements=unique,
        routes=list(dict.fromkeys(routes)),
        source=source,
        raw_snippet=raw[:4000],
    )


def inspect_source_files(project_root: str, relative_paths: Sequence[str]) -> InspectResult:
    """Sync helper: read FE files from disk and parse."""
    root = Path(project_root)
    pairs: list[tuple[str, str]] = []
    for rel in relative_paths:
        p = root / rel.replace("\\", "/")
        if p.is_file():
            pairs.append((rel, p.read_text(encoding="utf-8", errors="replace")))
    # run sync path via asyncio-less parse
    elements: list[InteractiveElement] = []
    routes: list[str] = []
    for _path, content in pairs:
        el, rt = parse_source_interactive(content)
        elements.extend(el)
        routes.extend(rt)
    return InspectResult(
        elements=elements,
        routes=list(dict.fromkeys(routes)),
        source="source" if elements or routes else "empty",
    )
