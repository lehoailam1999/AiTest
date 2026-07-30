"""Tests for E2EOrchestrator sandbox auto-heal + parsers."""

from __future__ import annotations

import asyncio
import json
import shutil
from pathlib import Path

from app.llm.base import (
    E2EFile,
    E2ERequest,
    default_playwright_config,
    parse_e2e_files_from_raw,
)
from app.services.e2e_dom_inspector import parse_html_interactive, parse_source_interactive
from app.services.e2e_orchestrator import (
    E2EOrchestrator,
    PLAYWRIGHT_INSTALL_HINT,
    _inject_node_path_for_prefixed_playwright,
    _merge_env,
    _sanitize_playwright_env,
    build_e2e_heal_prompt_context,
    check_playwright_ready,
    ensure_playwright_config,
    exc_detail,
    parse_playwright_json_report,
    resolve_e2e_work_cwd,
    _runtime_fix_missing_storage_state,
)
from app.services.test_output_layout import e2e_module_root, resolve_e2e_file_paths


def _req(**kwargs) -> E2ERequest:
    base = dict(
        test_case_title="Login flow",
        test_case_type="E2E",
        priority="High",
        steps="1. Open login\n2. Submit",
        expected_result="Dashboard",
        module="Auth",
        target_url="http://localhost:3000",
    )
    base.update(kwargs)
    return E2ERequest(**base)


def test_parse_e2e_files_from_raw_file_sections():
    raw = """
### FILE: pages/login.page.ts
```ts
export class LoginPage {}
```
### FILE: specs/login.spec.ts
```ts
import { test } from '@playwright/test';
```
"""
    files = parse_e2e_files_from_raw(raw)
    assert len(files) == 2
    assert files[0].kind == "page"
    assert "LoginPage" in files[0].content


def test_parse_e2e_files_from_raw_json():
    raw = json.dumps(
        {
            "files": [
                {"path": "pages/a.page.ts", "content": "export const a = 1;", "kind": "page"},
                {"path": "specs/a.spec.ts", "content": "test('x', async () => {});"},
            ]
        }
    )
    files = parse_e2e_files_from_raw(raw)
    assert len(files) == 2


def test_resolve_e2e_file_paths_under_aitest():
    files = [
        E2EFile(path="pages/login.page.ts", content="p", kind="page"),
        E2EFile(path="specs/login.spec.ts", content="s", kind="spec"),
    ]
    resolved = resolve_e2e_file_paths(files, module="Auth", journey_slug="login")
    assert resolved[0].path == "AItest/E2ETest/Auth/pages/login.page.ts"
    assert resolved[1].path == "AItest/E2ETest/Auth/specs/login.spec.ts"
    assert e2e_module_root("Auth") == "AItest/E2ETest/Auth"


def test_resolve_e2e_file_paths_with_requirement_tc():
    """E2E layout mirrors Unit: AItest/E2ETest/{Requirement}/{TC}/specs/…"""
    files = [
        E2EFile(path="pages/login.page.ts", content="p", kind="page"),
        E2EFile(path="specs/login.spec.ts", content="s", kind="spec"),
    ]
    resolved = resolve_e2e_file_paths(
        files,
        module="Auth",
        requirement_title="Đăng nhập",
        test_case_title="TC01 - Login thành công",
    )
    assert resolved[0].path == "AItest/E2ETest/Đăng nhập/TC01 - Login thành công/pages/login.page.ts"
    assert resolved[1].path == "AItest/E2ETest/Đăng nhập/TC01 - Login thành công/specs/login.spec.ts"
    assert e2e_module_root(
        "Auth",
        requirement_title="Đăng nhập",
        test_case_title="TC01 - Login thành công",
    ) == "AItest/E2ETest/Đăng nhập/TC01 - Login thành công"


def test_e2e_module_root_fallback_module():
    """Without requirement/tc, fallback to legacy module."""
    assert e2e_module_root("Auth") == "AItest/E2ETest/Auth"
    assert e2e_module_root("", requirement_title="Req1") == "AItest/E2ETest/Req1"


def test_ensure_playwright_config():
    files = [E2EFile(path="AItest/E2ETest/Auth/specs/a.spec.ts", content="x", kind="spec")]
    out = ensure_playwright_config(files, module="Auth", target_url="http://localhost:5173")
    assert any(f.kind == "config" for f in out)
    assert any(
        f.path.replace("\\", "/").endswith("fixtures/global.setup.ts") for f in out
    )
    assert "baseURL" in default_playwright_config(base_url="http://x")
    assert "globalSetup: './fixtures/global.setup.ts'" in default_playwright_config(
        base_url="http://x"
    )


