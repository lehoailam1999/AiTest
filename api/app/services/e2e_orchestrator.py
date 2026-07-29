"""
E2E Sandbox Auto-Heal Orchestrator — Playwright TS MVP.

Vòng lặp: ghi multi-file (POM/spec) → npx playwright test → fail thì AI heal selector → ≤ N lần.
Desktop staging dùng autoHealLoop.ts; module này phục vụ BE (projectRoot cùng máy)
và unit test với runner/fix injectable.

XP0: Windows-safe spawn (resolve_command + Popen/sync fallback), cwd = config dir,
Playwright presence check, non-empty exception details.
"""

from __future__ import annotations

import asyncio
import json
import logging
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path
from typing import Awaitable, Callable, Sequence

from app.llm.base import (
    E2EFile,
    E2ERequest,
    default_playwright_config,
    parse_e2e_files_from_raw,
)
from app.llm.cli.process_runner import _CREATE_NO_WINDOW, _exc_detail, resolve_command
from app.models.domain import AiBackendConnection
from app.services.test_output_layout import e2e_module_root, resolve_e2e_file_paths

logger = logging.getLogger(__name__)

# Mặc định chạy 1 lần theo UX hiện tại (không auto-heal lặp).
DEFAULT_MAX_RETRIES = 1
LOG_TAIL = 2500
# Ceiling per Playwright process — tránh treo gần 1h khi SPA/networkidle/AI hang
DEFAULT_PW_RUN_TIMEOUT_SEC = int(os.environ.get("AITEST_E2E_PW_TIMEOUT_SEC", "300"))
DEFAULT_SEED_TIMEOUT_SEC = int(os.environ.get("AITEST_E2E_SEED_TIMEOUT_SEC", "120"))

PLAYWRIGHT_INSTALL_HINT = (
    "Cài Playwright trong project root: "
    "npm i -D @playwright/test && npx playwright install chromium"
)

_GLOBAL_SETUP_TS = """\
/// <reference path="../types/playwright-shim.d.ts" />
import fs from 'node:fs';
import path from 'node:path';
import { chromium, type FullConfig } from '@playwright/test';

function roleCreds(): { user: string; pass: string } {
  const roleHint = (process.env.E2E_ROLE || process.env.E2E_AUTH_ROLE || 'default').trim();
  const slug = roleHint.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const roleUser = slug ? (process.env[`E2E_${slug}_USERNAME`] || '').trim() : '';
  const rolePass = slug ? (process.env[`E2E_${slug}_PASSWORD`] || '').trim() : '';
  const user = (roleUser || process.env.E2E_USERNAME || '').trim();
  const pass = (rolePass || process.env.E2E_PASSWORD || '').trim();
  return { user, pass };
}

async function doLogin(page: any): Promise<void> {
  const { user, pass } = roleCreds();
  if (!user || !pass) return;

  const loginHeading = page.getByRole('heading', {
    name: /đăng\\s*nhập|sign\\s*in|log\\s*in|login/i,
  }).first();
  const email = page.getByRole('textbox', { name: /email|e-?mail|tài khoản|username/i }).first();
  const password = page
    .getByRole('textbox', { name: /password|mật khẩu|passwd/i })
    .or(page.locator('input[type="password"]'))
    .first();
  const loginBtn = page
    .locator('form')
    .getByRole('button', { name: /đăng\\s*nhập|log\\s*in|sign\\s*in/i })
    .first();
  const loginTab = page.getByRole('tab', { name: /đăng\\s*nhập|log\\s*in|sign\\s*in/i }).first();

  const onLoginWall =
    (await email.isVisible().catch(() => false)) ||
    (await loginHeading.isVisible().catch(() => false));
  if (!onLoginWall) return;

  if (await loginTab.isVisible().catch(() => false)) {
    await loginTab.click().catch(() => undefined);
  }
  await email.fill(user);
  await password.fill(pass);
  await password.blur().catch(() => undefined);
  await loginBtn.click().catch(() => undefined);
  await page.waitForTimeout(1000);
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const setupPath = __filename.replace(/\\\\/g, '/');
  const fixturesDir = path.dirname(setupPath);
  const statePath = path.join(fixturesDir, 'storageState.json');
  const cwdStatePath = path.join(process.cwd(), 'fixtures', 'storageState.json');

  // Reuse previously generated state by default for faster startup.
  if (
    (fs.existsSync(statePath) || fs.existsSync(cwdStatePath)) &&
    !process.env.AITEST_FORCE_AUTH_SETUP
  ) {
    return;
  }

  const projectUse = (config.projects?.[0]?.use || {}) as Record<string, unknown>;
  const baseURL =
    (process.env.E2E_BASE_URL || String(projectUse.baseURL || 'http://localhost:3000')).replace(/\\/$/, '');

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    await page.goto(baseURL || 'http://localhost:3000', { waitUntil: 'domcontentloaded', timeout: 30000 });
    await doLogin(page);
    fs.mkdirSync(fixturesDir, { recursive: true });
    fs.mkdirSync(path.dirname(cwdStatePath), { recursive: true });
    await page.context().storageState({ path: statePath });
    // Playwright sometimes resolves storageState relative to process cwd.
    if (cwdStatePath !== statePath) {
      await page.context().storageState({ path: cwdStatePath });
    }
  } finally {
    await browser.close();
  }
}
"""

RunCommandFn = Callable[[Sequence[str], str], Awaitable[tuple[int, str]]]
FixE2EFn = Callable[[E2ERequest, str], Awaitable[str]]


@dataclass
class E2ESandboxAttempt:
    attempt: int
    exit_code: int
    success: bool
    log_excerpt: str


@dataclass
class E2ESandboxHealResult:
    status: str  # PASSED | FAILED
    primary_spec_path: str
    files: list[E2EFile]
    attempts: int
    error_log: str | None = None
    history: list[E2ESandboxAttempt] = field(default_factory=list)
    run_command: list[str] = field(default_factory=list)
    work_cwd: str | None = None


@dataclass
class E2ESpecRunResult:
    spec_path: str
    success: bool
    title: str = ""
    error_excerpt: str = ""


@dataclass
class E2EModuleRunResult:
    status: str  # PASSED | FAILED
    files: list[E2EFile] = field(default_factory=list)
    work_cwd: str | None = None
    run_command: list[str] = field(default_factory=list)
    log: str = ""
    specs: list[E2ESpecRunResult] = field(default_factory=list)


@dataclass
class PlaywrightCheck:
    ok: bool
    message: str
    has_package: bool
    has_npx: bool
    # Dir that contains node_modules/@playwright/test (may be a monorepo package).
    package_root: str | None = None
    checked_root: str = ""
    # project | aitest | none
    source: str = "none"


_SKIP_DIR_NAMES = frozenset(
    {
        "node_modules",
        ".git",
        ".ai-test",
        "AItest",
        "dist",
        "build",
        "coverage",
        ".next",
        ".turbo",
        "out",
        "target",
        "__pycache__",
        ".venv",
        "venv",
    }
)


