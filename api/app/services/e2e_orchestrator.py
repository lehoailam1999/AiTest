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
import { chromium, expect, type FullConfig } from '@playwright/test';

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
  const LOGIN_NAME = /đăng\\s*nhập|sign\\s*[-\\s]?in|log\\s*[-\\s]?in|login/i;
  const ACCOUNT_NAME = /tài\\s*khoản|account|profile|user\\s*menu|avatar|menu/i;

  const loginHeading = () => page.getByRole('heading', { name: LOGIN_NAME }).first();
  const email = () =>
    page.getByRole('textbox', { name: /email|e-?mail|tài khoản|username|user\\s*name/i }).first();
  const password = () =>
    page
      .getByRole('textbox', { name: /password|mật khẩu|passwd/i })
      .or(page.locator('input[type="password"]'))
      .first();
  const loginBtn = () =>
    page.locator('form').getByRole('button', { name: LOGIN_NAME }).first();
  const loginTab = page.getByRole('tab', { name: LOGIN_NAME }).first();

  const isLoginWall = async (): Promise<boolean> => {
    if (await password().isVisible().catch(() => false)) return true;
    return (
      (await email().isVisible().catch(() => false)) ||
      (await loginHeading().isVisible().catch(() => false))
    );
  };

  const clickFirstVisible = async (locs: any[]): Promise<boolean> => {
    for (const loc of locs) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 10000 }).catch(() => undefined);
        return true;
      }
    }
    return false;
  };

  const openLoginEntry = async (): Promise<boolean> => {
    if (await isLoginWall()) return true;
    const explicit = (process.env.E2E_LOGIN_PATH || '').trim();
    if (explicit) {
      const path = explicit.startsWith('http')
        ? explicit
        : explicit.startsWith('/')
          ? explicit
          : `/${explicit}`;
      await page.goto(path, { waitUntil: 'domcontentloaded' });
      if (await isLoginWall()) return true;
    }
    const entries = [
      page.getByRole('link', { name: LOGIN_NAME }).first(),
      page.getByRole('button', { name: LOGIN_NAME }).first(),
      page.getByRole('menuitem', { name: LOGIN_NAME }).first(),
      page.locator('a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], a[href*="auth" i]').first(),
    ];
    if (await clickFirstVisible(entries)) {
      await password()
        .or(email())
        .or(loginHeading())
        .first()
        .waitFor({ state: 'visible', timeout: 15000 })
        .catch(() => undefined);
      if (await isLoginWall()) return true;
    }
    const menus = [
      page.getByRole('button', { name: ACCOUNT_NAME }).first(),
      page.getByRole('link', { name: ACCOUNT_NAME }).first(),
      page.locator('[aria-label*="account" i], [aria-label*="user" i], [aria-label*="tài khoản" i]').first(),
    ];
    if (await clickFirstVisible(menus)) {
      if (await clickFirstVisible(entries)) {
        await password()
          .or(email())
          .or(loginHeading())
          .first()
          .waitFor({ state: 'visible', timeout: 15000 })
          .catch(() => undefined);
      }
    }
    return await isLoginWall();
  };

  if (!(await openLoginEntry())) return;

  if (!user || !pass) {
    throw new Error(
      'Auth seed failed: app shows login but E2E_USERNAME/E2E_PASSWORD (or role creds) are not set. ' +
        'Configure AITest → E2E → Môi trường before Verify with storageState.',
    );
  }

  if (await loginTab.isVisible().catch(() => false)) {
    await loginTab.click().catch(() => undefined);
  }
  await email().fill(user);
  await password().fill(pass);
  await password().blur().catch(() => undefined);
  const tryLogin = async () => {
    const authNetwork = page
      .waitForResponse(
        (r) => {
          if (r.request().method() === 'GET') return false;
          return /auth|login|signin|session|token|users?\\/sign/i.test(r.url());
        },
        { timeout: 30000 },
      )
      .catch(() => null);
    await loginBtn().click().catch(() => undefined);
    const resp = await authNetwork;
    if (resp && !resp.ok()) {
      const body = await resp.text().catch(() => '');
      return { ok: false as const, status: resp.status(), url: resp.url(), body };
    }
    return { ok: true as const };
  };

  const tryRegisterAndRelogin = async (): Promise<boolean> => {
    const signUpTab = page.getByRole('tab', { name: /đăng\\s*ký|sign\\s*up|register/i }).first();
    const registerBtn = page
      .locator('form')
      .getByRole('button', { name: /đăng\\s*ký|sign\\s*up|register/i })
      .first();
    const canRegister =
      (await signUpTab.isVisible().catch(() => false)) &&
      (await registerBtn.isVisible().catch(() => false));
    if (!canRegister) return false;
    await signUpTab.click().catch(() => undefined);
    await email().fill(user);
    await password().fill(pass);
    await password().blur().catch(() => undefined);
    await registerBtn.click().catch(() => undefined);
    if (await loginTab.isVisible().catch(() => false)) {
      await loginTab.click().catch(() => undefined);
    }
    await email().fill(user);
    await password().fill(pass);
    await password().blur().catch(() => undefined);
    const retried = await tryLogin();
    return Boolean(retried.ok);
  };

  let loginRes = await tryLogin();
  if (!loginRes.ok) {
    const recovered = await tryRegisterAndRelogin();
    if (recovered) {
      loginRes = { ok: true as const };
    }
  }
  if (!loginRes.ok) {
    throw new Error(
      `Login HTTP ${loginRes.status} for ${loginRes.url}. ` +
        `${(loginRes.body || '').slice(0, 200)}`,
    );
  }
  try {
    await expect(email()).toBeHidden({ timeout: 15000 });
  } catch {
    const recovered = await tryRegisterAndRelogin();
    if (recovered) {
      await expect(email()).toBeHidden({ timeout: 15000 });
      return;
    }
    throw new Error('Login did not leave the login wall in global setup.');
  }
}

function isValidStorageStateFile(p: string): boolean {
  try {
    if (!fs.existsSync(p)) return false;
    const data = JSON.parse(fs.readFileSync(p, 'utf8'));
    const cookies = data && data.cookies;
    const origins = data && data.origins;
    return (
      (Array.isArray(cookies) && cookies.length > 0) ||
      (Array.isArray(origins) && origins.length > 0)
    );
  } catch {
    return false;
  }
}