def test_ensure_playwright_config_places_global_setup_next_to_config():
    files = [
        E2EFile(
            path="AItest/E2ETest/Req A/TC B/specs/a.spec.ts",
            content="test('a', async () => {})",
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Req A/TC B/playwright.config.ts",
            content="export default defineConfig({ testDir: './specs' });",
            kind="config",
        ),
    ]
    out = ensure_playwright_config(
        files,
        module="Login",
        requirement_title="Req A",
        test_case_title="TC B",
        target_url="http://localhost:5174",
    )
    setup = next(
        f for f in out if f.path.replace("\\", "/").endswith("fixtures/global.setup.ts")
    )
    assert setup.path.replace("\\", "/").startswith("AItest/E2ETest/Req A/TC B/")


def test_build_e2e_heal_prompt_context():
    ctx = build_e2e_heal_prompt_context(
        primary_spec_path="AItest/E2ETest/Auth/specs/login.spec.ts",
        run_command=["npx", "playwright", "test"],
        error_log="TimeoutError: locator.click",
        attempt=1,
        max_retries=3,
    )
    assert "Auto-Heal attempt 1/3" in ctx
    assert "TimeoutError" in ctx


def test_sandbox_auto_heal_succeeds_on_second_attempt(tmp_path):
    orch = E2EOrchestrator(str(tmp_path), module="Auth")
    calls = {"run": 0, "fix": 0}
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/pages/login.page.ts",
            content="export class LoginPage { bad }",
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login.spec.ts",
            content="test('login', async () => {})",
            kind="spec",
        ),
    ]

    async def run_fn(cmd, cwd):
        calls["run"] += 1
        if calls["run"] == 1:
            return 1, "TimeoutError: element not found"
        return 0, "ok"

    async def fix_fn(req, repair_ctx):
        calls["fix"] += 1
        assert "TimeoutError" in repair_ctx
        return """
### FILE: AItest/E2ETest/Auth/pages/login.page.ts
```ts
export class LoginPage { ok() {} }
```
"""

    result = asyncio.run(
        orch.execute_sandbox_and_auto_heal(
            files=files,
            primary_spec_path="AItest/E2ETest/Auth/specs/login.spec.ts",
            req=_req(),
            max_retries=3,
            run_fn=run_fn,
            fix_fn=fix_fn,
            write_file=True,
        )
    )
    assert result.status == "PASSED"
    assert result.attempts == 2
    assert calls["fix"] == 1
    page = next(f for f in result.files if f.kind == "page")
    assert "ok()" in page.content


def test_sandbox_auto_heal_fails_after_max(tmp_path):
    orch = E2EOrchestrator(str(tmp_path))

    async def run_fn(cmd, cwd):
        return 1, "always fail"

    async def fix_fn(req, repair_ctx):
        return "### FILE: specs/x.spec.ts\n```ts\nstill bad\n```"

    result = asyncio.run(
        orch.execute_sandbox_and_auto_heal(
            files=[
                E2EFile(path="AItest/E2ETest/x/specs/x.spec.ts", content="bad", kind="spec")
            ],
            primary_spec_path="AItest/E2ETest/x/specs/x.spec.ts",
            req=_req(module=""),
            max_retries=3,
            run_fn=run_fn,
            fix_fn=fix_fn,
            write_file=False,
        )
    )
    assert result.status == "FAILED"
    assert result.attempts == 3


def test_parse_html_interactive():
    html = '<button data-testid="submit" aria-label="Save">Save</button><input name="email" />'
    els = parse_html_interactive(html)
    assert any(e.test_id == "submit" for e in els)
    assert any(e.tag == "input" for e in els)


def test_parse_source_interactive():
    src = 'path: "/login"\n<button data-testid="go">Go</button>'
    els, routes = parse_source_interactive(src)
    assert "/login" in routes
    assert any(e.test_id == "go" for e in els)


def test_exc_detail_not_implemented_empty_message():
    detail = exc_detail(NotImplementedError())
    assert "NotImplementedError" in detail


def test_resolve_e2e_work_cwd_uses_config_dir(tmp_path):
    cfg = "AItest/E2ETest/Auth/playwright.config.ts"
    spec = "AItest/E2ETest/Auth/specs/login.spec.ts"
    (tmp_path / "AItest/E2ETest/Auth/specs").mkdir(parents=True)
    (tmp_path / cfg).write_text("export default {}", encoding="utf-8")
    (tmp_path / spec).write_text("test('x', async () => {})", encoding="utf-8")
    work, spec_arg, config_arg = resolve_e2e_work_cwd(
        str(tmp_path), config_rel=cfg, primary_spec_path=spec
    )
    assert work.replace("\\", "/").endswith("AItest/E2ETest/Auth")
    assert spec_arg.replace("\\", "/") == "specs/login.spec.ts"
    assert config_arg is not None
    assert config_arg.replace("\\", "/").endswith("AItest/E2ETest/Auth/playwright.config.ts")
    assert Path(config_arg).is_absolute()