def find_playwright_package_root(project_root: str) -> Path | None:
    """Locate dir with node_modules/@playwright/test (root + shallow children)."""
    root = Path(project_root)
    if not root.is_dir():
        return None

    def _has_pw(p: Path) -> bool:
        return (p / "node_modules" / "@playwright" / "test").is_dir()

    if _has_pw(root):
        return root

    candidates: list[Path] = []
    try:
        for child in sorted(root.iterdir(), key=lambda p: p.name.lower()):
            if not child.is_dir() or child.name in _SKIP_DIR_NAMES:
                continue
            candidates.append(child)
            if child.name.lower() in {
                "apps",
                "packages",
                "frontend",
                "client",
                "web",
                "src",
                "services",
            }:
                try:
                    for sub in child.iterdir():
                        if sub.is_dir() and sub.name not in _SKIP_DIR_NAMES:
                            candidates.append(sub)
                except OSError:
                    pass
    except OSError:
        return None

    for c in candidates:
        if _has_pw(c):
            return c
    return None


def exc_detail(exc: BaseException) -> str:
    """Public wrapper — NotImplementedError() often has empty str()."""
    return _exc_detail(exc)


def extract_code_block(text: str) -> str:
    """Ưu tiên fence ```; fallback strip."""
    from app.llm.base import strip_code_fences

    match = re.search(r"```(?:\w+)?\n(.*?)```", text, re.DOTALL)
    if match:
        return match.group(1).strip()
    return strip_code_fences(text).strip()


def build_e2e_heal_prompt_context(
    *,
    primary_spec_path: str,
    run_command: Sequence[str],
    error_log: str,
    attempt: int,
    max_retries: int,
    dom_snapshot: str = "",
) -> str:
    cmd = " ".join(run_command)
    dom_part = ""
    if dom_snapshot.strip():
        dom_part = (
            f"\nDOM / elements snapshot lúc lỗi:\n```\n{dom_snapshot.strip()[-4000:]}\n```\n"
        )
    extra_hint = ""
    low_log = (error_log or "").lower()
    if "strict mode violation" in low_log:
        extra_hint = (
            "\nSTRICT-MODE HEAL RULE (BẮT BUỘC):\n"
            "- Lỗi do locator khớp nhiều phần tử. KHÔNG retry cùng selector cũ.\n"
            "- Bắt buộc rewrite locator có scope theo container đúng ngữ cảnh (form/region/dialog/section gần hành động).\n"
            "- Auth tab UI: tab «Đăng nhập» và submit «Đăng nhập» trùng tên → dùng page.locator('form').getByRole('button', { name }).\n"
            "- Ưu tiên locator ổn định theo testId/aria-label/name trong source/DOM snapshot.\n"
            "- Nếu đang dùng getByRole(name) mơ hồ, thêm scope hoặc filter để còn đúng 1 phần tử.\n"
            "- Cập nhật Page Object trước, rồi đồng bộ Spec gọi đúng method đã có.\n"
        )
    if "is not a function" in low_log:
        extra_hint += (
            "\nMETHOD-CONTRACT HEAL RULE (BẮT BUỘC):\n"
            "- Nếu Spec gọi method không tồn tại ở Page Object, phải thêm method đó hoặc đổi Spec sang method đã tồn tại.\n"
            "- Sau khi sửa, đảm bảo mọi method được gọi trong Spec đều có implementation thật.\n"
        )
    if "tohaveurl" in low_log and "expected pattern" in low_log:
        extra_hint += (
            "\nURL-ASSERT HEAL RULE (BẮT BUỘC):\n"
            "- Không dùng URL regex fallback/hardcode không có trong input.\n"
            "- Suy luận URL đích từ test case/source. Nếu không chắc URL, verify bằng UI outcome ổn định thay vì đoán route.\n"
        )

    return (
        f"E2E Auto-Heal attempt {attempt}/{max_retries}\n"
        f"Primary spec: {primary_spec_path}\n"
        f"Command: {cmd}\n\n"
        f"Log lỗi (đuôi):\n```\n{error_log[-LOG_TAIL:]}\n```\n"
        f"{dom_part}\n"
        "Phân tích nếu do gãy Selector / element not found / TimeoutError. "
        "Sửa Page Object (ưu tiên) hoặc Spec; trả về các FILE đã sửa theo format ### FILE:."
        f"{extra_hint}"
    )


def parse_playwright_json_report(log: str) -> list[E2ESpecRunResult]:
    """Best-effort parse Playwright --reporter=json stdout into per-spec results."""
    text = (log or "").strip()
    if not text:
        return []

    def try_load(raw: str) -> dict | None:
        try:
            data = json.loads(raw)
        except Exception:  # noqa: BLE001
            return None
        return data if isinstance(data, dict) else None

    data = try_load(text)
    if data is None:
        # Prefer outermost JSON object (first `{` … matching `}`)
        start = text.find("{")
        if start < 0:
            return []
        raw = text[start:]
        depth = 0
        end = -1
        for i, ch in enumerate(raw):
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    end = i + 1
                    break
        if end < 0:
            return []
        data = try_load(raw[:end])
        if data is None:
            return []

    out: list[E2ESpecRunResult] = []

    def walk_suite(suite: dict) -> None:
        for spec in suite.get("specs") or []:
            if not isinstance(spec, dict):
                continue
            file_rel = str(spec.get("file") or spec.get("title") or "").replace("\\", "/")
            title = str(spec.get("title") or "")
            ok = True
            err = ""
            for t in spec.get("tests") or []:
                if not isinstance(t, dict):
                    continue
                for r in t.get("results") or []:
                    if not isinstance(r, dict):
                        continue
                    st = str(r.get("status") or "").lower()
                    if st and st not in ("passed", "skipped", "expected"):
                        ok = False
                        err = str(
                            r.get("error", {}).get("message")
                            if isinstance(r.get("error"), dict)
                            else r.get("error") or st
                        )[:500]
            if file_rel:
                out.append(
                    E2ESpecRunResult(
                        spec_path=file_rel,
                        success=ok,
                        title=title,
                        error_excerpt=err,
                    )
                )
        for child in suite.get("suites") or []:
            if isinstance(child, dict):
                walk_suite(child)

    if isinstance(data.get("suites"), list):
        for s in data["suites"]:
            if isinstance(s, dict):
                walk_suite(s)
    return out


