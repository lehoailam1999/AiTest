"""EX4.2 — Playwright inspect mode + HTTP fallback + Node shared runner."""

from __future__ import annotations

import asyncio
import builtins

from app.services.e2e_dom_inspector import (
    inspect_target,
    parse_html_interactive,
    resolve_fetch_fn,
)


def test_resolve_fetch_fn_http_when_disabled():
    fn, mode = asyncio.run(resolve_fetch_fn(use_playwright=False))
    assert mode == "http"
    assert callable(fn)


def test_parse_html_finds_role_button_and_testid():
    html = """
    <div id="root">
      <div role="button" aria-label="Add">+</div>
      <span data-testid="todo-input" contenteditable="true"></span>
    </div>
    """
    els = parse_html_interactive(html)
    assert any(e.role == "button" for e in els)
    assert any(e.test_id == "todo-input" for e in els)


def test_inspect_custom_fetch_spa_html():
    """Custom fetch injects SPA-like HTML with interactive elements."""

    async def fake_fetch(_url: str) -> str:
        return """
        <html><body>
          <button id="login">Login</button>
          <a href="/todos">Todos</a>
          <input name="email" type="email" />
        </body></html>
        """

    result = asyncio.run(
        inspect_target(
            target_url="http://localhost:3000",
            fetch_fn=fake_fetch,
            use_playwright=True,
        )
    )
    assert len(result.elements) > 0
    assert result.source.startswith("url:")


def test_resolve_fetch_fn_prefers_node_shared(tmp_path, monkeypatch):
    monkeypatch.setenv("AITEST_HOME", str(tmp_path / "home"))
    from app.services.aitest_playwright_runner import shared_playwright_runner_dir

    runner = shared_playwright_runner_dir()
    nm = runner / "node_modules" / "@playwright" / "test"
    nm.mkdir(parents=True)
    (nm / "package.json").write_text("{}", encoding="utf-8")

    real_import = builtins.__import__

    def _imp(name, *a, **k):
        if name == "playwright" or (
            isinstance(name, str) and name.startswith("playwright.")
        ):
            raise ImportError("no py playwright")
        return real_import(name, *a, **k)

    monkeypatch.setattr(builtins, "__import__", _imp)
    fn, mode = asyncio.run(resolve_fetch_fn(use_playwright=True))
    assert mode == "playwright-node"
    assert callable(fn)


def test_inspect_playwright_fail_falls_back_to_http(monkeypatch):
    """When playwright fetch fails, inspector retries HTTP GET."""

    async def boom(_url: str) -> str:
        raise RuntimeError("chromium missing")

    async def http_ok(_url: str) -> str:
        return '<html><body><button id="ok">OK</button></body></html>'

    async def resolve(*, use_playwright: bool):
        assert use_playwright is True
        return boom, "playwright"

    monkeypatch.setattr(
        "app.services.e2e_dom_inspector.resolve_fetch_fn",
        resolve,
    )
    monkeypatch.setattr(
        "app.services.e2e_dom_inspector._default_fetch_html",
        http_ok,
    )

    result = asyncio.run(
        inspect_target(
            target_url="http://localhost:3000",
            use_playwright=True,
        )
    )
    assert len(result.elements) > 0
    assert "fallback" in result.source