def test_resolve_e2e_work_cwd_unicode_module(tmp_path):
    mod = "Yêu cầu API Backend"
    cfg = f"AItest/E2ETest/{mod}/playwright.config.ts"
    spec = f"AItest/E2ETest/{mod}/specs/get-all-todos.spec.ts"
    (tmp_path / f"AItest/E2ETest/{mod}/specs").mkdir(parents=True)
    (tmp_path / cfg).write_text("export default {}", encoding="utf-8")
    (tmp_path / spec).write_text("x", encoding="utf-8")
    work, spec_arg, _ = resolve_e2e_work_cwd(
        str(tmp_path), config_rel=cfg, primary_spec_path=spec
    )
    assert mod in work
    assert spec_arg.replace("\\", "/") == "specs/get-all-todos.spec.ts"


def test_sanitize_playwright_env_strips_cursor_sandbox_cache():
    env = {
        "PLAYWRIGHT_BROWSERS_PATH": r"C:\Users\x\AppData\Local\Temp\cursor-sandbox-cache\abc\playwright",
        "PATH": "/usr/bin",
    }
    out = _sanitize_playwright_env(dict(env))
    # Bad sandbox path removed; may be replaced by real Local\ms-playwright if present
    assert "cursor-sandbox-cache" not in (out.get("PLAYWRIGHT_BROWSERS_PATH") or "")


def test_merge_env_does_not_keep_empty_sandbox_override(monkeypatch, tmp_path):
    monkeypatch.setenv(
        "PLAYWRIGHT_BROWSERS_PATH",
        str(tmp_path / "cursor-sandbox-cache" / "playwright"),
    )
    # empty dir → not usable
    (tmp_path / "cursor-sandbox-cache" / "playwright").mkdir(parents=True)
    out = _merge_env()
    assert "cursor-sandbox-cache" not in (out.get("PLAYWRIGHT_BROWSERS_PATH") or "")


def test_check_playwright_ready_missing(tmp_path):
    check = check_playwright_ready(str(tmp_path))
    # Environment may have shared AITest runner pre-installed.
    if check.ok:
        assert check.source in ("aitest", "project")
    else:
        assert "Playwright" in check.message or "npx" in check.message
        assert PLAYWRIGHT_INSTALL_HINT.split("npm")[0] in check.message or "npx" in check.message.lower() or "@playwright" in check.message


def test_check_playwright_ready_with_package(tmp_path):
    nm = tmp_path / "node_modules" / "@playwright" / "test"
    nm.mkdir(parents=True)
    (nm / "package.json").write_text("{}", encoding="utf-8")
    check = check_playwright_ready(str(tmp_path))
    # ok only if npx also on PATH
    if shutil.which("npx") or shutil.which("npx.cmd"):
        assert check.ok is True
        assert check.package_root is not None
    else:
        assert check.has_package is True
        assert check.ok is False


def test_check_playwright_ready_finds_frontend_subdir(tmp_path):
    fe = tmp_path / "frontend"
    nm = fe / "node_modules" / "@playwright" / "test"
    nm.mkdir(parents=True)
    (nm / "package.json").write_text("{}", encoding="utf-8")
    check = check_playwright_ready(str(tmp_path))
    assert check.has_package is True
    assert check.package_root is not None
    assert "frontend" in check.package_root.replace("\\", "/")
    if shutil.which("npx") or shutil.which("npx.cmd"):
        assert check.ok is True


def test_require_playwright_raises(tmp_path):
    orch = E2EOrchestrator(str(tmp_path), module="Auth")

    async def run_fn(cmd, cwd):
        return 0, "ok"

    # require_playwright True but no package — raises before run when run_fn is None
    # With run_fn injected, require still checks when run_command is None and run_fn is None
    # Here we pass run_fn so check is skipped... actually require_playwright and run_fn is None
    try:
        asyncio.run(
            orch.execute_sandbox_and_auto_heal(
                files=[
                    E2EFile(
                        path="AItest/E2ETest/Auth/specs/a.spec.ts",
                        content="test('a', async () => {})",
                        kind="spec",
                    )
                ],
                primary_spec_path="AItest/E2ETest/Auth/specs/a.spec.ts",
                req=_req(),
                max_retries=1,
                write_file=True,
                require_playwright=True,
            )
        )
        # If npx+package somehow present in tmp, skip
        check = check_playwright_ready(str(tmp_path))
        if not check.ok:
            raise AssertionError("expected RuntimeError for missing Playwright")
    except RuntimeError as exc:
        assert "Playwright" in str(exc)