export default async function globalSetup(config: FullConfig): Promise<void> {
  const setupPath = __filename.replace(/\\\\/g, '/');
  const fixturesDir = path.dirname(setupPath);
  const statePath = path.join(fixturesDir, 'storageState.json');
  const cwdStatePath = path.join(process.cwd(), 'fixtures', 'storageState.json');

  // Reuse only *valid* previously generated state (empty {} must re-seed).
  if (
    (isValidStorageStateFile(statePath) || isValidStorageStateFile(cwdStatePath)) &&
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


def _playwright_result_error_message(result: dict) -> str:
    """Prefer short human error.message over nested JSON / code frames."""
    err = result.get("error")
    if isinstance(err, dict):
        msg = str(err.get("message") or err.get("stack") or "").strip()
        if msg:
            return msg
    elif err:
        return str(err).strip()
    for item in result.get("errors") or []:
        if isinstance(item, dict):
            msg = str(item.get("message") or item.get("stack") or "").strip()
            if msg:
                return msg
        elif item:
            return str(item).strip()
    return ""


def _clean_error_excerpt(raw: str, *, limit: int = 600) -> str:
    """Drop ANSI / report JSON tails so Desktop Phase 4 can classify failures."""
    text = (raw or "").strip()
    if not text:
        return ""
    text = re.sub(r"\x1b\[[0-9;]*m|\u001b\[[0-9;]*m", "", text)
    # Prefer Phase 3 / expect lines if buried in a dump
    for pat in (
        r"Phase 3: ungrounded POM stub[^\n]+",
        r"Error:\s*[^\n]+",
        r"expect\([^\n]+",
    ):
        m = re.search(pat, text)
        if m:
            return m.group(0)[:limit]
    # Strip accidental JSON report fragments
    if '"attachments"' in text or '"errorLocation"' in text:
        m = re.search(r"(Phase 3:[^\"]+|Error:[^\"]{10,200})", text)
        if m:
            return m.group(1)[:limit]
        return "Playwright FAIL (see Log — excerpt was JSON report noise)"[:limit]
    return text[:limit]


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
                "test",
                "tests",
                "e2e",
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
    from app.services.failure_taxonomy import (
        classify_e2e_standard,
        format_e2e_heal_taxonomy_block,
    )

    cmd = " ".join(run_command)
    taxonomy = classify_e2e_standard(error_log)
    tax_block = format_e2e_heal_taxonomy_block(taxonomy)
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
        f"{tax_block}\n"
        f"Log lỗi (đuôi):\n```\n{error_log[-LOG_TAIL:]}\n```\n"
        f"{dom_part}\n"
        "Phase 6: heal bounded — chỉ sửa file liên quan lỗi; không viết lại toàn bộ suite. "
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
                        err = _playwright_result_error_message(r) or st
            if file_rel:
                out.append(
                    E2ESpecRunResult(
                        spec_path=file_rel,
                        success=ok,
                        title=title,
                        error_excerpt=_clean_error_excerpt(err),
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
            nest_names = {
                "apps",
                "packages",
                "frontend",
                "client",
                "web",
                "src",
                "services",
                "test",
                "tests",
                "e2e",
            }
            scan_dirs: list[Path] = []
            for child in root.iterdir():
                if not child.is_dir() or child.name in _SKIP_DIR_NAMES:
                    continue
                scan_dirs.append(child)
                if child.name.lower() in nest_names:
                    try:
                        for sub in child.iterdir():
                            if sub.is_dir() and sub.name not in _SKIP_DIR_NAMES:
                                scan_dirs.append(sub)
                    except OSError:
                        pass
            for child in scan_dirs:
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


def _sanitize_playwright_env(env: dict[str, str]) -> dict[str, str]:
    """
    Cursor/sandbox shells often inject PLAYWRIGHT_BROWSERS_PATH →
    ``…/cursor-sandbox-cache/…/playwright`` without Chromium. Playwright then
    fails with "Executable doesn't exist" even though browsers exist under
    ``%LOCALAPPDATA%\\ms-playwright``. Strip bad overrides; prefer real cache.
    """
    key = "PLAYWRIGHT_BROWSERS_PATH"
    raw = str(env.get(key) or "").strip()
    norm = raw.replace("\\", "/").lower()
    bad = ("cursor-sandbox-cache", "/sandbox-cache/", "\\sandbox-cache\\")
    local = Path(os.environ.get("LOCALAPPDATA") or "") / "ms-playwright"

    def _has_chromium(root: Path) -> bool:
        try:
            if not root.is_dir():
                return False
            return any(root.glob("chromium-*"))
        except OSError:
            return False

    if raw and any(b in norm for b in bad):
        env.pop(key, None)
        raw = ""
    elif raw and not _has_chromium(Path(raw)):
        env.pop(key, None)
        raw = ""

    if not raw and _has_chromium(local):
        env[key] = str(local.resolve())
    return env


def _merge_env(env_extra: dict[str, str] | None = None) -> dict[str, str]:
    env = os.environ.copy()
    if env_extra:
        env.update(env_extra)
    return _sanitize_playwright_env(env)


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
        "E2E_LOGIN_PATH",
        "E2E_ROLE",
        "E2E_AUTH_ROLE",
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


def _command_wants_headed_gui(cmd: Sequence[str]) -> bool:
    """
    Detect Playwright --headed after Windows resolve_command wrapping.

    npx becomes ``cmd.exe /d /s /c "npx.cmd … --headed"`` — ``"--headed" in argv``
    is False because the flag sits inside the cmdline string. That wrongly applied
    CREATE_NO_WINDOW and hid Chromium during Verify.
    """
    for tok in cmd:
        s = str(tok)
        if s == "--headed" or s.startswith("--headed=") or "--headed" in s.split():
            return True
        # cmd.exe /c single-string cmdline
        if "--headed" in s and re.search(r"(^|[\s\"'])--headed([\s\"'=]|$)", s):
            return True
    return False


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
    want_gui = _command_wants_headed_gui(cmd) or _command_wants_headed_gui(resolved)
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
    want_gui = _command_wants_headed_gui(cmd) or _command_wants_headed_gui(resolved)
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
    """Directory that owns a TC run (parent of specs/ or of playwright.config.ts).

    Never treat E2ETest/_shared as a TC work_cwd.
    """
    p = path.replace("\\", "/").strip("/")
    low = p.lower()
    if "/_shared/" in f"/{low}/" or low.rstrip("/").endswith("/_shared"):
        return ""
    if low.endswith("playwright.config.ts"):
        return p.rsplit("/", 1)[0]
    if "/specs/" in low:
        return p.split("/specs/")[0]
    # Pages/fixtures under _shared are filtered above; legacy TC-local pages still map
    if "/pages/" in low:
        return p.split("/pages/")[0]
    if "/fixtures/" in low:
        return p.split("/fixtures/")[0]
    if "/types/" in low:
        return p.split("/types/")[0]
    return p.rsplit("/", 1)[0] if "/" in p else p


def _align_primary_spec_path(files: list[E2EFile], primary_spec_path: str) -> str:
    """
    After suffix heal (``.ts`` → ``.spec.ts``), keep primary_spec_path pointing at a
    real file so Playwright argv is not a ghost path.
    """
    prim = (primary_spec_path or "").replace("\\", "/").strip()
    paths = {
        (getattr(f, "path", "") or "").replace("\\", "/")
        for f in files
        if (getattr(f, "path", "") or "").strip()
    }
    if prim and prim in paths:
        return prim
    if prim.endswith(".ts") and not prim.endswith((".spec.ts", ".test.ts")):
        cand = prim[:-3] + ".spec.ts"
        if cand in paths:
            return cand
    # Same directory: pick the only *.spec.ts / *.test.ts
    if prim and "/" in prim:
        parent = prim.rsplit("/", 1)[0]
        specs = [
            p
            for p in paths
            if p.startswith(parent + "/")
            and (p.endswith(".spec.ts") or p.endswith(".test.ts"))
        ]
        if len(specs) == 1:
            return specs[0]
        stem = Path(prim).stem
        for p in specs:
            if Path(p).stem.startswith(stem[:16]) or stem.startswith(Path(p).stem[:16]):
                return p
    specs_all = [p for p in paths if p.endswith(".spec.ts") or p.endswith(".test.ts")]
    if len(specs_all) == 1:
        return specs_all[0]
    return prim


def _remap_e2e_files_short_paths(
    files: list[E2EFile], primary_spec_path: str = ""
) -> tuple[list[E2EFile], str]:
    """
    Remap AItest/E2ETest paths so no folder segment exceeds Windows-safe length.
    Deterministic — same long title always maps to the same short folder.
    Also rewrites import paths when a leaf filename changes (``.spec.ts`` / ``.page.ts``).
    """
    from app.services.test_output_layout import shorten_e2e_rel_path

    mapping: dict[str, str] = {}
    out: list[E2EFile] = []
    for f in files:
        old = (getattr(f, "path", "") or "").replace("\\", "/")
        new = shorten_e2e_rel_path(old) if old else old
        mapping[old] = new
        out.append(
            E2EFile(
                path=new,
                content=getattr(f, "content", "") or "",
                kind=getattr(f, "kind", "spec") or "spec",
            )
        )

    # leaf + import-specifier remaps (Playwright imports omit .ts)
    leaf_map: dict[str, str] = {}
    for old, new in mapping.items():
        old_leaf = old.rsplit("/", 1)[-1]
        new_leaf = new.rsplit("/", 1)[-1]
        if old_leaf and new_leaf and old_leaf != new_leaf:
            leaf_map[old_leaf] = new_leaf
            for ext in (".ts", ".tsx", ".js", ".mjs"):
                if old_leaf.endswith(ext) and new_leaf.endswith(ext):
                    leaf_map[old_leaf[: -len(ext)]] = new_leaf[: -len(ext)]
                    break

    if leaf_map:
        # Longest keys first so longer stems win over prefixes
        keys = sorted(leaf_map.keys(), key=len, reverse=True)

        def _rewrite(content: str) -> str:
            text = content or ""
            for old_leaf in keys:
                new_leaf = leaf_map[old_leaf]
                if old_leaf in text:
                    text = text.replace(old_leaf, new_leaf)
            return text

        for f in out:
            f.content = _rewrite(f.content)

    prim = (primary_spec_path or "").replace("\\", "/")
    if prim in mapping:
        new_prim = mapping[prim]
    elif prim:
        new_prim = shorten_e2e_rel_path(prim)
    else:
        new_prim = prim
    return out, new_prim

def _ensure_auth_env_from_project(project_root: str, env: dict[str, str]) -> None:
    """Fill E2E_USERNAME/PASSWORD + E2E_<ROLE>_* from .ai-test/auth when Verify forgot to inject."""
    from app.services.e2e_auth_seed import is_invented_auth_username

    # Drop stale invented usernames so they never reach Playwright login.
    if is_invented_auth_username(env.get("E2E_USERNAME")):
        env.pop("E2E_USERNAME", None)
        env.pop("E2E_PASSWORD", None)

    if (env.get("E2E_USERNAME") or "").strip() and (env.get("E2E_PASSWORD") or "").strip():
        pass
    else:
        try:
            from app.services.e2e_auth_seed import load_auth_artifact

            role = (env.get("E2E_ROLE") or env.get("E2E_AUTH_ROLE") or "default").strip()
            art = load_auth_artifact(project_root, role) or load_auth_artifact(
                project_root, "default"
            )
            if art:
                if not (env.get("E2E_USERNAME") or "").strip():
                    u = str(art.get("username") or art.get("email") or "").strip()
                    if u and not is_invented_auth_username(u):
                        env["E2E_USERNAME"] = u
                if not (env.get("E2E_PASSWORD") or "").strip():
                    p = str(art.get("password") or "").strip()
                    if p and (env.get("E2E_USERNAME") or "").strip():
                        env["E2E_PASSWORD"] = p
        except Exception:  # noqa: BLE001
            pass

    # Multi-role: export E2E_<ROLE>_USERNAME|PASSWORD for every auth artifact on disk
    try:
        from pathlib import Path as _P

        from app.services.e2e_auth_seed import load_auth_artifact

        auth_dir = _P(project_root) / ".ai-test" / "auth"
        if auth_dir.is_dir():
            for path in auth_dir.glob("*.json"):
                role_name = path.stem.strip()
                if not role_name or role_name.startswith("."):
                    continue
                art = load_auth_artifact(project_root, role_name)
                if not art:
                    continue
                u = str(art.get("username") or art.get("email") or "").strip()
                p = str(art.get("password") or "").strip()
                if not u or not p or is_invented_auth_username(u):
                    continue
                slug = re.sub(r"[^a-zA-Z0-9]+", "_", role_name).upper() or "DEFAULT"
                uk = f"E2E_{slug}_USERNAME"
                pk = f"E2E_{slug}_PASSWORD"
                if uk not in env:
                    env[uk] = u
                if pk not in env:
                    env[pk] = p
    except Exception:  # noqa: BLE001
        pass

    if not (env.get("E2E_LOGIN_PATH") or "").strip():
        try:
            from app.services.e2e_auth_bootstrap import discover_login_path

            path = discover_login_path(project_root)
            if path:
                env["E2E_LOGIN_PATH"] = path
        except Exception:  # noqa: BLE001
            pass

    # Never point Playwright at a nested/missing storageState via env.
    ss = (env.get("E2E_STORAGE_STATE") or "").strip().replace("\\", "/")
    if ss:
        nested = "/AItest/" in f"/{ss}" and not ss.startswith("./fixtures/")
        candidates = [
            Path(project_root) / ss,
            Path(ss) if Path(ss).is_absolute() else None,
        ]
        exists = any(c is not None and c.is_file() for c in candidates)
        if nested or not exists:
            env.pop("E2E_STORAGE_STATE", None)

    # Cred-only verify (uiLogin / auth-seed, no Playwright cookies on disk).
    user = (env.get("E2E_USERNAME") or "").strip()
    pwd = (env.get("E2E_PASSWORD") or "").strip()
    ss = (env.get("E2E_STORAGE_STATE") or "").strip()
    if user and pwd and not ss and (env.get("E2E_FORCE_UI_LOGIN") or "").strip() != "1":
        env["E2E_FORCE_UI_LOGIN"] = "1"


def _assert_feature_auth_ready(
    files: list[E2EFile],
    env: dict[str, str],
    *,
    req: E2ERequest,
) -> None:
    """
    Fail fast when feature Specs would hit the login wall with no session/creds.
    Project-agnostic: based on generated files + env, not app names.
    """
    from app.services.e2e_auth_mode import is_login_or_auth_tc, is_public_no_auth_signal
    from app.services.e2e_codegen_guard import (
        is_valid_storage_state_json,
        looks_like_storage_state_path,
        spec_calls_ensure_authenticated,
    )

    path_blob = " ".join((f.path or "") for f in files)
    if is_login_or_auth_tc(req.test_case_title or "", path_blob):
        return
    if is_public_no_auth_signal(
        title=req.test_case_title or "",
        path=path_blob,
        dom_snapshot=req.dom_snapshot or "",
        hints=req.precondition or "",
    ):
        return

    has_valid_ss = any(
        looks_like_storage_state_path(f.path)
        and is_valid_storage_state_json(f.content or "")
        for f in files
    )
    has_ensure = any(
        spec_calls_ensure_authenticated(f.content or "")
        for f in files
        if (f.kind == "spec" or "/specs/" in (f.path or "").replace("\\", "/"))
    )
    cfg_blob = "\n".join(
        f.content or ""
        for f in files
        if (f.path or "").replace("\\", "/").endswith("playwright.config.ts")
    )
    cfg_wants_storage = bool(re.search(r"storageState\s*:", cfg_blob))
    has_global_setup = "globalSetup" in cfg_blob
    creds = bool(
        (env.get("E2E_USERNAME") or "").strip()
        and (env.get("E2E_PASSWORD") or "").strip()
    )

    if has_valid_ss:
        return
    if has_ensure and creds:
        return
    if cfg_wants_storage and has_global_setup and creds:
        return

    if not has_ensure and not cfg_wants_storage and not has_valid_ss:
        raise RuntimeError(
            "E2E auth blocked: feature Specs have no ensureAuthenticated and no "
            "storageState. Re-Generate/Verify so codegen guards inject "
            "fixtures/auth.helper.ts, or enable storageState after a successful login seed."
        )
    if (has_ensure or cfg_wants_storage or has_global_setup) and not creds:
        raise RuntimeError(
            "E2E auth blocked: app needs login but E2E_USERNAME/E2E_PASSWORD are empty. "
            "Nhập tài khoản thật trên AITest → E2E (email/mật khẩu user có trong DB app). "
            "Seed auth (AI) chỉ dùng khi app có đăng ký công khai — không tạo e2e_default."
        )


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


def _annotate_playwright_browser_errors(log: str) -> str:
    low = (log or "").lower()
    if "executable doesn't exist" in low or "browserType.launch" in low:
        hint = (
            "\n\n[AITest] Chromium không tìm thấy — thường do PLAYWRIGHT_BROWSERS_PATH "
            "trỏ vào Cursor sandbox cache. Đã cố tự sửa env khi chạy Verify; "
            "nếu vẫn lỗi: restart API ngoài terminal Cursor, hoặc bấm "
            "«Cài Playwright trên AITest», rồi Verify lại."
        )
        if hint.strip() not in log:
            return (log or "") + hint
    return log or ""


def _canonical_spec_under_root(specs_rel: list[str]) -> str:
    """
    One Playwright target per TC folder — avoid running hash twins / orphan specs twice.
    Prefer unique ``*.<8hex>.spec.ts`` (codegen primary); else stable first path.
    """
    cleaned = [p.replace("\\", "/") for p in specs_rel if (p or "").strip()]
    if not cleaned:
        return ""
    if len(cleaned) == 1:
        return cleaned[0]
    hashed = [
        p
        for p in cleaned
        if re.search(r"\.[a-f0-9]{8}\.(?:spec|test)\.", p, flags=re.IGNORECASE)
    ]
    if len(hashed) == 1:
        return hashed[0]
    if hashed:
        return sorted(hashed)[-1]
    return sorted(cleaned)[0]


def _materialize_files_on_disk(
    project_root: str,
    files: list[E2EFile],
) -> list[str]:
    """
    Write any missing E2E artifacts (config / POM / fixtures) before Playwright.
    Returns relative paths that were created or refreshed.
    """
    root = Path(project_root).resolve()
    wrote: list[str] = []
    for f in files:
        rel = (getattr(f, "path", "") or "").replace("\\", "/").strip()
        if not rel:
            continue
        abs_path = root / rel
        content = getattr(f, "content", "") or ""
        if abs_path.is_file() and abs_path.stat().st_size > 0:
            continue
        if not content.strip():
            continue
        write_target = abs_path
        if os.name == "nt":
            s = str(abs_path)
            if not s.startswith("\\\\?\\"):
                write_target = Path("\\\\?\\" + s)
        write_target.parent.mkdir(parents=True, exist_ok=True)
        write_target.write_text(content, encoding="utf-8")
        wrote.append(rel)
    return wrote


def _ensure_root_config_on_disk(
    *,
    project_root: str,
    root_rel: str,
    root_files: list[E2EFile],
    all_files: list[E2EFile],
    target_url: str = "",
    headed: bool = False,
) -> str:
    """
    Guarantee ``{root}/playwright.config.ts`` exists on disk before Playwright CLI.
    Returns absolute config path.
    """
    root = Path(project_root).resolve()
    cfg = next(
        (
            f
            for f in root_files
            if getattr(f, "kind", "") == "config"
            or (getattr(f, "path", "") or "").replace("\\", "/").endswith(
                "playwright.config.ts"
            )
        ),
        None,
    )
    if cfg is None:
        cfg = next(
            (
                f
                for f in all_files
                if (getattr(f, "path", "") or "").replace("\\", "/")
                == f"{root_rel}/playwright.config.ts"
            ),
            None,
        )
    cfg_rel = (
        (getattr(cfg, "path", "") or "").replace("\\", "/")
        if cfg
        else f"{root_rel}/playwright.config.ts"
    )
    cfg_abs = root / cfg_rel
    body = (getattr(cfg, "content", "") or "").strip() if cfg else ""
    need_write = (not cfg_abs.is_file()) or cfg_abs.stat().st_size == 0
    if need_write:
        if not body:
            body = default_playwright_config(
                base_url=target_url,
                storage_state_rel="",
                headed=headed,
                include_global_setup=False,
            )
        write_target = cfg_abs
        if os.name == "nt":
            s = str(cfg_abs)
            if not s.startswith("\\\\?\\"):
                write_target = Path("\\\\?\\" + s)
        write_target.parent.mkdir(parents=True, exist_ok=True)
        write_target.write_text(body, encoding="utf-8")
        logger.info("E2E materialize config → %s", cfg_rel)
    return str(cfg_abs.resolve())


async def _run_one_e2e_root(
    *,
    runner: RunCommandFn,
    project_root: str,
    root_rel: str,
    root_files: list[E2EFile],
    all_files: list[E2EFile] | None = None,
    headed: bool,
    run_command: Sequence[str] | None,
    runner_prefix: str | None,
    target_url: str = "",
) -> tuple[list[E2ESpecRunResult], list[str], str, str | None]:
    """
    Run Playwright for a single TC/module folder — **one** canonical spec only.
    Sequential by design (caller loops roots one-by-one; CLI ``--workers=1``).
    Returns (spec_results, run_command, log_tail, work_cwd).
    Test failures are returned as failed specs — caller continues to next root.
    """
    bundle = list(all_files or root_files)
    # Re-write any missing shared POM/fixtures + this root's files (rollback-safe).
    _materialize_files_on_disk(project_root, bundle)

    specs_rel = [
        f.path.replace("\\", "/")
        for f in root_files
        if "/specs/" in f.path.replace("\\", "/")
        and f.path.replace("\\", "/").endswith((".ts", ".js", ".mjs"))
    ]
    if not specs_rel:
        return [], [], "", None

    primary = _canonical_spec_under_root(specs_rel)
    config_arg = _ensure_root_config_on_disk(
        project_root=project_root,
        root_rel=root_rel,
        root_files=root_files,
        all_files=bundle,
        target_url=target_url,
        headed=headed,
    )
    work = Path(config_arg).parent
    work_cwd = str(work)
    try:
        spec_arg = str(
            (Path(project_root).resolve() / primary).resolve().relative_to(work)
        ).replace("\\", "/")
    except ValueError:
        spec_arg = str((Path(project_root).resolve() / primary).resolve())

    if run_command is not None:
        cmd = apply_headed_flag(list(run_command), headed=headed)
    else:
        # Pass the single file (not specs/) so twin .hash.spec.ts files do not all run.
        cmd = default_playwright_run_command(
            spec_arg,
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
            E2ESpecRunResult(spec_path=primary, success=False, error_excerpt=detail)
        ]
        return failed, cmd, detail, work_cwd

    log = _annotate_playwright_browser_errors(log)
    parsed = parse_playwright_json_report(log)
    # Map against the one intended primary; still list siblings as skipped-not-run? No —
    # only report the primary so FE does not think every twin failed.
    return (
        _map_module_spec_results(
            specs_rel=[primary], parsed=parsed, code=code, log=log
        ),
        cmd,
        log[-LOG_TAIL:] if log else "",
        work_cwd,
    )


_probe_cache: dict[str, tuple[float, str | None]] = {}
_PROBE_CACHE_TTL = 30.0  # seconds


def probe_e2e_target_url(url: str, *, timeout_sec: float = 5.0) -> str | None:
    """
    Return a short note when Target URL looks unhealthy.

    JHipster/Angular index.html often embeds «An error has occurred» in a
    noscript/fallback shell WHILE still serving main.js/vendor.js — that is NOT
    a dead SPA. Only FAIL when error markers appear without app bundles.
    """
    import time as _time

    u = (url or "").strip()
    if not u:
        return None
    cached = _probe_cache.get(u)
    if cached:
        ts, result = cached
        if _time.monotonic() - ts < _PROBE_CACHE_TTL:
            return result
    def _do_probe() -> str | None:
        try:
            import urllib.request

            req_ = urllib.request.Request(u, method="GET", headers={"User-Agent": "AITest-E2E-preflight"})
            with urllib.request.urlopen(req_, timeout=timeout_sec) as resp:
                raw = resp.read(12000).decode("utf-8", errors="replace")
        except Exception as exc:  # noqa: BLE001
            return f"WARN: Target URL không mở được ({type(exc).__name__}: {exc})"
        low = raw.lower()
        has_bundle = bool(
            re.search(
                r"""src=["'][^"']*(?:main|runtime|polyfills|vendor|chunk)[^"']*\.(?:js|mjs)""",
                low,
            )
        )
        has_error_shell = bool(
            re.search(
                r"an error has occurred|usual error causes|building the client side|"
                r"webpack compiled with",
                low,
            )
        )
        if has_error_shell and not has_bundle:
            return (
                "FAIL: Target URL đang trả SPA error/build page (không có bundle JS). "
                "Hãy start frontend của dự án đích rồi Verify lại."
            )
        if has_bundle:
            return None
        if "you must enable javascript" in low and "<script" not in low:
            return (
                "FAIL: Target URL không có script app (chỉ placeholder). "
                "Hãy start frontend rồi Verify lại."
            )
        return None

    out = _do_probe()
    _probe_cache[u] = (_time.monotonic(), out)
    return out


def e2e_verify_preflight_notes(
    *,
    target_url: str = "",
    storage_state_rel: str = "",
    env_extra: dict[str, str] | None = None,
) -> str:
    """Human-readable checklist before Playwright verify (any project)."""
    from app.services.e2e_auth_mode import resolve_auth_mode, wants_storage_state

    env = env_extra or {}
    notes: list[str] = []
    url = (target_url or env.get("E2E_BASE_URL") or "").strip()
    if not url:
        notes.append("WARN: thiếu Target URL / E2E_BASE_URL")
    else:
        notes.append(f"OK: baseURL={url}")
        probe = probe_e2e_target_url(url)
        if probe:
            notes.append(probe)

    user = (env.get("E2E_USERNAME") or "").strip()
    password = (env.get("E2E_PASSWORD") or "").strip()
    from app.services.e2e_auth_mode import is_public_no_auth_signal

    app_public = is_public_no_auth_signal(
        hints=" ".join(f"{k}={v}" for k, v in env.items() if "AUTH" in k.upper() or "PUBLIC" in k.upper()),
    )
    # Also treat missing creds + storage checkbox as soft public if env says so
    if (env.get("E2E_AUTH_MODE") or "").strip().lower() in ("public", "none", "no-auth"):
        app_public = True
    mode = resolve_auth_mode(
        use_storage=bool((storage_state_rel or "").strip()),
        app_public=app_public,
    )
    if wants_storage_state(mode):
        notes.append("authMode=storage (globalSetup seed → storageState)")
        if not user or not password:
            notes.append(
                "WARN: storage mode nhưng thiếu E2E_USERNAME/E2E_PASSWORD — "
                "seed sẽ fail nếu app hiện login wall"
            )
        else:
            notes.append("OK: E2E credentials present")
    elif mode == "ui_helper":
        notes.append("authMode=ui_helper (ensureAuthenticated)")
        if not user or not password:
            notes.append("WARN: ui_helper nhưng thiếu E2E_* credentials")
    elif mode == "public":
        notes.append("authMode=public (no login — skip storageState/globalSetup)")
    else:
        notes.append(f"authMode={mode}")

    return "[e2e preflight] " + " · ".join(notes)


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
    dom_snapshot: str = "",
    auth_hints: str = "",
) -> list[E2EFile]:
    """Ensure playwright.config.ts exists; authMode drives storageState + globalSetup."""
    from app.services.e2e_auth_mode import (
        is_login_or_auth_tc,
        is_public_no_auth_signal,
        resolve_auth_mode,
        wants_storage_state,
    )
    from app.services.e2e_codegen_guard import (
        is_valid_storage_state_json,
        looks_like_storage_state_path,
    )

    has_valid_state = any(
        looks_like_storage_state_path(f.path)
        and is_valid_storage_state_json(f.content or "")
        for f in files
    )
    path_blob = " ".join((f.path or "") for f in files)
    app_public = is_public_no_auth_signal(
        title=test_case_title or module,
        path=path_blob,
        dom_snapshot=dom_snapshot,
        hints=auth_hints,
    )
    auth_mode = resolve_auth_mode(
        use_storage=bool((storage_state_rel or "").strip()),
        has_valid_storage_json=has_valid_state,
        is_login_tc=is_login_or_auth_tc(test_case_title),
        app_public=app_public,
    )
    use_storage_cfg = wants_storage_state(auth_mode)
    # Desktop «Dùng storageState» alone must NOT write storageState into config when
    # the JSON is absent — Playwright loads it before tests and throws ENOENT.
    # Fall back to ui_helper (guards inject ensureAuthenticated). Only enable
    # storage mode when a valid storageState.json is already in the file bundle.
    if use_storage_cfg and not has_valid_state:
        use_storage_cfg = False
    if app_public:
        use_storage_cfg = False
    root = e2e_module_root(
        module, package_prefix=package_prefix,
        requirement_title=requirement_title, test_case_title=test_case_title,
    )
    # Prefer the folder that already holds specs/ so Verify does not
    # create playwright.config.ts under a title-based path while Specs stay elsewhere.
    # Never infer work_cwd from E2ETest/_shared (pages/fixtures live there).
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        low = p.lower()
        if "/specs/" in low or low.endswith(".spec.ts"):
            inferred = _spec_run_root(p)
            if inferred:
                root = inferred
                break

    from app.services.test_output_layout import e2e_shared_root
    import os as _os

    shared = e2e_shared_root(package_prefix=package_prefix)
    storage_shared = f"{shared}/fixtures/storageState.json"
    storage_for_cfg = ""
    if use_storage_cfg:
        storage_for_cfg = _os.path.relpath(storage_shared, root).replace("\\", "/")
        if not storage_for_cfg.startswith("."):
            storage_for_cfg = f"./{storage_for_cfg}"

    cfg_content = default_playwright_config(
        base_url=target_url,
        storage_state_rel=storage_for_cfg,
        headed=headed,
        include_global_setup=use_storage_cfg,
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
        has_storage_line = "storageState" in body
        storage_is_canonical = bool(
            re.search(
                r"""storageState\s*:\s*['"][^'"]*storageState\.json['"]""",
                body,
                flags=re.IGNORECASE,
            )
        )
        needs_refresh = (
            headed
            or "timeout:" not in body
            or "navigationTimeout" not in body
            or (headed and "headless: false" not in body)
            or (not headed and "headless: false" in body)
            or (headed and "slowMo" not in body)
            or (use_storage_cfg and not has_storage_line)
            or (use_storage_cfg and not storage_is_canonical)
            or (not use_storage_cfg and has_storage_line)
            or (use_storage_cfg and "globalSetup" not in body)
            or (not use_storage_cfg and "globalSetup" in body)
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

    # Batch / multi-TC: mỗi run root cần config riêng (headed + storage) — không chỉ root đầu.
    existing_cfg_dirs = {
        (f.path or "").replace("\\", "/").rsplit("/", 1)[0]
        for f in out
        if (f.path or "").replace("\\", "/").endswith("playwright.config.ts")
    }
    for root_rel, _root_files in _group_files_by_run_root(out):
        if not root_rel or root_rel in existing_cfg_dirs:
            continue
        out.append(
            E2EFile(
                path=f"{root_rel}/playwright.config.ts",
                content=cfg_content,
                kind="config",
            )
        )
        existing_cfg_dirs.add(root_rel)

    # globalSetup under suite _shared (config points here via relative path)
    existing_setups = {
        (f.path or "").replace("\\", "/").lower()
        for f in out
        if (f.path or "").replace("\\", "/").lower().endswith("global.setup.ts")
    }
    shared_setup = f"{shared}/fixtures/global.setup.ts"
    if use_storage_cfg:
        if shared_setup.lower() in existing_setups:
            for f in out:
                if (f.path or "").replace("\\", "/").lower() == shared_setup.lower():
                    f.content = _GLOBAL_SETUP_TS
        else:
            out.append(E2EFile(path=shared_setup, content=_GLOBAL_SETUP_TS, kind="fixture"))
        # Drop legacy per-TC global.setup copies
        out = [
            f
            for f in out
            if not (
                (f.path or "").replace("\\", "/").lower().endswith("global.setup.ts")
                and "/_shared/" not in (f.path or "").replace("\\", "/").lower()
            )
        ]
    else:
        out = [
            f
            for f in out
            if not (f.path or "")
            .replace("\\", "/")
            .lower()
            .endswith("global.setup.ts")
        ]
    return out


def _strip_storage_state_lines(text: str) -> str:
    """Remove storageState from config — dedicated lines and inline ``use: { ... }``."""
    out = re.sub(
        r"^[ \t]*storageState\s*:\s*.+?,?\s*$\n?",
        "",
        text or "",
        flags=re.MULTILINE | re.IGNORECASE,
    )
    # One-liner: use: { storageState: './fixtures/storageState.json', baseURL: ... }
    out = re.sub(
        r"""storageState\s*:\s*['\"][^'\"]*['\"]\s*,?""",
        "",
        out,
        flags=re.IGNORECASE,
    )
    return out


def _normalize_storage_state_line(text: str, *, storage_rel: str = "./fixtures/storageState.json") -> str:
    """Force storageState path relative to playwright.config.ts (TC or _shared)."""
    rel = (storage_rel or "./fixtures/storageState.json").replace("\\", "/")
    return re.sub(
        r"""(storageState\s*:\s*)(['"])[^'"]*\2""",
        rf'\1"{rel}"',
        text,
        flags=re.IGNORECASE,
    )


def _runtime_fix_missing_storage_state(
    work_cwd: str,
    *,
    config_arg: str | None,
) -> None:
    """
    Runtime safety-net against Playwright ENOENT on storageState.json.

    If the fixture is missing/invalid, always strip ``storageState`` (and
    ``globalSetup`` that only exists to seed it). Do not rely on globalSetup
    soft-skip — that previously left config pointing at a non-existent file.

    Checks TC-local ``./fixtures/`` and suite ``_shared/fixtures/`` (layout SoT).
    """
    from app.services.e2e_codegen_guard import is_valid_storage_state_json

    cfg_path = Path(config_arg) if config_arg and Path(config_arg).is_absolute() else (
        Path(work_cwd) / (config_arg or "playwright.config.ts")
    )
    if not cfg_path.is_file():
        # config_arg may be absolute while work_cwd is the TC folder
        alt = Path(work_cwd) / "playwright.config.ts"
        if not alt.is_file():
            return
        cfg_path = alt
    try:
        body = cfg_path.read_text(encoding="utf-8")
    except OSError:
        return
    if "storageState" not in body:
        return

    # Resolve candidates: keep existing relative path in config if present
    m = re.search(
        r"""storageState\s*:\s*['"]([^'"]+)['"]""",
        body,
        flags=re.IGNORECASE,
    )
    cfg_rel = (m.group(1) if m else "").replace("\\", "/").strip()
    cfg_dir = cfg_path.parent

    def _shared_fixtures_dir() -> Path | None:
        # {suite}/_shared/fixtures from {suite}/{Req}/{TC}/playwright.config.ts
        for parent in [cfg_dir, *cfg_dir.parents]:
            shared = parent / "_shared" / "fixtures"
            if shared.is_dir() or (parent / "_shared").is_dir():
                return shared
            # Stop at E2ETest or AItest
            if parent.name.lower() in ("e2etest", "aitest"):
                cand = parent / "_shared" / "fixtures"
                return cand
        return None

    shared_fix = _shared_fixtures_dir()
    shared_state = (
        (shared_fix / "storageState.json") if shared_fix is not None else None
    )

    candidates: list[Path] = []
    if cfg_rel:
        candidates.append((cfg_dir / cfg_rel).resolve())
    candidates.append(Path(work_cwd) / "fixtures" / "storageState.json")
    candidates.append(cfg_dir / "fixtures" / "storageState.json")
    if shared_state is not None:
        candidates.append(shared_state)

    has_valid = False
    valid_path: Path | None = None
    for candidate in candidates:
        try:
            if not candidate.is_file():
                continue
            raw = candidate.read_text(encoding="utf-8")
            if is_valid_storage_state_json(raw):
                has_valid = True
                valid_path = candidate
                break
        except OSError:
            continue

    if has_valid and valid_path is not None:
        try:
            storage_rel = os.path.relpath(valid_path, cfg_dir).replace("\\", "/")
            if not storage_rel.startswith("."):
                storage_rel = f"./{storage_rel}"
            normalized = _normalize_storage_state_line(body, storage_rel=storage_rel)
            if normalized != body:
                cfg_path.write_text(normalized, encoding="utf-8")
                logger.info(
                    "Normalized storageState path in config → %s (%s)",
                    storage_rel,
                    cfg_path,
                )
        except OSError:
            pass
        return

    # Missing / invalid — strip so Playwright does not ENOENT
    # Do NOT rewrite to ./fixtures first (that undid _shared relative paths).
    fixed = _strip_storage_state_lines(body)
    fixed = re.sub(
        r"^[ \t]*globalSetup\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\n",
        "",
        fixed,
        flags=re.MULTILINE,
    )
    if fixed != body:
        try:
            cfg_path.write_text(fixed, encoding="utf-8")
            logger.warning(
                "Removed storageState/globalSetup from config "
                "(missing/invalid storageState.json under TC or _shared): %s",
                cfg_path,
            )
        except OSError:
            pass

    # Specs may also hardcode storageState (nested AItest/... path) → ENOENT.
    from app.services.e2e_codegen_guard import strip_spec_storage_state

    scan_roots = {Path(work_cwd), cfg_path.parent}
    for root in scan_roots:
        for spec in root.rglob("*.spec.ts"):
            try:
                raw = spec.read_text(encoding="utf-8")
            except OSError:
                continue
            if "storageState" not in raw:
                continue
            cleaned = strip_spec_storage_state(raw)
            if cleaned != raw:
                try:
                    spec.write_text(cleaned, encoding="utf-8")
                    logger.warning(
                        "Removed storageState from spec (missing fixtures): %s",
                        spec,
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

    def write_files(self, files: list[E2EFile]) -> list[E2EFile]:
        """
        Write E2E artifacts under projectRoot. Returns files with paths shortened
        when needed (Windows MAX_PATH). Callers should use the returned list /
        remapped primarySpecPath for Playwright.
        """
        from app.services.test_output_layout import (
            assert_e2e_aitest_target_rel,
            shorten_e2e_rel_path,
        )

        root = Path(self.project_root).resolve()
        # Refuse writing into the AITest product repo (tool source), only target apps.
        if _looks_like_aitest_product_root(root):
            raise ValueError(
                "projectRoot đang trỏ vào source AITest (tool), không phải app đích. "
                "Hãy gắn Project root tới thư mục source code cần test "
                f"(hiện tại: {root}). File E2E sẽ ghi vào {{root}}/AItest/E2ETest/…"
            )
        written: list[E2EFile] = []
        for f in files:
            rel = assert_e2e_aitest_target_rel(f.path.replace("\\", "/"))
            rel = shorten_e2e_rel_path(rel)
            abs_path = root / rel
            # Prefer extended-length path on Windows when still near the limit
            write_target = abs_path
            if os.name == "nt":
                s = str(abs_path)
                if not s.startswith("\\\\?\\"):
                    write_target = Path("\\\\?\\" + s)
            write_target.parent.mkdir(parents=True, exist_ok=True)
            write_target.write_text(f.content, encoding="utf-8")
            written.append(
                E2EFile(path=rel, content=f.content, kind=getattr(f, "kind", "spec") or "spec")
            )
        return written

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
        from app.services.e2e_codegen_guard import apply_e2e_codegen_guards
        auth_hints = "\n".join(
            [
                req.precondition or "",
                req.steps or "",
                req.expected_result or "",
                req.project_rules or "",
                req.test_case_title or "",
            ]
        )
        # Scaffold config first, then guards normalize auth (storage missing → ui_helper).
        work_files = ensure_playwright_config(
            work_files,
            module=req.module or self.module,
            package_prefix=req.package_prefix
            if req.package_prefix is not None
            else self.package_prefix,
            target_url=req.target_url,
            storage_state_rel=req.storage_state_rel,
            headed=headed,
            test_case_title=req.test_case_title,
            dom_snapshot=req.dom_snapshot,
            auth_hints=auth_hints,
        )
        work_files = apply_e2e_codegen_guards(
            work_files,
            dom_snapshot=req.dom_snapshot,
            use_storage=bool((req.storage_state_rel or "").strip()),
            test_case_title=req.test_case_title,
            auth_hints=auth_hints,
            headed=headed,
            test_data=getattr(req, "test_data", None) or auth_hints or "",
        )
        primary_spec_path = _align_primary_spec_path(work_files, primary_spec_path)
        # Shorten oversized title folders before cwd/spec resolution (Windows MAX_PATH).
        work_files, primary_spec_path = _remap_e2e_files_short_paths(
            work_files, primary_spec_path
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

        merged_env: dict[str, str] = dict(env_extra or {})
        _ensure_auth_env_from_project(self.project_root, merged_env)
        _assert_feature_auth_ready(work_files, merged_env, req=req)
        target = (req.target_url or merged_env.get("E2E_BASE_URL") or "").strip()
        spa_probe = probe_e2e_target_url(target) if target else None
        if spa_probe and spa_probe.startswith("FAIL:"):
            raise RuntimeError(spa_probe)

        if write_file:
            work_files = self.write_files(work_files)
        _runtime_fix_missing_storage_state(work_cwd, config_arg=config_arg)
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
                    project_rules=req.project_rules,
                    user_rules=req.user_rules,
                    execution_context=req.execution_context,
                    feature_path=req.feature_path,
                    locator_contract=req.locator_contract,
                    pom_scaffold=req.pom_scaffold,
                    planner_hint=getattr(req, "planner_hint", "") or "",
                    index_version=getattr(req, "index_version", "") or "",
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
                            work_files = self.write_files(work_files)
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
                    requirement_title=req.requirement_title or "",
                    test_case_title=req.test_case_title or "",
                    journey_slug=re.sub(
                        r"[^a-zA-Z0-9_-]+",
                        "-",
                        (req.test_case_title or "journey"),
                    ).strip("-")
                    or "journey",
                )
                from app.services.e2e_codegen_guard import apply_e2e_codegen_guards

                resolved = apply_e2e_codegen_guards(
                    resolved,
                    dom_snapshot=req.dom_snapshot,
                    use_storage=bool((req.storage_state_rel or "").strip()),
                    test_case_title=req.test_case_title,
                    auth_hints="\n".join(
                        [
                            req.precondition or "",
                            req.steps or "",
                            req.expected_result or "",
                        ]
                    ),
                )
                # Merge by canonical path — last heal wins; drop superseded TC-local
                # pages/fixtures when the same leaf now lives under _shared.
                by_path = {f.path.replace("\\", "/"): f for f in work_files}
                for f in resolved:
                    by_path[f.path.replace("\\", "/")] = f
                shared_leaves: set[str] = set()
                for p in by_path:
                    low = p.lower()
                    if "/_shared/pages/" in low or "/_shared/fixtures/" in low:
                        shared_leaves.add(p.rsplit("/", 1)[-1].lower())
                if shared_leaves:
                    by_path = {
                        p: f
                        for p, f in by_path.items()
                        if not (
                            p.rsplit("/", 1)[-1].lower() in shared_leaves
                            and "/_shared/" not in p.lower()
                            and (
                                "/pages/" in p.lower()
                                or "/fixtures/" in p.lower()
                                or "/types/" in p.lower()
                            )
                        )
                    }
                work_files = list(by_path.values())
                if write_file:
                    work_files = self.write_files(work_files)

            return E2ESandboxHealResult(
                status="FAILED",
                primary_spec_path=primary_spec_path,
                files=work_files,
                attempts=max_retries,
                error_log=_clean_error_excerpt(last_log or "", limit=1200) or None,
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
        preflight = e2e_verify_preflight_notes(
            target_url=target_url,
            storage_state_rel=storage_state_rel,
            env_extra=env_extra,
        )
        mod = (module if module is not None else self.module) or ""
        pkg = package_prefix if package_prefix is not None else self.package_prefix
        # Verify/Apply often already has canonical AItest/E2ETest/{Req}/{TC}/… paths.
        # Re-running resolve_e2e_file_paths with only `module` would collapse TC folders.
        from app.llm.base import E2EFile as _E2EFile

        def _already_canonical(fs: list) -> bool:
            for f in fs:
                p = (getattr(f, "path", "") or "").replace("\\", "/").lower()
                if "e2etest" in p and (
                    "/specs/" in p
                    or p.endswith("playwright.config.ts")
                    or "/_shared/" in p
                ):
                    return True
            return False

        if _already_canonical(files):
            work_files = [
                _E2EFile(
                    path=getattr(f, "path", "") or "",
                    content=getattr(f, "content", "") or "",
                    kind=getattr(f, "kind", "spec") or "spec",
                )
                for f in files
            ]
        else:
            work_files = list(
                resolve_e2e_file_paths(files, module=mod, package_prefix=pkg)
            )
        from app.services.e2e_codegen_guard import (
            apply_e2e_codegen_guards,
            infer_feature_path_from_files,
        )
        work_files = ensure_playwright_config(
            work_files,
            module=mod,
            package_prefix=pkg,
            target_url=target_url,
            storage_state_rel=storage_state_rel,
            headed=headed,
            test_case_title=mod,
            auth_hints=mod,
        )
        feat = str((env_extra or {}).get("E2E_FEATURE_PATH") or "").strip()
        if not feat:
            feat = infer_feature_path_from_files(work_files)
        if feat:
            run_env_pre = dict(env_extra or {})
            run_env_pre["E2E_FEATURE_PATH"] = feat
            env_extra = run_env_pre
        work_files = apply_e2e_codegen_guards(
            work_files,
            # Verify: do not re-ground with empty DOM (would re-inject ungrounded throws).
            # Keep auth/config fixes only.
            dom_snapshot="",
            use_storage=bool((storage_state_rel or "").strip()),
            test_case_title=mod,
            auth_hints=mod,
            headed=headed,
            enforce_stubs=False,
            enforce_journey=False,
            feature_path=feat,
        )
        if not work_files:
            return E2EModuleRunResult(
                status="FAILED", log=preflight + "\nNo E2E files to run."
            )

        work_files, _ = _remap_e2e_files_short_paths(work_files, "")
        run_env = dict(env_extra or {})
        _ensure_auth_env_from_project(self.project_root, run_env)
        env_extra = run_env

        specs_rel = [
            f.path.replace("\\", "/")
            for f in work_files
            if "/specs/" in f.path.replace("\\", "/")
            and f.path.replace("\\", "/").endswith((".spec.ts", ".test.ts", ".spec.js", ".test.js"))
        ]
        if not specs_rel:
            return E2EModuleRunResult(
                status="FAILED",
                files=work_files,
                log=preflight + "\nNo specs/ files found for module run.",
            )

        if write_file:
            work_files = self.write_files(work_files)
            # Fill gaps after rollback / partial Apply (config + _shared/pages).
            _materialize_files_on_disk(self.project_root, work_files)

        # Group AFTER write/remap so config paths match disk.
        groups = _group_files_by_run_root(work_files)

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
            if check.source == "aitest" and check.package_root:
                from app.services.aitest_playwright_runner import ensure_shared_playwright_runner
                try:
                    await asyncio.to_thread(ensure_shared_playwright_runner, install_browsers=True)
                except Exception as _e:
                    logger.warning("ensure_shared_playwright_runner warn: %s", _e)
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
        tc_roots = [
            (r, fs)
            for r, fs in groups
            if any("/specs/" in (f.path or "").replace("\\", "/") for f in fs)
        ]
        logs: list[str] = [
            preflight,
            f"[e2e verify] sequential ×1 worker · {len(tc_roots)} TC folder(s)",
        ]
        last_cmd: list[str] = []
        last_cwd: str | None = None

        try:
            for root_rel, root_files in tc_roots:
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
                        all_files=work_files,
                        headed=headed,
                        run_command=run_command,
                        runner_prefix=runner_prefix,
                        target_url=target_url,
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