def check_playwright_ready(project_root: str) -> PlaywrightCheck:
    """XP0.3 — detect @playwright/test under project (or package) + npx on PATH."""
    root = Path(project_root)
    checked = str(root)
    has_npx = bool(shutil.which("npx") or shutil.which("npx.cmd"))
    pkg_root = find_playwright_package_root(project_root)
    has_package = pkg_root is not None

    listed = False
    listed_at: str | None = None
    pkg_json = root / "package.json"
    if pkg_json.is_file():
        try:
            pkg_text = pkg_json.read_text(encoding="utf-8", errors="replace")
            if "@playwright/test" in pkg_text or '"playwright"' in pkg_text:
                listed = True
                listed_at = str(root)
        except OSError:
            listed = False
    if not listed and not has_package:
        try:
            for child in root.iterdir():
                if not child.is_dir() or child.name in _SKIP_DIR_NAMES:
                    continue
                pj = child / "package.json"
                if not pj.is_file():
                    continue
                try:
                    pkg_text = pj.read_text(encoding="utf-8", errors="replace")
                except OSError:
                    continue
                if "@playwright/test" in pkg_text or '"playwright"' in pkg_text:
                    listed = True
                    listed_at = str(child)
                    break
        except OSError:
            pass

    if has_package and has_npx:
        where = str(pkg_root) if pkg_root else checked
        same = False
        try:
            same = bool(pkg_root and pkg_root.resolve() == root.resolve())
        except OSError:
            same = pkg_root is not None and str(pkg_root) == checked
        note = (
            "Playwright ready (project)"
            if same
            else f"Playwright ready (project · `{where}`)"
        )
        return PlaywrightCheck(
            ok=True,
            message=note,
            has_package=True,
            has_npx=True,
            package_root=str(pkg_root) if pkg_root else None,
            checked_root=checked,
            source="project",
        )

    # Fallback: shared AITest runner (~/.aitest/playwright-runner)
    from app.services.aitest_playwright_runner import probe_shared_runner

    shared = probe_shared_runner()
    if shared.ok and has_npx:
        return PlaywrightCheck(
            ok=True,
            message=shared.message,
            has_package=True,
            has_npx=True,
            package_root=shared.runner_dir,
            checked_root=checked,
            source="aitest",
        )

    parts: list[str] = []
    if not has_npx:
        parts.append(
            "Không tìm thấy `npx` trên PATH của process API (cần Node.js/npm; "
            "restart API sau khi cài Node)."
        )
    if not has_package:
        if listed:
            parts.append(
                f"package.json tại `{listed_at or checked}` có Playwright nhưng chưa "
                f"`npm install` (thiếu node_modules/@playwright/test)."
            )
        else:
            parts.append(
                f"Project chưa có @playwright/test dưới `{checked}`. "
                f"Khuyến nghị: bấm «Cài Playwright trên AITest» (Chromium dùng chung), "
                f"hoặc cài vào project: {PLAYWRIGHT_INSTALL_HINT}"
            )
        if not shared.installed:
            parts.append(shared.message)
    return PlaywrightCheck(
        ok=False,
        message=" ".join(parts) or PLAYWRIGHT_INSTALL_HINT,
        has_package=has_package,
        has_npx=has_npx,
        package_root=str(pkg_root) if pkg_root else None,
        checked_root=checked,
        source="none",
    )