def test_default_playwright_config_headed_has_visible_slow_mo():
    from app.llm.base import default_playwright_config

    headed = default_playwright_config(base_url="http://x", headed=True)
    assert "headless: false" in headed
    assert "slowMo: 500" in headed
    assert "video: 'on'" in headed

    headless = default_playwright_config(base_url="http://x", headed=False)
    assert "headless: true" in headless
    assert "slowMo" not in headless
    assert "retain-on-failure" in headless


def test_default_playwright_config_normalizes_storage_state_relative():
    cfg = default_playwright_config(
        base_url="http://x",
        storage_state_rel="AItest/E2ETest/Auth/fixtures/storageState.json",
    )
    assert 'storageState: "./fixtures/storageState.json"' in cfg
    assert "AItest/E2ETest/Auth/fixtures/storageState.json" not in cfg


def test_extract_playwright_env_from_aitest_body():
    from app.services.e2e_orchestrator import extract_playwright_env

    env = extract_playwright_env(
        {
            "targetUrl": "http://localhost:5173/",
            "e2eUsername": "a@b.com",
            "e2ePassword": "secret",
            "playwrightEnv": {"E2E_STORAGE_STATE": "./fixtures/storageState.json", "PATH": "hack"},
        }
    )
    assert env["E2E_USERNAME"] == "a@b.com"
    assert env["E2E_PASSWORD"] == "secret"
    assert env["E2E_BASE_URL"] == "http://localhost:5173"
    assert env["E2E_STORAGE_STATE"] == "./fixtures/storageState.json"
    assert "PATH" not in env


def test_default_playwright_run_command_headed():
    from app.services.e2e_orchestrator import apply_headed_flag, default_playwright_run_command

    bare = default_playwright_run_command("specs/a.spec.ts")
    assert "--headed" not in bare
    headed = default_playwright_run_command("specs/a.spec.ts", headed=True)
    assert "--headed" in headed
    assert apply_headed_flag(bare, headed=True).count("--headed") == 1
    assert "--headed" not in apply_headed_flag(headed, headed=False)


def test_parse_playwright_json_report_per_spec():
    from pathlib import Path

    report = {
        "suites": [
            {
                "specs": [
                    {
                        "file": "specs/a.spec.ts",
                        "title": "a",
                        "tests": [{"results": [{"status": "passed"}]}],
                    },
                    {
                        "file": "specs/b.spec.ts",
                        "title": "b",
                        "tests": [
                            {
                                "results": [
                                    {
                                        "status": "failed",
                                        "error": {"message": "Timeout"},
                                    }
                                ]
                            }
                        ],
                    },
                ]
            }
        ]
    }
    parsed = parse_playwright_json_report(json.dumps(report))
    assert len(parsed) == 2
    by = {Path(p.spec_path).name: p for p in parsed}
    assert by["a.spec.ts"].success is True
    assert by["b.spec.ts"].success is False
    assert "Timeout" in by["b.spec.ts"].error_excerpt


def test_execute_module_headless_maps_specs(tmp_path):
    from pathlib import Path

    orch = E2EOrchestrator(str(tmp_path), module="Auth")
    report = {
        "suites": [
            {
                "specs": [
                    {
                        "file": "specs/a.spec.ts",
                        "title": "a",
                        "tests": [{"results": [{"status": "passed"}]}],
                    },
                    {
                        "file": "specs/b.spec.ts",
                        "title": "b",
                        "tests": [
                            {
                                "results": [
                                    {"status": "failed", "error": {"message": "x"}}
                                ]
                            }
                        ],
                    },
                ]
            }
        ]
    }

    async def run_fn(cmd, cwd):
        assert any("specs" in str(c) for c in cmd)
        return 1, json.dumps(report)

    result = asyncio.run(
        orch.execute_module_headless(
            files=[
                E2EFile(
                    path="AItest/E2ETest/Auth/specs/a.spec.ts",
                    content="test('a', async () => {})",
                    kind="spec",
                ),
                E2EFile(
                    path="AItest/E2ETest/Auth/specs/b.spec.ts",
                    content="test('b', async () => {})",
                    kind="spec",
                ),
            ],
            module="Auth",
            run_fn=run_fn,
            write_file=True,
            require_playwright=False,
        )
    )
    assert result.status == "FAILED"
    assert len(result.specs) == 2
    by = {Path(s.spec_path).name: s for s in result.specs}
    assert by["a.spec.ts"].success is True
    assert by["b.spec.ts"].success is False


def test_execute_module_headless_isolates_tc_folders(tmp_path):
    """TC1 fail must not mark TC2 fail — each folder runs independently."""
    from pathlib import Path

    from app.services.e2e_orchestrator import _group_files_by_run_root

    files = [
        E2EFile(
            path="AItest/E2ETest/Req/TC1/playwright.config.ts",
            content="export default {}",
            kind="config",
        ),
        E2EFile(
            path="AItest/E2ETest/Req/TC1/specs/token-refresh-failure.spec.ts",
            content="test('t1', async () => {})",
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Req/TC2/playwright.config.ts",
            content="export default {}",
            kind="config",
        ),
        E2EFile(
            path="AItest/E2ETest/Req/TC2/specs/update-todo-missing-on-save.spec.ts",
            content="test('t2', async () => {})",
            kind="spec",
        ),
    ]
    groups = _group_files_by_run_root(files)
    assert len(groups) == 2

    fail_report = {
        "suites": [
            {
                "specs": [
                    {
                        "file": "specs/token-refresh-failure.spec.ts",
                        "title": "t1",
                        "tests": [
                            {
                                "results": [
                                    {
                                        "status": "failed",
                                        "error": {
                                            "message": "expect(received).toBeLessThanOrEqual(expected)"
                                        },
                                    }
                                ]
                            }
                        ],
                    }
                ]
            }
        ]
    }
    pass_report = {
        "suites": [
            {
                "specs": [
                    {
                        "file": "specs/update-todo-missing-on-save.spec.ts",
                        "title": "t2",
                        "tests": [{"results": [{"status": "passed"}]}],
                    }
                ]
            }
        ]
    }
    calls: list[str] = []

    async def run_fn(cmd, cwd):
        calls.append(str(cwd).replace("\\", "/"))
        if cwd.replace("\\", "/").endswith("/TC1"):
            return 1, json.dumps(fail_report)
        return 0, json.dumps(pass_report)

    orch = E2EOrchestrator(str(tmp_path), module="Req")
    result = asyncio.run(
        orch.execute_module_headless(
            files=files,
            module="Req",
            run_fn=run_fn,
            write_file=True,
            require_playwright=False,
        )
    )
    assert len(calls) == 2, f"expected 2 isolated runs, got {calls}"
    assert result.status == "FAILED"
    by = {Path(s.spec_path).name: s for s in result.specs}
    assert by["token-refresh-failure.spec.ts"].success is False
    assert "toBeLessThanOrEqual" in (by["token-refresh-failure.spec.ts"].error_excerpt or "")
    assert by["update-todo-missing-on-save.spec.ts"].success is True
    assert "toBeLessThanOrEqual" not in (
        by["update-todo-missing-on-save.spec.ts"].error_excerpt or ""
    )


def test_runtime_fix_missing_storage_state_strips_config(tmp_path):
    mod = tmp_path / "AItest" / "E2ETest" / "Auth"
    mod.mkdir(parents=True)
    cfg = mod / "playwright.config.ts"
    cfg.write_text(
        "export default defineConfig({\n"
        "  use: {\n"
        "    baseURL: 'http://localhost:3000',\n"
        "    storageState: './fixtures/storageState.json',\n"
        "  },\n"
        "});\n",
        encoding="utf-8",
    )
    _runtime_fix_missing_storage_state(str(mod), config_arg=None)
    out = cfg.read_text(encoding="utf-8")
    assert "storageState" not in out


def test_inject_node_path_for_prefixed_playwright_sets_runner_node_modules():
    env = {}
    cmd = [
        "npx",
        "-y",
        "--prefix",
        "C:/Users/test/.aitest/playwright-runner",
        "playwright",
        "test",
    ]
    out = _inject_node_path_for_prefixed_playwright(env, cmd)
    assert out.get("NODE_PATH", "").replace("\\", "/").endswith(
        "/.aitest/playwright-runner/node_modules"
    )


def test_inject_node_path_for_prefixed_playwright_keeps_existing_entries():
    env = {"NODE_PATH": "D:/custom/node_modules"}
    cmd = [
        "npx",
        "--prefix",
        "C:/Users/test/.aitest/playwright-runner",
        "playwright",
        "test",
    ]
    out = _inject_node_path_for_prefixed_playwright(env, cmd)
    node_path = out.get("NODE_PATH", "").replace("\\", "/")
    assert "/.aitest/playwright-runner/node_modules" in node_path
    assert "D:/custom/node_modules" in node_path