def _merge_env(env_extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return env


def _inject_node_path_for_prefixed_playwright(
    env: dict[str, str], cmd: Sequence[str]
) -> dict[str, str]:
    """
    When using `npx --prefix <runner> playwright ...`, config may live outside project
    tree (`.ai-test/workspace/...`) so Node cannot resolve '@playwright/test' by default.
    Inject runner node_modules into NODE_PATH for deterministic resolution.
    """
    parts = [str(x) for x in (cmd or [])]
    low = [p.lower() for p in parts]
    if "playwright" not in low:
        return env
    try:
        idx = low.index("--prefix")
    except ValueError:
        return env
    if idx + 1 >= len(parts):
        return env
    node_mod = str(Path(parts[idx + 1]) / "node_modules")
    current = str(env.get("NODE_PATH") or "").strip()
    if current:
        segs = [s for s in current.split(os.pathsep) if s]
        if node_mod not in segs:
            env["NODE_PATH"] = os.pathsep.join([node_mod, *segs])
    else:
        env["NODE_PATH"] = node_mod
    return env


_ALLOWED_E2E_ENV_PREFIX = "E2E_"
_ALLOWED_E2E_ENV_KEYS = frozenset(
    {
        "E2E_USERNAME",
        "E2E_PASSWORD",
        "E2E_BASE_URL",
        "E2E_STORAGE_STATE",
    }
)


def extract_playwright_env(body: dict | None) -> dict[str, str]:
    """
    Credentials / E2E_* from AITest request body — NOT from the SUT .env.
    Whitelist E2E_* keys only (never forward arbitrary host env).
    """
    if not isinstance(body, dict):
        return {}
    out: dict[str, str] = {}
    raw = body.get("playwrightEnv") or body.get("envExtra") or {}
    if isinstance(raw, dict):
        for k, v in raw.items():
            key = str(k or "").strip()
            if not key:
                continue
            if key not in _ALLOWED_E2E_ENV_KEYS and not key.startswith(
                _ALLOWED_E2E_ENV_PREFIX
            ):
                continue
            val = str(v if v is not None else "").strip()
            if val:
                out[key] = val
    user = str(body.get("e2eUsername") or body.get("username") or "").strip()
    password = str(body.get("e2ePassword") or body.get("password") or "").strip()
    if user:
        out["E2E_USERNAME"] = user
    if password:
        out["E2E_PASSWORD"] = password
    base = str(body.get("targetUrl") or "").strip()
    if base and "E2E_BASE_URL" not in out:
        out["E2E_BASE_URL"] = base.rstrip("/")
    return out


def _infer_subprocess_timeout_sec(cmd: Sequence[str]) -> float:
    joined = " ".join(str(x) for x in cmd).lower()
    if "playwright" in joined and "test" in joined:
        return float(DEFAULT_PW_RUN_TIMEOUT_SEC)
    return float(DEFAULT_SEED_TIMEOUT_SEC)


def _sync_run_command(
    cmd: Sequence[str],
    cwd: str,
    *,
    env_extra: dict[str, str] | None = None,
    timeout_sec: float | None = None,
) -> tuple[int, str]:
    """Blocking run — used when asyncio subprocess is unavailable (Windows Selector loop)."""
    resolved = resolve_command(list(cmd))
    limit = timeout_sec if timeout_sec is not None else _infer_subprocess_timeout_sec(resolved)
    env = _merge_env(env_extra)
    env = _inject_node_path_for_prefixed_playwright(env, resolved)
    kwargs: dict = {
        "stdout": subprocess.PIPE,
        "stderr": subprocess.PIPE,
        "cwd": cwd or None,
        "env": env,
        "timeout": limit,
    }
    # Windows: CREATE_NO_WINDOW hides Chromium; CREATE_NEW_CONSOLE often resets
    # cwd to System32 (breaks --config discovery). Headed = no creationflags.
    want_gui = "--headed" in resolved
    if sys.platform == "win32" and not want_gui and _CREATE_NO_WINDOW:
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    try:
        completed = subprocess.run(resolved, **kwargs)  # noqa: S603
    except subprocess.TimeoutExpired as exc:
        out = (exc.stdout or b"").decode("utf-8", errors="replace") if isinstance(exc.stdout, (bytes, bytearray)) else (exc.stdout or "")
        err = (exc.stderr or b"").decode("utf-8", errors="replace") if isinstance(exc.stderr, (bytes, bytearray)) else (exc.stderr or "")
        return (
            124,
            f"Command timed out after {int(limit)}s (killed).\n{out}\n{err}".strip(),
        )
    except Exception as exc:  # noqa: BLE001
        detail = exc_detail(exc)
        return 127, f"Failed to start command: {detail}\ncmd={resolved}"
    out = (completed.stdout or b"").decode("utf-8", errors="replace")
    err = (completed.stderr or b"").decode("utf-8", errors="replace")
    return int(completed.returncode or 0), f"{out}\n{err}".strip()


async def _default_run_command(
    cmd: Sequence[str],
    cwd: str,
    *,
    env_extra: dict[str, str] | None = None,
) -> tuple[int, str]:
    """
    XP0.1 — resolve npx.cmd on Windows; fall back to sync subprocess when
    create_subprocess_exec raises NotImplementedError (empty message).
    Always apply a wall-clock ceiling so E2E Job không treo vô hạn.
    """
    if not cmd:
        return 0, "(skip — empty run_command)"
    resolved = resolve_command(list(cmd))
    limit = _infer_subprocess_timeout_sec(resolved)
    kwargs: dict = {
        "cwd": cwd or None,
        "stdout": asyncio.subprocess.PIPE,
        "stderr": asyncio.subprocess.PIPE,
        "env": _inject_node_path_for_prefixed_playwright(
            _merge_env(env_extra), resolved
        ),
    }
    # Windows: CREATE_NO_WINDOW hides Chromium; CREATE_NEW_CONSOLE often resets
    # cwd to System32 (breaks --config discovery). Headed = no creationflags.
    want_gui = "--headed" in resolved
    if sys.platform == "win32" and not want_gui and _CREATE_NO_WINDOW:
        kwargs["creationflags"] = _CREATE_NO_WINDOW
    try:
        proc = await asyncio.create_subprocess_exec(*resolved, **kwargs)
        try:
            stdout_b, stderr_b = await asyncio.wait_for(
                proc.communicate(), timeout=limit
            )
        except asyncio.TimeoutError:
            try:
                proc.kill()
            except ProcessLookupError:
                pass
            try:
                await asyncio.wait_for(proc.wait(), timeout=10)
            except Exception:  # noqa: BLE001
                pass
            return (
                124,
                f"Command timed out after {int(limit)}s (killed). "
                f"cmd={' '.join(resolved[:8])}…",
            )
        out = (stdout_b or b"").decode("utf-8", errors="replace")
        err = (stderr_b or b"").decode("utf-8", errors="replace")
        return int(proc.returncode or 0), f"{out}\n{err}".strip()
    except NotImplementedError as exc:
        logger.warning(
            "asyncio subprocess unavailable (%s) — sync fallback cmd=%s",
            exc_detail(exc),
            resolved[:6],
        )
        return await asyncio.to_thread(
            _sync_run_command, resolved, cwd, env_extra=env_extra, timeout_sec=limit
        )
    except FileNotFoundError as exc:
        detail = exc_detail(exc)
        hint = f"\n{PLAYWRIGHT_INSTALL_HINT}" if "npx" in " ".join(cmd).lower() else ""
        return 127, f"Command not found: {detail} | cmd={resolved}{hint}"
    except OSError as exc:
        detail = exc_detail(exc)
        logger.warning("OSError spawning E2E cmd — sync fallback: %s", detail)
        return await asyncio.to_thread(
            _sync_run_command, resolved, cwd, env_extra=env_extra, timeout_sec=limit
        )


def resolve_e2e_work_cwd(
    project_root: str,
    *,
    config_rel: str | None,
    primary_spec_path: str,
) -> tuple[str, str, str | None]:
    """
    XP0.4 — work_cwd = directory of playwright.config.ts (module root).
    Returns (work_cwd, spec_arg_relative_to_cwd, config_arg_or_None).
    """
    root = Path(project_root).resolve()
    cfg_rel = (config_rel or "").replace("\\", "/").strip()
    spec_rel = primary_spec_path.replace("\\", "/").strip()

    if cfg_rel:
        cfg_abs = (root / cfg_rel).resolve()
        work = cfg_abs.parent
        try:
            spec_arg = str(Path(spec_rel) if Path(spec_rel).is_absolute() else (root / spec_rel).resolve().relative_to(work)).replace(
                "\\", "/"
            )
        except ValueError:
            # Spec outside config dir — keep absolute path
            spec_arg = str((root / spec_rel).resolve())
        # Always pass absolute --config so Playwright never resolves against a
        # broken process.cwd() (seen as PowerShell System32 on Windows headed).
        return str(work), spec_arg, str(cfg_abs)

    # No config: cwd = project root, spec as given
    return str(root), spec_rel, None


def default_playwright_run_command(
    spec_arg: str,
    *,
    config_arg: str | None = None,
    runner_prefix: str | None = None,
    headed: bool = False,
) -> list[str]:
    """
    Build playwright CLI.
    runner_prefix → node <runner>/…/cli.js (project không cần node_modules).
    headed=True → mở cửa sổ Chromium (--headed).
    """
    if runner_prefix:
        from app.services.aitest_playwright_runner import playwright_cli_via_shared_runner

        return playwright_cli_via_shared_runner(
            spec_arg,
            config_arg=config_arg,
            runner_dir=runner_prefix,
            headed=headed,
        )
    # Prefer direct node cli when available under CWD-independent paths later;
    # bare npx is last resort (Windows may wrap via PowerShell).
    cmd = [
        "npx",
        "-y",
        "playwright",
        "test",
        spec_arg.replace("\\", "/"),
        "--reporter=json",
        "--workers=1",
    ]
    if headed:
        cmd.append("--headed")
    if config_arg:
        cmd.extend(["--config", str(Path(config_arg))])
    return cmd


def apply_headed_flag(cmd: Sequence[str], *, headed: bool) -> list[str]:
    """Ensure --headed is present/absent on an existing CLI argv."""
    out = [str(x) for x in cmd]
    has = "--headed" in out
    if headed and not has:
        out.append("--headed")
    elif not headed and has:
        out = [x for x in out if x != "--headed"]
    return out


def _spec_run_root(path: str) -> str:
    """Directory that owns a TC run (parent of specs/ or of playwright.config.ts)."""
    p = path.replace("\\", "/").strip("/")
    low = p.lower()
    if low.endswith("playwright.config.ts"):
        return p.rsplit("/", 1)[0]
    if "/specs/" in low:
        return p.split("/specs/")[0]
    if "/pages/" in low:
        return p.split("/pages/")[0]
    if "/fixtures/" in low:
        return p.split("/fixtures/")[0]
    if "/types/" in low:
        return p.split("/types/")[0]
    return p.rsplit("/", 1)[0] if "/" in p else p


def _group_files_by_run_root(files: list[E2EFile]) -> list[tuple[str, list[E2EFile]]]:
    """
    Group generated E2E files by TC folder.

    New layout puts each TC under its own folder with its own playwright.config.ts.
    Old layout keeps multiple specs under one module root — they stay one group.
    """
    buckets: dict[str, list[E2EFile]] = {}
    for f in files:
        root = _spec_run_root(getattr(f, "path", "") or "")
        if not root:
            continue
        buckets.setdefault(root, []).append(f)
    return sorted(buckets.items(), key=lambda kv: kv[0].lower())


def _map_module_spec_results(
    *,
    specs_rel: list[str],
    parsed: list[E2ESpecRunResult],
    code: int,
    log: str,
) -> list[E2ESpecRunResult]:
    """Map Playwright JSON results onto the specs that belonged to this run root."""
    by_name: dict[str, E2ESpecRunResult] = {}
    for pr in parsed:
        key = Path(pr.spec_path.replace("\\", "/")).name
        prev = by_name.get(key)
        if prev is None:
            by_name[key] = pr
        else:
            by_name[key] = E2ESpecRunResult(
                spec_path=prev.spec_path,
                success=prev.success and pr.success,
                title=prev.title or pr.title,
                error_excerpt=prev.error_excerpt or pr.error_excerpt,
            )

    out: list[E2ESpecRunResult] = []
    for rel in specs_rel:
        name = Path(rel).name
        matched = by_name.get(name)
        if matched is not None:
            out.append(
                E2ESpecRunResult(
                    spec_path=rel,
                    success=matched.success,
                    title=matched.title,
                    error_excerpt=matched.error_excerpt,
                )
            )
        elif parsed:
            # Spec belonged to this run root but was absent from JSON report.
            # Never reuse another TC folder's exit code — groups are isolated.
            out.append(
                E2ESpecRunResult(
                    spec_path=rel,
                    success=code == 0,
                    error_excerpt=(
                        ""
                        if code == 0
                        else "not present in Playwright report for this TC folder"
                    ),
                )
            )
        else:
            ok = code == 0
            out.append(
                E2ESpecRunResult(
                    spec_path=rel,
                    success=ok,
                    error_excerpt="" if ok else (log[-800:] if log else f"exit {code}"),
                )
            )
    return out


async def _run_one_e2e_root(
    *,
    runner: RunCommandFn,
    project_root: str,
    root_rel: str,
    root_files: list[E2EFile],
    headed: bool,
    run_command: Sequence[str] | None,
    runner_prefix: str | None,
) -> tuple[list[E2ESpecRunResult], list[str], str, str | None]:
    """
    Run Playwright for a single TC/module folder.
    Returns (spec_results, run_command, log_tail, work_cwd).
    Test failures are returned as failed specs — caller continues to next root.
    """
    specs_rel = [
        f.path.replace("\\", "/")
        for f in root_files
        if "/specs/" in f.path.replace("\\", "/")
        and f.path.replace("\\", "/").endswith((".ts", ".js", ".mjs"))
    ]
    if not specs_rel:
        return [], [], "", None

    cfg = next(
        (
            f
            for f in root_files
            if f.kind == "config"
            or f.path.replace("\\", "/").endswith("playwright.config.ts")
        ),
        None,
    )
    work_cwd, _spec_arg, config_arg = resolve_e2e_work_cwd(
        project_root,
        config_rel=cfg.path if cfg else f"{root_rel}/playwright.config.ts",
        primary_spec_path=specs_rel[0],
    )
    if config_arg and not Path(config_arg).is_absolute():
        config_arg = str((Path(work_cwd) / config_arg).resolve())

    if run_command is not None:
        cmd = apply_headed_flag(list(run_command), headed=headed)
    else:
        cmd = default_playwright_run_command(
            "specs/",
            config_arg=config_arg,
            runner_prefix=runner_prefix,
            headed=headed,
        )
    _runtime_fix_missing_storage_state(work_cwd, config_arg=config_arg)

    try:
        code, log = await runner(cmd, work_cwd)
    except Exception as exc:  # noqa: BLE001
        detail = exc_detail(exc)
        failed = [
            E2ESpecRunResult(spec_path=p, success=False, error_excerpt=detail)
            for p in specs_rel
        ]
        return failed, cmd, detail, work_cwd

    parsed = parse_playwright_json_report(log)
    return (
        _map_module_spec_results(
            specs_rel=specs_rel, parsed=parsed, code=code, log=log
        ),
        cmd,
        log[-LOG_TAIL:] if log else "",
        work_cwd,
    )


def ensure_playwright_config(
    files: list[E2EFile],
    *,
    module: str = "",
    package_prefix: str | None = None,
    target_url: str = "",
    storage_state_rel: str = "",
    headed: bool = False,
    requirement_title: str = "",
    test_case_title: str = "",
) -> list[E2EFile]:
    """Ensure playwright.config.ts exists; luôn refresh khi headed / thiếu timeout."""
    from app.services.e2e_codegen_guard import (
        is_valid_storage_state_json,
        looks_like_storage_state_path,
    )

    # If a valid storageState is already present, keep using it.
    # Otherwise global setup will generate/reuse one at runtime.
    has_valid_state = any(
        looks_like_storage_state_path(f.path)
        and is_valid_storage_state_json(f.content or "")
        for f in files
    )
    # Path is relative to playwright.config.ts (module folder), never repo-root AItest/...
    storage_for_cfg = "./fixtures/storageState.json"
    # Ignore host-requested storage_state_rel when file is not valid yet
    _ = (storage_state_rel, has_valid_state)  # kept for API compat / future disk check

    cfg_content = default_playwright_config(
        base_url=target_url,
        storage_state_rel=storage_for_cfg,
        headed=headed,
    )
    root = e2e_module_root(
        module, package_prefix=package_prefix,
        requirement_title=requirement_title, test_case_title=test_case_title,
    )
    cfg_path = f"{root}/playwright.config.ts"

    out: list[E2EFile] = []
    cfg_out_path = cfg_path
    found = False
    for f in files:
        is_cfg = f.kind == "config" or f.path.replace("\\", "/").endswith(
            "playwright.config.ts"
        )
        if not is_cfg:
            # Drop invalid empty storageState so PW never loads it
            if looks_like_storage_state_path(f.path) and not is_valid_storage_state_json(
                f.content or ""
            ):
                continue
            out.append(f)
            continue
        found = True
        body = f.content or ""
        needs_refresh = (
            headed
            or "timeout:" not in body
            or "navigationTimeout" not in body
            or (headed and "headless: false" not in body)
            or (not headed and "headless: false" in body)
            or (headed and "slowMo" not in body)
            or ("storageState" in body and not has_valid_state)
            or (has_valid_state and "fixtures/storageState.json" not in body)
        )
        if needs_refresh:
            cfg_out_path = f.path or cfg_path
            out.append(E2EFile(path=cfg_out_path, content=cfg_content, kind="config"))
        else:
            cfg_out_path = f.path or cfg_path
            out.append(f)
    if not found:
        out.append(E2EFile(path=cfg_path, content=cfg_content, kind="config"))
        cfg_out_path = cfg_path

    # Ensure global setup exists so auth runs once and persists session for all specs.
    # With multi-TC batch, ensure each config dir that already has a config also has setup.
    cfg_dirs = {
        (f.path or "").replace("\\", "/").rsplit("/", 1)[0]
        for f in out
        if (f.path or "").replace("\\", "/").endswith("playwright.config.ts")
    }
    if not cfg_dirs:
        cfg_dirs = {cfg_out_path.replace("\\", "/").rsplit("/", 1)[0]}
    existing_setups = {
        (f.path or "").replace("\\", "/").lower()
        for f in out
        if (f.path or "").replace("\\", "/").lower().endswith("/fixtures/global.setup.ts")
    }
    for cfg_dir in sorted(cfg_dirs):
        setup_path = f"{cfg_dir}/fixtures/global.setup.ts"
        if setup_path.lower() in existing_setups:
            continue
        out.append(E2EFile(path=setup_path, content=_GLOBAL_SETUP_TS, kind="fixture"))
        existing_setups.add(setup_path.lower())
    return out


def _strip_storage_state_lines(text: str) -> str:
    return re.sub(
        r"^[ \t]*storageState\s*:\s*.+?,?\s*$\n?",
        "",
        text,
        flags=re.MULTILINE,
    )


def _runtime_fix_missing_storage_state(
    work_cwd: str,
    *,
    config_arg: str | None,
) -> None:
    """
    Runtime safety-net:
    If config points to storageState but fixtures/storageState.json is missing/invalid,
    strip storageState from config to avoid Playwright ENOENT fail-before-test.
    """
    from app.services.e2e_codegen_guard import is_valid_storage_state_json

    cfg_path = Path(work_cwd) / (config_arg or "playwright.config.ts")
    if not cfg_path.is_file():
        return
    try:
        body = cfg_path.read_text(encoding="utf-8")
    except OSError:
        return
    if "storageState" not in body:
        return
    # Global setup may create the state file right before tests start.
    if "globalSetup" in body and "global.setup.ts" in body:
        return

    state_path = Path(work_cwd) / "fixtures" / "storageState.json"
    has_valid = False
    if state_path.is_file():
        try:
            raw = state_path.read_text(encoding="utf-8")
            has_valid = is_valid_storage_state_json(raw)
        except OSError:
            has_valid = False
    if has_valid:
        return

    fixed = _strip_storage_state_lines(body)
    if fixed != body:
        try:
            cfg_path.write_text(fixed, encoding="utf-8")
            logger.warning(
                "Removed storageState from config (missing/invalid fixture): %s",
                cfg_path,
            )
        except OSError:
            pass


def _looks_like_aitest_product_root(root: Path) -> bool:
    """Heuristic: AITest monorepo has both api/app and desktop/src-tauri."""
    return (root / "api" / "app" / "main.py").is_file() and (
        root / "desktop" / "src-tauri"
    ).is_dir()


class E2EOrchestrator:
    """Điều phối Headless Playwright + Auto-Heal trên project_root."""

    def __init__(self, project_root: str, *, module: str = "", package_prefix: str | None = None):
        self.project_root = str(Path(project_root))
        self.module = module or ""
        self.package_prefix = package_prefix

    def write_files(self, files: list[E2EFile]) -> None:
        from app.services.test_output_layout import assert_e2e_aitest_target_rel

        root = Path(self.project_root).resolve()
        # Refuse writing into the AITest product repo (tool source), only target apps.
        if _looks_like_aitest_product_root(root):
            raise ValueError(
                "projectRoot đang trỏ vào source AITest (tool), không phải app đích. "
                "Hãy gắn Project root tới thư mục source code cần test "
                f"(hiện tại: {root}). File E2E sẽ ghi vào {{root}}/AItest/E2ETest/…"
            )
        for f in files:
            rel = assert_e2e_aitest_target_rel(f.path.replace("\\", "/"))
            abs_path = root / rel
            abs_path.parent.mkdir(parents=True, exist_ok=True)
            abs_path.write_text(f.content, encoding="utf-8")

    async def execute_sandbox_and_auto_heal(
        self,
        *,
        files: list[E2EFile],
        primary_spec_path: str,
        req: E2ERequest,
        conn: AiBackendConnection | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        run_command: Sequence[str] | None = None,
        run_fn: RunCommandFn | None = None,
        fix_fn: FixE2EFn | None = None,
        write_file: bool = True,
        cwd: str | None = None,
        require_playwright: bool = True,
        headed: bool = False,
        env_extra: dict[str, str] | None = None,
    ) -> E2ESandboxHealResult:
        """
        Ghi files → chạy Playwright → fail thì AI heal → lặp tối đa max_retries.
        headed=True mở cửa sổ Chromium (--headed).
        """
        work_files = list(files)
        work_files = ensure_playwright_config(
            work_files,
            module=req.module or self.module,
            package_prefix=req.package_prefix
            if req.package_prefix is not None
            else self.package_prefix,
            target_url=req.target_url,
            storage_state_rel=req.storage_state_rel,
            headed=headed,
        )
        cfg = next(
            (
                f
                for f in work_files
                if f.kind == "config" or f.path.endswith("playwright.config.ts")
            ),
            None,
        )

        if cwd:
            work_cwd = cwd
            spec_arg = primary_spec_path.replace("\\", "/")
            config_arg = None
            if cfg:
                cfg_path = Path(cfg.path)
                if cfg_path.is_absolute():
                    config_arg = str(cfg_path)
                else:
                    local_cfg = Path(work_cwd) / "playwright.config.ts"
                    config_arg = str(
                        local_cfg.resolve()
                        if local_cfg.is_file()
                        else (Path(self.project_root) / cfg.path).resolve()
                    )
            cmd = list(
                run_command
                or default_playwright_run_command(
                    spec_arg, config_arg=config_arg, headed=headed
                )
            )
        else:
            work_cwd, spec_arg, config_arg = resolve_e2e_work_cwd(
                self.project_root,
                config_rel=cfg.path if cfg else None,
                primary_spec_path=primary_spec_path,
            )
            cmd = list(
                run_command
                or default_playwright_run_command(
                    spec_arg, config_arg=config_arg, headed=headed
                )
            )

        if config_arg and not Path(config_arg).is_absolute():
            config_arg = str((Path(work_cwd) / config_arg).resolve())
            if run_command is None:
                cmd = default_playwright_run_command(
                    spec_arg, config_arg=config_arg, headed=headed
                )

        history: list[E2ESandboxAttempt] = []
        last_log = ""

        if write_file:
            self.write_files(work_files)
        _runtime_fix_missing_storage_state(work_cwd, config_arg=config_arg)

        merged_env: dict[str, str] = dict(env_extra or {})
        if require_playwright and run_fn is None and run_command is None:
            check = check_playwright_ready(self.project_root)
            if not check.ok:
                raise RuntimeError(
                    f"Playwright chưa sẵn sàng tại `{self.project_root}`: {check.message}"
                )
            if check.source == "aitest" and check.package_root:
                from app.services.aitest_playwright_runner import ensure_shared_playwright_runner
                try:
                    await asyncio.to_thread(ensure_shared_playwright_runner, install_browsers=True)
                except Exception as _e:
                    logger.warning("ensure_shared_playwright_runner warn: %s", _e)
                # Use AITest shared runner CLI (project không cần @playwright/test)
                cmd = default_playwright_run_command(
                    spec_arg,
                    config_arg=config_arg,
                    runner_prefix=check.package_root,
                    headed=headed,
                )
            elif check.package_root:
                # Force same package root for playwright CLI + @playwright/test
                # to avoid "did not expect test.describe()" from mixed versions.
                cmd = default_playwright_run_command(
                    spec_arg,
                    config_arg=config_arg,
                    runner_prefix=check.package_root,
                    headed=headed,
                )
            if check.package_root:
                # Config/spec chạy ở AItest/... nên require('@playwright/test') trong config
                # cần thấy node_modules của package root đã chọn ở trên.
                nm = str(Path(check.package_root) / "node_modules")
                prev = os.environ.get("NODE_PATH", "")
                merged_env["NODE_PATH"] = nm if not prev else f"{nm}{os.pathsep}{prev}"

        cmd = apply_headed_flag(cmd, headed=headed)

        if run_fn is not None:
            runner = run_fn
        elif merged_env:

            async def runner(cmd: Sequence[str], cwd: str) -> tuple[int, str]:
                return await _default_run_command(cmd, cwd, env_extra=merged_env)

        else:
            runner = _default_run_command

        # Optional seed before first attempt (from project root — scripts often live there)
        seed_cwd = self.project_root
        if req.seed_command.strip() and write_file:
            seed_cmd = req.seed_command.strip().split()
            await runner(seed_cmd, seed_cwd)

        try:
            for attempt in range(1, max_retries + 1):
                logger.info(
                    "E2E verify attempt %s/%s spec=%s cwd=%s cmd=%s",
                    attempt,
                    max_retries,
                    primary_spec_path,
                    work_cwd,
                    cmd,
                )
                exit_code, log = await runner(cmd, work_cwd)
                last_log = log
                ok = exit_code == 0
                history.append(
                    E2ESandboxAttempt(
                        attempt=attempt,
                        exit_code=exit_code,
                        success=ok,
                        log_excerpt=log[-LOG_TAIL:],
                    )
                )
                if ok:
                    return E2ESandboxHealResult(
                        status="PASSED",
                        primary_spec_path=primary_spec_path,
                        files=work_files,
                        attempts=attempt,
                        error_log=None,
                        history=history,
                        run_command=cmd,
                        work_cwd=work_cwd,
                    )

                if attempt >= max_retries:
                    break

                heal_ctx = build_e2e_heal_prompt_context(
                    primary_spec_path=primary_spec_path,
                    run_command=cmd,
                    error_log=log,
                    attempt=attempt,
                    max_retries=max_retries,
                    dom_snapshot=req.dom_snapshot,
                )
                heal_req = E2ERequest(
                    test_case_title=req.test_case_title,
                    test_case_type=req.test_case_type,
                    priority=req.priority,
                    steps=req.steps,
                    expected_result=req.expected_result,
                    precondition=req.precondition,
                    test_data=req.test_data,
                    target_url=req.target_url,
                    dom_snapshot=req.dom_snapshot,
                    source_file_name=req.source_file_name,
                    source_code=req.source_code,
                    module=req.module or self.module,
                    package_prefix=req.package_prefix
                    if req.package_prefix is not None
                    else self.package_prefix,
                    framework=req.framework,
                    language=req.language,
                    storage_state_rel=req.storage_state_rel,
                    seed_command=req.seed_command,
                    teardown_command=req.teardown_command,
                    repair_context=heal_ctx,
                    related_sources=list(req.related_sources),
                    existing_files=[(f.path, f.content) for f in work_files],
                )

                if fix_fn is not None:
                    fixed_raw = await fix_fn(heal_req, heal_ctx)
                elif conn is not None:
                    from app.services.ai_service import generate_e2e_for_connection

                    result, _meta = await generate_e2e_for_connection(
                        conn, heal_req, heal=True
                    )
                    fixed_raw = ""
                    if result.files:
                        by_path = {f.path: f for f in work_files}
                        for f in result.files:
                            by_path[f.path] = f
                        work_files = list(by_path.values())
                        if write_file:
                            self.write_files(result.files)
                        continue
                else:
                    raise ValueError("E2E auto-heal cần conn hoặc fix_fn")

                parsed = parse_e2e_files_from_raw(fixed_raw)
                if not parsed:
                    code = extract_code_block(fixed_raw) or fixed_raw
                    target = next(
                        (f for f in work_files if f.kind == "page"),
                        next(
                            (f for f in work_files if f.path == primary_spec_path),
                            work_files[0],
                        ),
                    )
                    parsed = [E2EFile(path=target.path, content=code, kind=target.kind)]

                resolved = resolve_e2e_file_paths(
                    parsed,
                    module=req.module or self.module,
                    package_prefix=req.package_prefix
                    if req.package_prefix is not None
                    else self.package_prefix,
                )
                from app.services.e2e_codegen_guard import apply_e2e_codegen_guards

                resolved = apply_e2e_codegen_guards(
                    resolved, dom_snapshot=req.dom_snapshot
                )
                by_path = {f.path: f for f in work_files}
                for f in resolved:
                    by_path[f.path] = f
                work_files = list(by_path.values())
                if write_file:
                    self.write_files(resolved)

            return E2ESandboxHealResult(
                status="FAILED",
                primary_spec_path=primary_spec_path,
                files=work_files,
                attempts=max_retries,
                error_log=last_log[-LOG_TAIL:] if last_log else None,
                history=history,
                run_command=cmd,
                work_cwd=work_cwd,
            )
        finally:
            if req.teardown_command.strip() and write_file:
                try:
                    teardown_cmd = req.teardown_command.strip().split()
                    await runner(teardown_cmd, seed_cwd)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("E2E teardown failed: %s", exc_detail(exc))

    async def execute_module_headless(
        self,
        *,
        files: list[E2EFile],
        module: str | None = None,
        package_prefix: str | None = None,
        target_url: str = "",
        storage_state_rel: str = "",
        seed_command: str = "",
        teardown_command: str = "",
        run_command: Sequence[str] | None = None,
        run_fn: RunCommandFn | None = None,
        write_file: bool = True,
        require_playwright: bool = True,
        headed: bool = False,
        env_extra: dict[str, str] | None = None,
    ) -> E2EModuleRunResult:
        """
        Ghi toàn bộ files rồi chạy Playwright theo từng TC folder.

        Layout mới ({Requirement}/{TC}) có config riêng → chạy độc lập.
        TC fail không chặn TC sau. headed=True mở cửa sổ Chromium.
        """
        mod = (module if module is not None else self.module) or ""
        pkg = package_prefix if package_prefix is not None else self.package_prefix
        work_files = list(resolve_e2e_file_paths(files, module=mod, package_prefix=pkg))
        work_files = ensure_playwright_config(
            work_files,
            module=mod,
            package_prefix=pkg,
            target_url=target_url,
            storage_state_rel=storage_state_rel,
            headed=headed,
        )
        if not work_files:
            return E2EModuleRunResult(status="FAILED", log="No E2E files to run.")

        groups = _group_files_by_run_root(work_files)
        specs_rel = [
            f.path.replace("\\", "/")
            for f in work_files
            if "/specs/" in f.path.replace("\\", "/")
            and f.path.replace("\\", "/").endswith((".ts", ".js", ".mjs"))
        ]
        if not specs_rel:
            return E2EModuleRunResult(
                status="FAILED",
                files=work_files,
                log="No specs/ files found for module run.",
            )

        if write_file:
            self.write_files(work_files)

        merged_env: dict[str, str] = dict(env_extra or {})
        runner_prefix: str | None = None
        if require_playwright and run_fn is None and run_command is None:
            check = check_playwright_ready(self.project_root)
            if not check.ok:
                return E2EModuleRunResult(
                    status="FAILED",
                    files=work_files,
                    log=f"Playwright chưa sẵn sàng: {check.message}",
                    specs=[
                        E2ESpecRunResult(
                            spec_path=p,
                            success=False,
                            error_excerpt="playwright missing",
                        )
                        for p in specs_rel
                    ],
                )
            runner_prefix = check.package_root
            if check.package_root:
                nm = str(Path(check.package_root) / "node_modules")
                prev = os.environ.get("NODE_PATH", "")
                merged_env["NODE_PATH"] = (
                    nm if not prev else f"{nm}{os.pathsep}{prev}"
                )

        if run_fn is not None:
            runner = run_fn
        elif merged_env:

            async def runner(cmd_: Sequence[str], cwd: str) -> tuple[int, str]:
                return await _default_run_command(cmd_, cwd, env_extra=merged_env)

        else:
            runner = _default_run_command

        seed_cwd = self.project_root
        if (seed_command or "").strip() and write_file:
            seed_argv = seed_command.strip().split()
            code_s, log_s = await runner(seed_argv, seed_cwd)
            if code_s != 0:
                return E2EModuleRunResult(
                    status="FAILED",
                    files=work_files,
                    log=f"Seed failed (exit {code_s}):\n{log_s[-LOG_TAIL:]}",
                    specs=[
                        E2ESpecRunResult(
                            spec_path=p, success=False, error_excerpt="seed failed"
                        )
                        for p in specs_rel
                    ],
                )

        all_spec_results: list[E2ESpecRunResult] = []
        logs: list[str] = []
        last_cmd: list[str] = []
        last_cwd: str | None = None

        try:
            for root_rel, root_files in groups:
                root_specs = [
                    f.path.replace("\\", "/")
                    for f in root_files
                    if "/specs/" in f.path.replace("\\", "/")
                ]
                if not root_specs:
                    continue
                try:
                    spec_results, cmd, log_tail, work_cwd = await _run_one_e2e_root(
                        runner=runner,
                        project_root=self.project_root,
                        root_rel=root_rel,
                        root_files=root_files,
                        headed=headed,
                        run_command=run_command,
                        runner_prefix=runner_prefix,
                    )
                except Exception as exc:  # noqa: BLE001
                    detail = exc_detail(exc)
                    logger.warning(
                        "E2E batch root failed (continue): %s — %s",
                        root_rel,
                        detail,
                    )
                    all_spec_results.extend(
                        E2ESpecRunResult(
                            spec_path=p, success=False, error_excerpt=detail
                        )
                        for p in root_specs
                    )
                    logs.append(f"[{root_rel}] ERROR: {detail}")
                    continue

                all_spec_results.extend(spec_results)
                if cmd:
                    last_cmd = list(cmd)
                if work_cwd:
                    last_cwd = work_cwd
                if log_tail:
                    logs.append(f"--- {root_rel} ---\n{log_tail}")

            all_pass = bool(all_spec_results) and all(
                s.success for s in all_spec_results
            )
            return E2EModuleRunResult(
                status="PASSED" if all_pass else "FAILED",
                files=work_files,
                work_cwd=last_cwd,
                run_command=last_cmd,
                log="\n".join(logs)[-LOG_TAIL:] if logs else "",
                specs=all_spec_results,
            )
        finally:
            if write_file and (teardown_command or "").strip():
                try:
                    await runner(teardown_command.strip().split(), seed_cwd)
                except Exception as exc:  # noqa: BLE001
                    logger.warning("E2E module teardown failed: %s", exc_detail(exc))

    async def heal_failed_specs(
        self,
        *,
        all_files: list[E2EFile],
        failed_specs: Sequence[str],
        req: E2ERequest,
        conn: AiBackendConnection | None = None,
        max_retries: int = DEFAULT_MAX_RETRIES,
        write_file: bool = True,
        run_fn: RunCommandFn | None = None,
        fix_fn: FixE2EFn | None = None,
        require_playwright: bool = True,
        headed: bool = False,
    ) -> list[E2ESandboxHealResult]:
        """Heal từng primarySpec fail (chạy lại 1 file), giữ nguyên files khác trên disk."""
        results: list[E2ESandboxHealResult] = []
        base_files = list(all_files)
        for spec_path in failed_specs:
            rel = spec_path.replace("\\", "/")
            scoped = [
                f
                for f in base_files
                if f.path.replace("\\", "/") == rel
                or "/pages/" in f.path.replace("\\", "/")
                or f.path.replace("\\", "/").endswith("playwright.config.ts")
            ]
            if not any(f.path.replace("\\", "/") == rel for f in scoped):
                scoped = list(base_files)

            r = await self.execute_sandbox_and_auto_heal(
                files=scoped,
                primary_spec_path=rel,
                req=req,
                conn=conn,
                max_retries=max_retries,
                run_fn=run_fn,
                fix_fn=fix_fn,
                write_file=write_file,
                require_playwright=require_playwright,
                headed=headed,
            )
            results.append(r)
            if r.files:
                by_p = {f.path: f for f in base_files}
                for f in r.files:
                    by_p[f.path] = f
                base_files = list(by_p.values())
        return results
