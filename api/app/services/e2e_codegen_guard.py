"""
Deterministic post-processing for generated Playwright E2E code.

Fixes common AI drift without hardcoding project-specific routes:
- strict-mode duplicate button labels (tab vs form submit)
- Page Object method contract mismatches between spec and page files
- goto() asserting feature widgets before auth (login wall)
- missing ensureAuthenticated when no valid storageState
- Phase 2: Spec must keep Auth → Feature entry → Act order (fail codegen if missing)
- Phase 3: POM stubs use DOM selector_candidates; empty fake-pass stubs fail codegen
"""

from __future__ import annotations

import json
import os
import re
from typing import Iterable


class E2ECodegenJourneyError(ValueError):
    """Phase 2 — generated Spec missing Auth → Feature entry → Act (or wrong order)."""


class E2EStrictGateError(ValueError):
    """Strict gate violation with normalized category."""

    def __init__(self, category: str, detail: str):
        self.category = (category or "ExecutionGateFailed").strip()
        self.detail = (detail or "").strip()
        super().__init__(f"{self.category}: {self.detail}")


# Re-export Phase 3 error for callers importing from this module.
from app.services.e2e_stub_grounding import E2ECodegenStubError  # noqa: E402


# Generic login-wall helper (env-driven; no app-specific routes/credentials).
# Keep in sync with ensure_auth_helper_files() — guards always rewrite this file.
_AUTH_HELPER_TS = """\
\
/// <reference path="../types/playwright-shim.d.ts" />
import { expect, type Locator, type Page } from '@playwright/test';

const LOGIN_NAME = /đăng\\s*nhập|sign\\s*[-\\s]?in|log\\s*[-\\s]?in|login/i;
const ACCOUNT_NAME = /tài\\s*khoản|account|profile|user\\s*menu|avatar|menu/i;

/** Common login routes across SPA frameworks (Angular/JHipster/React/Vue). */
const COMMON_LOGIN_PATHS = [
  '/login',
  '/account/login',
  '/signin',
  '/sign-in',
  '/auth/login',
  '/#/login',
  '/#/account/login',
];

const LOGIN_FORM_WAIT_MS = Number(process.env.E2E_LOGIN_FORM_WAIT_MS || 6000);
const LOGIN_PATH_PROBE_MAX = Math.max(
  1,
  Number(process.env.E2E_LOGIN_PATH_PROBE_MAX || 3),
);

/**
 * Step 0 for feature journeys: reach + leave the login wall before POM actions.
 *
 * Learned from real suites (e.g. storageState + UI login + data-cy) but kept
 * project-agnostic:
 * 1) E2E_LOGIN_PATH
 * 2) COMMON_LOGIN_PATHS
 * 3) Accessible name / href / Account menu CTA
 * 4) Fill via data-cy|data-testid|name|id|role|label (JHipster-style username)
 * 5) After login, bridge sessionStorage auth tokens → localStorage (Playwright
 *    storageState only persists localStorage)
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const loginHeading = () => page.getByRole('heading', { name: LOGIN_NAME }).first();

  // Prefer stable test hooks used by many apps (data-cy / data-testid), then a11y.
  const userField = (): Locator =>
    page
      .locator(
        '[data-cy="username"], [data-testid="username"], [data-cy="email"], [data-testid="email"], ' +
          'input[name="username"], input[name="email"], #username, #email, ' +
          'input[autocomplete="username"], input[type="email"]',
      )
      .or(page.getByRole('textbox', { name: /email|e-?mail|tài khoản|username|user\\s*name/i }))
      .or(page.getByLabel(/email|e-?mail|tài khoản|username|user\\s*name/i))
      .first();

  const passwordField = (): Locator =>
    page
      .locator(
        '[data-cy="password"], [data-testid="password"], input[name="password"], #password, ' +
          'input[type="password"], input[autocomplete="current-password"]',
      )
      .or(page.getByRole('textbox', { name: /password|mật khẩu|passwd/i }))
      .or(page.getByLabel(/password|mật khẩu|passwd/i))
      .first();

  const submitBtn = (): Locator =>
    page
      .locator('[data-cy="submit"], [data-testid="submit"], button[type="submit"]')
      .or(page.locator('form').getByRole('button', { name: LOGIN_NAME }))
      .or(page.getByRole('button', { name: LOGIN_NAME }))
      .first();

  const isLoginWall = async (): Promise<boolean> => {
    if (await passwordField().isVisible().catch(() => false)) return true;
    return (
      (await userField().isVisible().catch(() => false)) ||
      (await loginHeading().isVisible().catch(() => false))
    );
  };

  const loginEntryCandidates = (): Locator[] => [
    page.getByRole('link', { name: LOGIN_NAME }).first(),
    page.getByRole('button', { name: LOGIN_NAME }).first(),
    page.getByRole('menuitem', { name: LOGIN_NAME }).first(),
    page
      .locator(
        'a[href*="login" i], a[href*="signin" i], a[href*="sign-in" i], a[href*="auth" i], ' +
          '[data-cy="login"], [data-testid="login"], [data-cy="accountMenu"]',
      )
      .first(),
  ];

  const anyLoginCtaVisible = async (): Promise<boolean> => {
    for (const loc of loginEntryCandidates()) {
      if (await loc.isVisible().catch(() => false)) return true;
    }
    return false;
  };

  const clickFirstVisible = async (locs: Locator[]): Promise<boolean> => {
    for (const loc of locs) {
      if (await loc.isVisible().catch(() => false)) {
        await loc.click({ timeout: 10000 }).catch(() => undefined);
        return true;
      }
    }
    return false;
  };

  const waitForLoginForm = async (ms = LOGIN_FORM_WAIT_MS): Promise<boolean> =>
    passwordField()
      .or(userField())
      .or(loginHeading())
      .first()
      .waitFor({ state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);

  const tryGotoLoginPath = async (raw: string): Promise<boolean> => {
    const path = raw.startsWith('http') ? raw : raw.startsWith('/') ? raw : `/${raw}`;
    await page.goto(path, { waitUntil: 'domcontentloaded' }).catch(() => undefined);
    return await waitForLoginForm(Math.min(LOGIN_FORM_WAIT_MS, 5000));
  };

  const openLoginEntry = async (): Promise<boolean> => {
    if (await isLoginWall()) return true;

    const explicit = (process.env.E2E_LOGIN_PATH || '').trim();
    const candidatePaths = [
      ...(explicit ? [explicit] : []),
      ...COMMON_LOGIN_PATHS,
    ];
    const deduped = [...new Set(candidatePaths)].slice(0, LOGIN_PATH_PROBE_MAX);
    for (const p of deduped) {
      if (await tryGotoLoginPath(p)) return true;
    }
    // Return to home before CTA clicks (last path may have been a 404).
    await page.goto('/', { waitUntil: 'domcontentloaded' }).catch(() => undefined);

    if (await clickFirstVisible(loginEntryCandidates())) {
      if (await waitForLoginForm()) return true;
    }

    const menuTriggers = [
      page.getByRole('button', { name: ACCOUNT_NAME }).first(),
      page.getByRole('link', { name: ACCOUNT_NAME }).first(),
      page
        .locator(
          '[aria-label*="account" i], [aria-label*="user" i], [aria-label*="tài khoản" i], ' +
            '[data-cy="accountMenu"], [data-testid="accountMenu"]',
        )
        .first(),
    ];
    if (await clickFirstVisible(menuTriggers)) {
      if (await clickFirstVisible(loginEntryCandidates())) {
        if (await waitForLoginForm()) return true;
      }
    }
    return await isLoginWall();
  };

  /** Copy JWT/session tokens from sessionStorage → localStorage (Playwright storageState). */
  const persistAuthTokens = async (): Promise<void> => {
    await page.evaluate(() => {
      const keyRe = /token|auth|jwt|session|access/i;
      for (let i = 0; i < sessionStorage.length; i++) {
        const k = sessionStorage.key(i);
        if (!k || !keyRe.test(k)) continue;
        const v = sessionStorage.getItem(k);
        if (v) localStorage.setItem(k, v);
      }
    }).catch(() => undefined);
  };

  await page.locator('body').waitFor({ state: 'visible', timeout: 20000 }).catch(() => undefined);
  await userField()
    .or(passwordField())
    .or(loginHeading())
    .or(page.getByRole('navigation'))
    .or(page.getByRole('main'))
    .or(page.getByRole('link', { name: LOGIN_NAME }))
    .or(page.getByRole('button', { name: LOGIN_NAME }))
    .first()
    .waitFor({ state: 'visible', timeout: 20000 })
    .catch(() => undefined);

  const roleHint = (process.env.E2E_ROLE || process.env.E2E_AUTH_ROLE || 'default').trim();
  const forceUiLogin = (process.env.E2E_FORCE_UI_LOGIN || '').trim() === '1';
  const storageStateHint = (process.env.E2E_STORAGE_STATE || '').trim();
  const roleSlug = roleHint.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const roleUser = forceUiLogin && roleSlug ? (process.env[`E2E_${roleSlug}_USERNAME`] || '').trim() : '';
  const rolePass = forceUiLogin && roleSlug ? (process.env[`E2E_${roleSlug}_PASSWORD`] || '').trim() : '';
  const user = forceUiLogin ? (roleUser || process.env.E2E_USERNAME || '').trim() : '';
  const pass = forceUiLogin ? (rolePass || process.env.E2E_PASSWORD || '').trim() : '';
  const hasCreds = Boolean(user && pass);
  const likelyAuthedSession = async (): Promise<boolean> => {
    const onLogin = await isLoginWall();
    if (onLogin) return false;
    const hasLoginCta = await anyLoginCtaVisible();
    if (!hasLoginCta) return true;
    const hasAccountMenu = await page
      .locator('[data-cy="accountMenu"], [data-testid="accountMenu"], [aria-label*="account" i]')
      .first()
      .isVisible()
      .catch(() => false);
    return hasAccountMenu;
  };

  if (await likelyAuthedSession()) {
    await persistAuthTokens();
    return;
  }

  // Default mode: if storageState is provided but login wall still appears,
  // fail fast with a clear message (avoid slow route/credential retries).
  if (storageStateHint && !forceUiLogin) {
    if (await isLoginWall()) {
      throw new Error(
        `AuthRequired: storageState='${storageStateHint}' provided but app is still on login wall. ` +
          `Reseed .ai-test/auth/${(roleHint || 'default').replace(/[^a-zA-Z0-9_-]+/g, '-')}.json or set E2E_FORCE_UI_LOGIN=1 to use UI credentials.`,
      );
    }
  }

  let onLogin = await isLoginWall();
  if (!onLogin) {
    onLogin = (await openLoginEntry()) || (await isLoginWall());
  }

  if (!onLogin) {
    // Credentials configured → must reach a login form (never soft-skip).
    if (hasCreds) {
      throw new Error(
        'E2E credentials are set but the login form was not found. ' +
          'Tried E2E_LOGIN_PATH + common routes (/login, /account/login, …) + login CTAs. ' +
          'Set E2E_LOGIN_PATH to the real login route, or ensure data-cy/data-testid/name=username|password. ' +
          `url=${page.url()} loginPath=${process.env.E2E_LOGIN_PATH || '(unset)'}`,
      );
    }
    if (!(await anyLoginCtaVisible())) {
      return; // no creds + no login surface → treat as public/already-auth
    }
    throw new Error(
      'App shows a login entry but the login form did not open. ' +
        'Set E2E_LOGIN_PATH (e.g. /login or /account/login), ' +
        'or ensure username/password fields use accessible names / data-cy / data-testid. ' +
        `url=${page.url()}`,
    );
  }

  const loginTab = page.getByRole('tab', { name: LOGIN_NAME }).first();
  if (await loginTab.isVisible().catch(() => false)) {
    await loginTab.click();
  }

  if (!hasCreds) {
    throw new Error(
      'App requires login but UI credential mode is off (or E2E_USERNAME / E2E_PASSWORD are not set). ' +
        'Set E2E_FORCE_UI_LOGIN=1 to allow credential login. ' +
        'For multi-role, set E2E_ROLE + E2E_<ROLE>_USERNAME/PASSWORD. ' +
        'Enter them on AITest → E2E → Môi trường, or Seed auth → .ai-test/auth/{role}.json.',
    );
  }

  await userField().fill(user);
  await passwordField().fill(pass);
  await passwordField().blur().catch(() => undefined);
  await expect(submitBtn()).toBeEnabled({ timeout: 15000 });

  const tryLogin = async () => {
    const authNetwork = page
      .waitForResponse(
        (r) => {
          if (r.request().method() === 'GET') return false;
          return /auth|login|signin|session|token|users?\\/sign|authenticate/i.test(r.url());
        },
        { timeout: 30000 },
      )
      .catch(() => null);
    await submitBtn().click();
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
    await signUpTab.click();
    await userField().fill(user);
    await passwordField().fill(pass);
    await passwordField().blur().catch(() => undefined);
    await expect(registerBtn).toBeEnabled({ timeout: 15000 });
    await registerBtn.click();
    if (await loginTab.isVisible().catch(() => false)) await loginTab.click();
    await userField().fill(user);
    await passwordField().fill(pass);
    await passwordField().blur().catch(() => undefined);
    await expect(submitBtn()).toBeEnabled({ timeout: 15000 });
    return Boolean((await tryLogin()).ok);
  };

  let loginRes = await tryLogin();
  if (!loginRes.ok) {
    if (await tryRegisterAndRelogin()) loginRes = { ok: true as const };
  }
  if (!loginRes.ok) {
    throw new Error(
      `Login HTTP ${loginRes.status} for ${loginRes.url}. ` +
        `Check E2E credentials (role=${roleHint || 'default'}). ` +
        `Sai mật khẩu / artifact cũ: xóa .ai-test/auth/${(roleHint || 'default').replace(/[^a-zA-Z0-9_-]+/g, '-')}.json ` +
        `rồi bấm «Seed auth (AI)» lại, hoặc «Ghi đè thủ công» đúng user/pass của app. ` +
        `${(loginRes.body || '').slice(0, 200)}`,
    );
  }

  try {
    await expect(passwordField()).toBeHidden({ timeout: 30000 });
  } catch {
    const leftLoginUrl = !/\\/login\\/?$/i.test(page.url());
    if (!leftLoginUrl) {
      if (await tryRegisterAndRelogin()) {
        await expect(passwordField()).toBeHidden({ timeout: 30000 });
      } else {
        const alertText =
          (
            await page
              .getByRole('alert')
              .or(
                page.locator(
                  '[data-cy="loginError"], [data-testid="loginError"], [role="status"], .error, .text-error',
                ),
              )
              .first()
              .textContent()
              .catch(() => null)
          )?.trim() || '';
        throw new Error(
          'Login did not leave the login wall (password still visible). ' +
            (alertText ? `UI message: ${alertText}. ` : '') +
            'Verify E2E username/password and Target URL.',
        );
      }
    }
  }

  await persistAuthTokens();
}
"""


# Login/Logout journeys only — not module names like AuthSmoke / auth-smoke.spec.
_LOGIN_SPEC_HINT_RE = re.compile(
    r"(?:^|/)(?:login|logout|signin|sign-in|signup|sign-up)(?:[-_.]|$)|"
    r"(?:^|/)auth(?:\.setup|/login|/logout)(?:[-_./]|$)|"
    r"đăng[\s_-]*nhập|đăng[\s_-]*xuất",
    re.IGNORECASE,
)

# Spec method name (lower) -> preferred existing page method (lower)
_METHOD_ALIASES: dict[str, str] = {
    "gotologin": "goto",
    "openlogin": "goto",
    "navigatetologin": "goto",
    "open": "goto",
    "assertloginformvisible": "expectloginformvisible",
    "assertloginformhidden": "expectloginformhidden",
    "assertstillonloginurl": "expectstillonloginpage",
    "assertsuccessfeedback": "expectsuccessfeedback",
    "assertjobmanagementvisible": "expectjobmanagementvisible",
    "assertsessionpersisted": "expectsessionpersisted",
    "logout": "clicklogout",
    "signout": "clicklogout",
    "clicksignout": "clicklogout",
}


_CLASS_RE = re.compile(r"export\s+class\s+(\w+)")
_EXPORT_FN_RE = re.compile(
    r"export\s+(?:async\s+)?function\s+(\w+)\s*\(",
    re.MULTILINE,
)
_EXPORT_TYPE_RE = re.compile(r"export\s+type\s+(\w+)\b")
_EXPORT_INTERFACE_RE = re.compile(r"export\s+interface\s+(\w+)\b")
# TS reserved / keywords that must never become import locals or stub fn names
_TS_IMPORT_RESERVED = frozenset(
    {"type", "typeof", "from", "import", "as", "assert", "with", "default"}
)
_TEST_STEP_TITLE_CALL_RE = re.compile(
    r"(test\.step\s*\(\s*)(['\"])([^'\"]+)\2",
    re.IGNORECASE,
)
_NEW_PAGE_RE = re.compile(
    r"(?:const|let)\s+(\w+)\s*=\s*new\s+(\w+)\s*\(",
    re.MULTILINE,
)
_METHOD_DEF_RE = re.compile(
    r"(?:async\s+)?(\w+)\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{",
    re.MULTILINE,
)
_METHOD_CALL_RE = re.compile(r"\.(\w+)\s*\(")
_UNSCOPED_BUTTON_ROLE_RE = re.compile(
    r"(?P<prefix>\b(?:this\.)?page)\.getByRole\(\s*['\"]button['\"]\s*,\s*"
    r"\{\s*name\s*:\s*(?P<name>(?:['\"][^'\"]+['\"]|/[^/]+/[a-z]*))\s*\}\s*\)",
    re.IGNORECASE,
)
# Spec↔POM import — sibling ../pages/ OR suite _shared/pages/ (any depth).
# import { A, B as C } from '../pages/foo'
# import { A } from '../../../_shared/pages/foo.page'
_SPEC_PAGE_IMPORT_RE = re.compile(
    r"""import\s+\{\s*(?P<names>[^}]+)\s*\}\s+from\s+['"]"""
    r"""(?P<imp>(?:[^'"]*?/)?pages/(?P<leaf>[^'"]+))['"]""",
    re.IGNORECASE,
)


def _norm_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _parse_import_entries(names_blob: str) -> list[tuple[str, bool]]:
    """Parse named import list → [(local_name, is_type_only), ...].

    Supports:
      Foo | Bar as Baz | type Foo | type Bar as Baz
    Skips orphan keyword ``type`` (no identifier) — that previously became
    ``import { Page, type }`` and broke Playwright/tsc.
    """
    out: list[tuple[str, bool]] = []
    for part in (names_blob or "").split(","):
        part = part.strip()
        if not part:
            continue
        is_type = False
        # inline type-only: `type Foo` / `type Foo as Bar`
        tm = re.match(r"^type(?:\s+|$)(.*)$", part, re.IGNORECASE)
        if tm:
            is_type = True
            part = (tm.group(1) or "").strip()
            if not part:
                # orphan `type` keyword alone — drop
                continue
        m = re.match(r"(\w+)(?:\s+as\s+(\w+))?", part, re.IGNORECASE)
        if not m:
            continue
        local = m.group(2) or m.group(1)
        if not local or local.lower() in _TS_IMPORT_RESERVED:
            continue
        out.append((local, is_type))
    return out


def _parse_import_names(names_blob: str) -> list[str]:
    """Parse `Foo, type Bar as Baz` → ['Foo', 'Baz'] (local binding names)."""
    return [name for name, _ in _parse_import_entries(names_blob)]


def _exported_page_symbols(page_content: str) -> tuple[str | None, set[str]]:
    """Return (primary export class, set of exported class/fn/type/interface names)."""
    classes = _CLASS_RE.findall(page_content or "")
    primary = classes[0] if classes else None
    syms: set[str] = set(classes)
    syms |= set(_EXPORT_FN_RE.findall(page_content or ""))
    syms |= set(_EXPORT_TYPE_RE.findall(page_content or ""))
    syms |= set(_EXPORT_INTERFACE_RE.findall(page_content or ""))
    return primary, syms


def renumber_spec_test_steps(content: str) -> str:
    """Rewrite ``test.step`` titles to continuous indexes ``0..N`` in doc order.

    Auth/Feature inject adds ``0.`` / ``1.`` while LLM often restarts Act at ``1.``.
    That breaks step capture / headed step runner — normalize after inject.
    """
    text = content or ""
    if not _TEST_STEP_TITLE_CALL_RE.search(text):
        return text
    n = 0

    def _repl(m: re.Match[str]) -> str:
        nonlocal n
        prefix, quote, title = m.group(1), m.group(2), m.group(3)
        rest = re.sub(r"^\d+\.\s*", "", title).strip() or title.strip()
        out = f"{prefix}{quote}{n}. {rest}{quote}"
        n += 1
        return out

    return _TEST_STEP_TITLE_CALL_RE.sub(_repl, text)


def _strip_orphan_type_imports(content: str) -> str:
    """Remove bare ``type`` tokens left in ``import { Foo, type }`` lists."""
    text = content or ""

    def _repl(m: re.Match[str]) -> str:
        names = m.group("names")
        entries = _parse_import_entries(names)
        if not entries:
            # drop entire import if nothing left
            return ""
        parts: list[str] = []
        for name, is_type in entries:
            parts.append(f"type {name}" if is_type else name)
        return f"import {{ {', '.join(parts)} }} from {m.group('quote')}{m.group('mod')}{m.group('quote')}"

    return re.sub(
        r"""import\s+\{\s*(?P<names>[^}]+)\s*\}\s+from\s+(?P<quote>['"])(?P<mod>[^'"]+)(?P=quote)\s*;?""",
        _repl,
        text,
        flags=re.IGNORECASE,
    )


def _collect_static_class_calls(spec_content: str, class_name: str) -> set[str]:
    """ClassName.method( — AI often emits static POM calls (runtime TypeError)."""
    calls: set[str] = set()
    if not class_name:
        return calls
    pattern = re.compile(rf"\b{re.escape(class_name)}\.(\w+)\s*\(")
    for m in pattern.finditer(spec_content or ""):
        name = m.group(1)
        if name not in {"prototype", "name", "length", "caller", "bind", "call", "apply"}:
            calls.add(name)
    return calls


def _ensure_page_binding(
    spec_content: str, class_name: str, *, page_param: str = "page"
) -> tuple[str, str]:
    """
    Ensure `const <var> = new ClassName(page)` exists; return (spec, var_name).
    Prefers existing binding.
    """
    for var, cls in _find_page_bindings(spec_content):
        if cls == class_name:
            return spec_content, var
    var = "pom"
    # Avoid collision
    if re.search(rf"\bconst\s+{var}\b|\blet\s+{var}\b", spec_content):
        var = f"{class_name[:1].lower()}{class_name[1:]}" if class_name else "pageObj"
        if re.search(rf"\bconst\s+{re.escape(var)}\b", spec_content):
            var = "pageObj"
    insert = f"  const {var} = new {class_name}({page_param});\n"
    # After test( callback's first `{` that has `async ({ page`
    m = re.search(
        r"test(?:\.(?:only|skip))?[^\{]*\{[^\n]*\n",
        spec_content,
    )
    if m:
        spec_content = spec_content[: m.end()] + insert + spec_content[m.end() :]
    else:
        spec_content = insert + spec_content
    return spec_content, var


def _rewrite_static_calls_to_instance(
    spec_content: str, class_name: str, var_name: str
) -> str:
    if not class_name or not var_name:
        return spec_content
    return re.sub(
        rf"\b{re.escape(class_name)}\.(\w+)\s*\(",
        rf"{var_name}.\1(",
        spec_content,
    )


def _align_spec_imports_to_page(
    spec_content: str, page_content: str, *, leaf_hint: str = ""
) -> tuple[str, str]:
    """
    Make Spec imports match page exports (Rule 18).
    - Rename imported class → export class when mismatched
    - Stub missing helper exports on the page file
    - Preserve TS ``type`` imports; never emit orphan ``type`` keyword
    """
    primary, exported = _exported_page_symbols(page_content)
    if not primary and not exported:
        return spec_content, page_content

    spec = spec_content
    page = page_content

    def _leaf_matches(leaf: str) -> bool:
        if not leaf_hint:
            return True
        leaf_l = leaf.lower().replace(".ts", "").replace(".page", "")
        hint_l = leaf_hint.lower().replace(".ts", "").replace(".page", "")
        return (not leaf_l) or (not hint_l) or leaf_l in hint_l or hint_l in leaf_l

    # Pass 1: rename wrong class identifiers in Spec body
    for m in list(_SPEC_PAGE_IMPORT_RE.finditer(spec)):
        leaf = (m.group("leaf") or "").strip()
        if not _leaf_matches(leaf):
            continue
        for name, _is_type in _parse_import_entries(m.group("names")):
            if name in exported:
                continue
            if not primary:
                continue
            class_like = (
                name[:1].isupper()
                or name.lower().endswith("page")
                or bool(re.search(rf"\bnew\s+{re.escape(name)}\s*\(", spec))
            )
            if class_like:
                spec = re.sub(rf"\b{re.escape(name)}\b", primary, spec)

    # Pass 2: rebuild import lists + stub missing helpers
    def _repl_import(m: re.Match[str]) -> str:
        nonlocal page, exported
        leaf = (m.group("leaf") or "").strip()
        if not _leaf_matches(leaf):
            return m.group(0)
        keep: list[str] = []
        seen: set[str] = set()
        for name, is_type in _parse_import_entries(m.group("names")):
            if name.lower() in _TS_IMPORT_RESERVED:
                continue
            if name in exported:
                token = f"type {name}" if is_type else name
                if name not in seen:
                    keep.append(token)
                    seen.add(name)
                continue
            if primary and (
                name[:1].isupper()
                or name.lower().endswith("page")
                or bool(re.search(rf"\bnew\s+{re.escape(name)}\s*\(", spec))
            ):
                if primary not in seen:
                    keep.append(primary)
                    seen.add(primary)
                continue
            # Type-only missing symbol: keep as type import if still referenced;
            # do NOT stub a runtime function named after a type.
            if is_type:
                if name not in seen:
                    keep.append(f"type {name}")
                    seen.add(name)
                continue
            if (
                f"function {name}" not in page
                and f"export async function {name}" not in page
                and f"export function {name}" not in page
            ):
                # SYNC string — Specs pass this into setInputFiles/getByText without await.
                # async Promise<string> coerced to "[object Promise]" / path TypeError.
                page = (
                    page.rstrip()
                    + f"\nexport function {name}(..._args: unknown[]): string {{\n"
                    + "  // Guard stub — sync path/label for upload & asserts (never Promise).\n"
                    + "  return String(_args[0] ?? 'fixtures/generated.bin');\n"
                    + "}\n"
                )
                exported = set(exported)
                exported.add(name)
            if name not in seen:
                keep.append(name)
                seen.add(name)
        if not keep and primary:
            keep = [primary]
        if not keep:
            return m.group(0)
        # Preserve original import path (_shared/pages vs ../pages) — only fix names.
        imp = (m.group("imp") or f"../pages/{leaf}").replace("\\", "/")
        imp = re.sub(r"\.tsx?$", "", imp, flags=re.IGNORECASE)
        return f"import {{ {', '.join(keep)} }} from '{imp}'"

    spec = _SPEC_PAGE_IMPORT_RE.sub(_repl_import, spec)
    spec = _strip_orphan_type_imports(spec)
    return spec, page


def _extract_class_methods(page_content: str, class_name: str) -> set[str]:
    """Return method names declared on the target exported class."""
    methods: set[str] = set()
    class_match = re.search(
        rf"export\s+class\s+{re.escape(class_name)}\b[^{{]*\{{",
        page_content,
        re.DOTALL,
    )
    if not class_match:
        return methods
    body_start = class_match.end()
    depth = 1
    i = body_start
    while i < len(page_content) and depth > 0:
        ch = page_content[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
        i += 1
    class_body = page_content[body_start : i - 1]
    skip = {
        "constructor",
        "if",
        "for",
        "while",
        "switch",
        "catch",
        "return",
        "await",
        "async",
        "function",
        "new",
        "typeof",
        "instanceof",
    }
    for m in _METHOD_DEF_RE.finditer(class_body):
        name = m.group(1)
        if name not in skip:
            methods.add(name)
    return methods


def _find_page_bindings(spec_content: str) -> list[tuple[str, str]]:
    """Return (var_name, class_name) pairs from spec instantiations."""
    out: list[tuple[str, str]] = []
    for m in _NEW_PAGE_RE.finditer(spec_content):
        out.append((m.group(1), m.group(2)))
    return out


def _collect_spec_method_calls(spec_content: str, var_name: str) -> set[str]:
    calls: set[str] = set()
    pattern = re.compile(rf"\b{re.escape(var_name)}\.(\w+)\s*\(")
    for m in pattern.finditer(spec_content):
        calls.add(m.group(1))
    if re.search(
        rf"\b{re.escape(var_name)}\.submitButton\.isEnabled\s*\(",
        spec_content,
        flags=re.IGNORECASE,
    ):
        calls.add("isSubmitEnabled")
    return calls


def _render_missing_page_file(class_name: str, methods: set[str]) -> str:
    calls = sorted(m for m in methods if m not in {"constructor"})
    keyset = {c.lower() for c in calls}
    login_like = (
        "login" in (class_name or "").lower()
        or "fillemail" in keyset
        or "fillpassword" in keyset
        or "clicksubmit" in keyset
        or "expectsubmitdisabled" in keyset
    )
    body = [
        '/// <reference path="../types/playwright-shim.d.ts" />',
        "import { expect, type Locator, type Page } from '@playwright/test';",
        "",
        f"export class {class_name} {{",
        "  readonly page: Page;",
    ]
    if login_like:
        body.extend(
            [
                "  readonly emailInput: Locator;",
                "  readonly passwordInput: Locator;",
                "  readonly submitButton: Locator;",
            ]
        )
    body.extend(
        [
            "",
            "  constructor(page: Page) {",
            "    this.page = page;",
        ]
    )
    if login_like:
        body.extend(
            [
                "    this.emailInput = page.locator('input[type=\"email\"], input[name*=\"email\" i], input[id*=\"email\" i], input[autocomplete=\"username\"], input[type=\"text\"]').first();",
                "    this.passwordInput = page.locator('input[type=\"password\"], input[name*=\"pass\" i], input[id*=\"pass\" i], input[autocomplete=\"current-password\"]').first();",
                "    this.submitButton = page.locator('form button[type=\"submit\"], form [role=\"button\"], button[type=\"submit\"], [role=\"button\"]').first();",
            ]
        )
    body.extend(["  }", ""])

    for m in calls:
        low = m.lower()
        if low == "fillemail" and login_like:
            body.extend(
                [
                    "  async fillEmail(value: string): Promise<void> {",
                    "    await this.emailInput.fill(value);",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "fillpassword" and login_like:
            body.extend(
                [
                    "  async fillPassword(value: string): Promise<void> {",
                    "    await this.passwordInput.fill(value);",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "clicksubmit" and login_like:
            body.extend(
                [
                    "  async clickSubmit(): Promise<void> {",
                    "    await this.submitButton.click();",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "issubmitenabled" and login_like:
            body.extend(
                [
                    "  async isSubmitEnabled(): Promise<boolean> {",
                    "    return this.submitButton.isEnabled();",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "expectsubmitdisabled" and login_like:
            body.extend(
                [
                    "  async expectSubmitDisabled(): Promise<void> {",
                    "    await expect(this.submitButton).toBeDisabled();",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "expectstillonloginscreen" and login_like:
            body.extend(
                [
                    "  async expectStillOnLoginScreen(): Promise<void> {",
                    "    await expect(this.emailInput).toBeVisible();",
                    "    await expect(this.passwordInput).toBeVisible();",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "expectemailinvalid" and login_like:
            body.extend(
                [
                    "  async expectEmailInvalid(): Promise<void> {",
                    "    const ok = await this.emailInput.evaluate((el) => (el as HTMLInputElement).checkValidity());",
                    "    expect(ok).toBe(false);",
                    "  }",
                    "",
                ]
            )
            continue
        if low == "expecterrormessage" and login_like:
            body.extend(
                [
                    "  async expectErrorMessage(): Promise<void> {",
                    "    const errorLike = this.page.locator('[role=\"alert\"], [aria-live=\"assertive\"], .error, .alert, [data-testid*=\"error\" i], [aria-invalid=\"true\"]').first();",
                    "    await expect(errorLike).toBeVisible({ timeout: 10000 });",
                    "  }",
                    "",
                ]
            )
            continue
        if m == "goto":
            body.extend(
                [
                    "  async goto(): Promise<void> {",
                    "    await this.page.goto('/', { waitUntil: 'domcontentloaded' });",
                    "  }",
                    "",
                ]
            )
            continue
        # Locator getters — sync Locator; coerce string|RegExp (never .trim on non-string)
        if low.startswith(("get", "find", "locate")):
            body.append(_render_smart_method_stub(m).lstrip("\n"))
            continue
        if low.startswith(("expect", "assert")):
            body.append(_render_smart_method_stub(m).lstrip("\n"))
            continue
        if low.startswith("click") or "logout" in low or "registertab" in low or "logintab" in low:
            body.append(_render_smart_method_stub(m).lstrip("\n"))
            continue
        body.append(_render_smart_method_stub(m).lstrip("\n"))
    body.append("}")
    body.append("")
    return "\n".join(body)


def _shared_pages_dir_from_spec(spec_path: str) -> str | None:
    """``…/E2ETest/_shared/pages`` from a Spec under ``…/E2ETest/{Req}/{TC}/specs``."""
    parts = [s for s in (spec_path or "").replace("\\", "/").split("/") if s]
    for i, seg in enumerate(parts):
        if seg.lower() == "e2etest":
            return "/".join(parts[: i + 1] + ["_shared", "pages"])
    return None


def _ensure_referenced_page_files(files: list) -> list:
    """If Spec imports pages/*.page but file is missing, add fallback page file.

    Supports classic ``../pages/`` and suite ``_shared/pages/`` imports. Without
    this, AI Specs that import ``../../../_shared/pages/X`` with no POM file
    ship as Verify ``Cannot find module`` failures.
    """
    from app.llm.base import E2EFile

    out: list = list(files)
    existing = {(getattr(f, "path", "") or "").replace("\\", "/") for f in out}

    def _has_page(page_path: str) -> bool:
        if page_path in existing:
            return True
        # Match login.page.ts when import leaf is login.page / LoginPage drift.
        leaf = os.path.basename(page_path).lower()
        stem = re.sub(r"\.(tsx?|jsx?)$", "", leaf)
        stem_bare = re.sub(r"\.page$", "", stem)
        for ep in existing:
            if "/pages/" not in ep.replace("\\", "/").lower():
                continue
            eb = os.path.basename(ep).lower()
            es = re.sub(r"\.(tsx?|jsx?)$", "", eb)
            es_bare = re.sub(r"\.page$", "", es)
            if es == stem or es_bare == stem_bare or es == stem_bare:
                return True
        return False

    for f in list(out):
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        is_spec = getattr(f, "kind", "") == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
        if not is_spec:
            continue
        spec_dir = p.rsplit("/", 1)[0]
        tc_page_dir = spec_dir.rsplit("/", 1)[0] + "/pages"
        shared_page_dir = _shared_pages_dir_from_spec(p)
        content = getattr(f, "content", "") or ""
        bindings = _find_page_bindings(content)
        call_by_var = {var: _collect_spec_method_calls(content, var) for var, _ in bindings}
        for m in _SPEC_PAGE_IMPORT_RE.finditer(content):
            names = _parse_import_names(m.group("names"))
            leaf = m.group("leaf").strip()
            imp = (m.group("imp") or "").replace("\\", "/")
            # Prefer *Page class over type-only symbols (e.g. Step2RelatedDocRecord).
            cls = next(
                (n for n in names if n.lower().endswith("page")),
                None,
            ) or next(
                (n for n in names if n[:1].isupper()),
                names[0] if names else "GeneratedPage",
            )
            # Import may omit .ts extension.
            leaf_file = leaf if leaf.endswith(".ts") else f"{leaf}.ts"
            # Suite _shared import → create under _shared/pages (layout SoT).
            if "/_shared/" in imp.lower() and shared_page_dir:
                page_dir = shared_page_dir
            else:
                page_dir = tc_page_dir
            page_path = f"{page_dir}/{os.path.basename(leaf_file)}".replace("//", "/")
            if _has_page(page_path):
                continue
            methods: set[str] = set()
            for var, bound_cls in bindings:
                if bound_cls == cls:
                    methods |= call_by_var.get(var, set())
            methods |= _collect_static_class_calls(content, cls)
            methods.add("goto")
            out.append(
                E2EFile(
                    path=page_path,
                    content=_render_missing_page_file(cls, methods),
                    kind="page",
                )
            )
            existing.add(page_path)
    return out


def _button_names_from_dom(dom_snapshot: str) -> dict[str, int]:
    """Count button-like elements by accessible name from inspect JSON."""
    counts: dict[str, int] = {}
    if not dom_snapshot.strip():
        return counts
    try:
        data = json.loads(dom_snapshot)
    except Exception:
        return counts
    elements = data.get("elements") if isinstance(data, dict) else None
    if not isinstance(elements, list):
        return counts
    for el in elements:
        if not isinstance(el, dict):
            continue
        role = str(el.get("role") or el.get("tag") or "").lower()
        if role not in ("button", "submit"):
            continue
        name = str(el.get("name") or el.get("aria_label") or "").strip()
        if name:
            counts[name] = counts.get(name, 0) + 1
    # tablist hint in raw snapshot text
    low = dom_snapshot.lower()
    if "tablist" in low and "auth mode" in low:
        for key in list(counts.keys()):
            counts[key] = max(counts.get(key, 0), 2)
    return counts


def _looks_like_auth_page(content: str) -> bool:
    """Heuristic: login/register pages usually expose a password field."""
    low = content.lower()
    return (
        "passwordinput" in low.replace("_", "").replace("-", "")
        or 'type="password"' in low
        or "type='password'" in low
        or bool(re.search(r"password|passwd|mật\s*khẩu", low, re.IGNORECASE))
    )


def fix_duplicate_button_locators(content: str, *, dom_snapshot: str = "") -> str:
    """
    Scope ambiguous global button locators to form when duplicates are likely.

    Typical SPA auth UI: tab "Đăng nhập" + submit "Đăng nhập".
    Also applies on auth-like page objects even without DOM snapshot.
    """
    dup_names = {
        name
        for name, count in _button_names_from_dom(dom_snapshot).items()
        if count >= 2
    }
    snap_low = (dom_snapshot or "").lower()
    has_tab_hint = "tablist" in snap_low or bool(dup_names)
    auth_page = _looks_like_auth_page(content)

    def _repl(m: re.Match[str]) -> str:
        name_raw = m.group("name").strip()
        literal = name_raw.strip("'\"")
        if dup_names and literal not in dup_names:
            return m.group(0)
        if not has_tab_hint and not dup_names and not auth_page:
            return m.group(0)
        # Already scoped — leave unchanged
        window = content[max(0, m.start() - 80) : m.start()]
        if "locator(" in window or ".filter(" in window:
            return m.group(0)
        return (
            f"{m.group('prefix')}.locator('form')"
            f".getByRole('button', {{ name: {name_raw} }}).first()"
        )

    return _UNSCOPED_BUTTON_ROLE_RE.sub(_repl, content)


_BARE_BUTTON_ROLE_RE = re.compile(
    r"(?P<prefix>\b(?:this\.)?page)\.getByRole\(\s*['\"]button['\"]\s*\)",
    re.IGNORECASE,
)


def _scope_bare_button_to_form(content: str) -> str:
    """page.getByRole('button') without name → page.locator('form').getByRole('button')"""
    def _repl(m: re.Match[str]) -> str:
        window = content[max(0, m.start() - 80) : m.start()]
        if "locator(" in window or ".filter(" in window:
            return m.group(0)
        return f"{m.group('prefix')}.locator('form').getByRole('button')"
    return _BARE_BUTTON_ROLE_RE.sub(_repl, content)


_UNIVERSAL_EXPECT_ERROR_MESSAGE = """\
  async expectErrorMessage(): Promise<void> {
    const errorLike = this.page
      .locator('[role="alert"], [aria-live="assertive"], [aria-invalid="true"], .error, .alert, [data-testid*="error" i]')
      .first();
    if (await errorLike.isVisible().catch(() => false)) {
      await expect(errorLike).toBeVisible({ timeout: 10000 });
      return;
    }
    await this.page
      .getByText(/error|fail|invalid|lỗi|thất bại/i)
      .first()
      .waitFor({ state: 'visible', timeout: 5000 });
  }"""

_UNIVERSAL_EXPECT_LOGIN_REJECTED = """\
  async expectLoginRejected(): Promise<void> {
    const submitDisabled = await this.submitButton.isDisabled();
    if (submitDisabled) {
      await expect(this.submitButton).toBeDisabled();
      return;
    }
    const html5Invalid = await this.emailInput
      .evaluate((el) => !(el as HTMLInputElement).checkValidity())
      .catch(() => false);
    if (html5Invalid) {
      await this.expectOnLoginScreen();
      return;
    }
    const errorLike = this.page
      .locator('[role="alert"], [aria-live="assertive"], [aria-invalid="true"], .error, .alert, [data-testid*="error" i]')
      .first();
    if (await errorLike.isVisible().catch(() => false)) {
      await expect(errorLike).toBeVisible({ timeout: 10000 });
    }
    await this.expectOnLoginScreen();
  }"""

_LOGIN_REJECTED_METHOD_RE = re.compile(
    r"async\s+expectLoginRejected\s*\([^)]*\)\s*:\s*Promise<void>\s*\{",
    re.MULTILINE,
)
_ERROR_MESSAGE_METHOD_RE = re.compile(
    r"async\s+expectErrorMessage\s*\([^)]*\)\s*:\s*Promise<void>\s*\{",
    re.MULTILINE,
)


def _replace_ts_method(content: str, pattern: re.Pattern[str], replacement: str) -> str:
    m = pattern.search(content)
    if not m:
        return content
    start = m.start()
    brace_start = m.end() - 1
    depth = 0
    end = brace_start
    for i in range(brace_start, len(content)):
        ch = content[i]
        if ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                end = i + 1
                break
    if depth != 0:
        return content
    return content[:start] + replacement + content[end:]


def _rewrite_login_rejected_assertion(content: str) -> str:
    """Auth pages: accept HTML5 invalid email without visible error text."""
    if not _looks_like_auth_page(content):
        return content
    out = content
    if "async expectErrorMessage" in out:
        out = _replace_ts_method(out, _ERROR_MESSAGE_METHOD_RE, _UNIVERSAL_EXPECT_ERROR_MESSAGE)
    if "async expectLoginRejected" in out:
        out = _replace_ts_method(out, _LOGIN_REJECTED_METHOD_RE, _UNIVERSAL_EXPECT_LOGIN_REJECTED)
    return out


def _render_alias_method(method: str, target: str, *, base_url_param: bool = False) -> str:
    if base_url_param:
        return (
            f"\n  async {method}(baseURL?: string): Promise<void> {{\n"
            f"    await this.{target}(baseURL);\n"
            f"  }}\n"
        )
    return f"\n  async {method}(): Promise<void> {{\n    await this.{target}();\n  }}\n"


def _render_expect_still_on_login_page(*, method: str = "expectStillOnLoginPage") -> str:
    return (
        f"\n  async {method}(baseURL?: string): Promise<void> {{\n"
        "    const root = (baseURL || '/').replace(/\\/$/, '') || '/';\n"
        "    await expect(this.page).toHaveURL(new RegExp(`^${root.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}`));\n"
        "    await this.expectLoginFormVisible?.().catch(async () => {\n"
        "      await expect(this.emailInput).toBeVisible();\n"
        "    });\n"
        "  }\n"
    )


def _render_get_page_text() -> str:
    return (
        "\n  async getPageText(): Promise<string> {\n"
        "    return (await this.page.locator('body').innerText()) || '';\n"
        "  }\n"
    )


def _ts_visible_texts_from_arg_helper(*, indent: str = "    ") -> str:
    """
    Unpack Spec args for getByText asserts — never String(object) → '[object Object]'.
    Objects: assert each non-path string field (documentInfo, labels, …).
    """
    i = indent
    return (
        f"{i}const __aitestVisibleTexts = (raw: unknown): string[] => {{\n"
        f"{i}  if (raw == null) return [];\n"
        f"{i}  if (typeof raw === 'string') {{\n"
        f"{i}    const s = raw.trim();\n"
        f"{i}    if (!s) return [];\n"
        f"{i}    if (/fixtures[/\\\\]|\\.(bin|pdf|docx?|xlsx?|png|jpg|zip)$/i.test(s)) return [];\n"
        f"{i}    return [s];\n"
        f"{i}  }}\n"
        f"{i}  if (typeof raw === 'number' || typeof raw === 'boolean') return [String(raw)];\n"
        f"{i}  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {{\n"
        f"{i}    const out: string[] = [];\n"
        f"{i}    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {{\n"
        f"{i}      if (v == null) continue;\n"
        f"{i}      if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') continue;\n"
        f"{i}      const s = String(v).trim();\n"
        f"{i}      if (!s) continue;\n"
        f"{i}      if (/file|path/i.test(k) && /fixtures[/\\\\]|\\.(bin|pdf|docx?|xlsx?|png|jpg|zip)$/i.test(s)) continue;\n"
        f"{i}      if (/^\\[object \\w+\\]$/i.test(s)) continue;\n"
        f"{i}      out.push(s);\n"
        f"{i}    }}\n"
        f"{i}    return out;\n"
        f"{i}  }}\n"
        f"{i}  return [];\n"
        f"{i}}};\n"
    )


def infer_feature_path_from_text(
    *blobs: str,
    tokens: list[str] | None = None,
) -> str:
    """
    Portable Feature deep-link from Spec/POM/TC prose — never invent without evidence.

    Scores candidates so suite FE dumps (many /admin/*) do not steal the TC path.
    Prefer: Feature-entry prose · path leaf matching TC tokens · explicit markers.
    """
    text = "\n".join((b or "") for b in blobs)
    if not text.strip():
        return ""
    tok = [t.lower() for t in (tokens or []) if t and len(t) >= 3]

    scored: list[tuple[int, str]] = []

    def _add(raw: str, base: int) -> None:
        p = _normalize_feature_path(raw)
        if not p or _is_auth_feature_path(p):
            return
        leaf = p.rstrip("/").rsplit("/", 1)[-1].lower()
        score = base
        for t in tok:
            if t in leaf or leaf in t or t in p.lower():
                score += 4
        scored.append((score, p))

    for m in re.finditer(
        r"(?:E2E_FEATURE_PATH|Feature\s*entry|deep-?link|gotoFeature|feature\s*path)"
        r"[^\n]{0,80}?(/[A-Za-z][\w\-./]{1,100})",
        text,
        flags=re.IGNORECASE,
    ):
        # Skip error-string noise: "Feature entry: set E2E_FEATURE_PATH / Feature"
        frag = m.group(0)
        if re.search(r"set\s+E2E_FEATURE_PATH\s*/\s*Feature", frag, re.I):
            continue
        _add(m.group(1), 12)

    marked = re.search(
        r"(?m)^\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)",
        text,
        flags=re.IGNORECASE,
    )
    if marked:
        _add(marked.group(1).strip().strip("\"'"), 10)

    for m in re.finditer(
        r"(?<![\w/])(/(?:admin|app|portal|dashboard|console|features?|modules?|workspace)"
        r"/[A-Za-z][\w\-./]{1,80})(?![\w/])",
        text,
        flags=re.IGNORECASE,
    ):
        _add(m.group(1), 2)

    if not scored:
        return ""
    scored.sort(key=lambda x: (-x[0], -len(x[1])))
    best_score, best = scored[0]
    # Require some signal when only weak ABS hits (avoid random /admin/foo from FE dump)
    if best_score < 3 and tok:
        # still allow if leaf overlaps tokens at least once via re-check
        leaf = best.rsplit("/", 1)[-1].lower()
        if not any(t in leaf or leaf in t for t in tok):
            return ""
    if best_score < 2 and not tok:
        return best  # single weak hit OK when no tokens
    return best


def _tokens_from_blob(*blobs: str) -> list[str]:
    text = "\n".join((b or "") for b in blobs).lower()
    # strip diacritics lightly for VN
    try:
        import unicodedata

        text = "".join(
            c
            for c in unicodedata.normalize("NFD", text)
            if unicodedata.category(c) != "Mn"
        )
    except Exception:  # noqa: BLE001
        pass
    parts = re.split(r"[^a-z0-9]+", text)
    return [p for p in parts if len(p) >= 3]


def infer_feature_path_from_files(files: list, *, hint: str = "") -> str:
    """Suite-level fallback — prefer hint; else score across Specs (may be multi-TC)."""
    hinted = _normalize_feature_path(hint)
    if hinted:
        return hinted
    blobs: list[str] = []
    for f in files or []:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        c = getattr(f, "content", "") or ""
        low = p.lower()
        if (
            getattr(f, "kind", "") == "spec"
            or "/specs/" in f"/{low}/"
            or low.endswith(".spec.ts")
        ):
            # Specs only for suite fallback — avoid POM error strings / wrong bakes
            blobs.append(c)
            blobs.append(p)
    return infer_feature_path_from_text(*blobs, tokens=_tokens_from_blob(*blobs))


def infer_feature_path_for_pair(
    *,
    spec_path: str = "",
    spec_content: str = "",
    page_content: str = "",
    hint: str = "",
) -> str:
    """Per-TC path: Spec prose + path tokens beat suite/FE noise."""
    hinted = _normalize_feature_path(hint)
    tokens = _tokens_from_blob(spec_path, spec_content)
    # Prefer Spec alone first
    from_spec = infer_feature_path_from_text(
        spec_content, spec_path, tokens=tokens
    )
    if from_spec:
        return from_spec
    if hinted:
        return hinted
    return infer_feature_path_from_text(
        spec_content, page_content, spec_path, tokens=tokens
    )


def _normalize_feature_path(raw: str) -> str:
    p = (raw or "").strip().replace("\\", "/").strip("\"'`")
    if not p:
        return ""
    if p.startswith("http://") or p.startswith("https://"):
        try:
            from urllib.parse import urlparse

            p = urlparse(p).path or p
        except Exception:  # noqa: BLE001
            pass
    if not p.startswith("/"):
        p = f"/{p}"
    p = re.sub(r"/{2,}", "/", p)
    if len(p) > 1 and p.endswith("/"):
        p = p[:-1]
    if re.search(r"\.(ts|js|css|png|svg|json)(\?|$)", p, re.I):
        return ""
    return p


def _is_auth_feature_path(path: str) -> bool:
    return bool(
        re.search(r"/(login|signin|sign-in|signup|sign-up|register|auth)(/|$)", path, re.I)
    )


def bake_feature_path_into_content(
    content: str, feature_path: str, *, force: bool = False
) -> str:
    """
    Fill / correct ``const baked = …`` in gotoFeature / Feature-entry stubs.

    force=True overwrites a wrong non-empty bake (suite noise → /admin/case-record).
    """
    path = _normalize_feature_path(feature_path)
    if not path or not content:
        return content or ""
    baked_js = json.dumps(path)
    text = content
    if force:
        text = re.sub(
            r"""(const\s+baked\s*=\s*)(?:""|''|"[^"]*"|'[^']*')(\s*;)""",
            rf"\1{baked_js}\2",
            text,
        )
    else:
        text = re.sub(
            r"""(const\s+baked\s*=\s*)(?:""|'')(\s*;)""",
            rf"\1{baked_js}\2",
            text,
        )
    return text


def _bake_feature_paths_per_tc(files: list, *, hint: str = "") -> list:
    """Bake the right deep-link into each Spec↔POM pair (never one path for whole suite)."""
    from app.llm.base import E2EFile

    specs = []
    pages_by_leaf: dict[str, object] = {}
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        low = p.lower()
        is_spec = (
            getattr(f, "kind", "") == "spec"
            or "/specs/" in f"/{low}/"
            or low.endswith(".spec.ts")
        )
        is_page = (
            getattr(f, "kind", "") == "page"
            or "/pages/" in f"/{low}/"
            or low.endswith(".page.ts")
        )
        if is_spec:
            specs.append(f)
        if is_page:
            pages_by_leaf[p.rsplit("/", 1)[-1].lower()] = f

    for spec in specs:
        sp = (getattr(spec, "path", "") or "").replace("\\", "/")
        sc = getattr(spec, "content", "") or ""
        # Resolve linked page from import
        page_f = None
        for m in re.finditer(r"""from\s+['"]([^'"]+)['"]""", sc):
            leaf = m.group(1).rsplit("/", 1)[-1].lower()
            if not leaf.endswith(".page") and "pages/" not in m.group(1).replace("\\", "/"):
                continue
            if not leaf.endswith(".ts"):
                leaf = f"{leaf}.ts" if leaf.endswith(".page") else f"{leaf}.page.ts"
            if leaf.endswith(".page"):
                leaf = f"{leaf}.ts"
            page_f = pages_by_leaf.get(leaf) or pages_by_leaf.get(
                leaf.replace(".ts", "") + ".ts"
            )
            if page_f:
                break
        pc = getattr(page_f, "content", "") or "" if page_f else ""
        path = infer_feature_path_for_pair(
            spec_path=sp, spec_content=sc, page_content=pc, hint=hint
        )
        if not path:
            continue
        spec.content = bake_feature_path_into_content(sc, path, force=True)
        if page_f is not None:
            page_f.content = bake_feature_path_into_content(pc, path, force=True)

    # Shared pages not imported by any Spec in this batch — bake from filename tokens only
    for leaf, page_f in pages_by_leaf.items():
        pc = getattr(page_f, "content", "") or ""
        if re.search(r"""const\s+baked\s*=\s*(?:""|''|"/admin/[^"]+")""", pc):
            path = infer_feature_path_for_pair(
                spec_path=getattr(page_f, "path", "") or "",
                spec_content="",
                page_content=pc,
                hint=hint,
            )
            # Only force-fix when filename tokens align with inferred path (no domain noun list)
            if path and leaf and leaf.replace(".page.ts", "").replace("-", ""):
                # Prefer leaf-aligned path
                leaf_tok = re.sub(r"[^a-z0-9]+", "-", leaf.replace(".page.ts", ""))
                aligned = infer_feature_path_from_text(
                    getattr(page_f, "path", "") or "",
                    pc,
                    tokens=_tokens_from_blob(leaf_tok, hint),
                )
                use = aligned or path
                # Require leaf token appears in path — avoid baking unrelated suite noise
                leaf_core = re.sub(r"[^a-z0-9]+", "", leaf_tok)
                if use and leaf_core and leaf_core in use.lower().replace("-", "").replace("/", ""):
                    page_f.content = bake_feature_path_into_content(pc, use, force=True)

    return files


def _render_feature_nav_stub(method: str, *, feature_path: str = "") -> str:
    """
    Navigation / open-feature POM methods — deep-link via E2E_FEATURE_PATH (or bake).

    No baked sidebar/menu selectors (those are project-specific). Collapsed nav is
    handled by setting Feature Feature path, or by AI/Phase-3 stubs grounded from
    that project's Inspect DOM — never a fixed toggle list.
    """
    name = method or "gotoFeature"
    baked = (feature_path or "").strip().replace("\\", "/")
    if baked and not baked.startswith("/") and not baked.startswith("http"):
        baked = f"/{baked}"
    baked_js = json.dumps(baked) if baked else '""'
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        f"    const baked = {baked_js};\n"
        "    const featurePath = (baked || process.env.E2E_FEATURE_PATH || '').trim();\n"
        "    if (!featurePath) {\n"
        "      throw new Error(\n"
        "        'Feature entry: set E2E_FEATURE_PATH / Feature path (deep-link). '\n"
        "        + 'Do not invent sidebar toggles — ground menu from Inspect DOM if path unknown.'\n"
        "      );\n"
        "    }\n"
        "    const path = featurePath.startsWith('http') || featurePath.startsWith('/')\n"
        "      ? featurePath\n"
        "      : `/${featurePath}`;\n"
        "    await this.page.goto(path, { waitUntil: 'domcontentloaded' });\n"
        "    await this.page.locator('main, [role=\"main\"], nav, h1, h2, [data-cy], [data-testid]')\n"
        "      .first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);\n"
        "    const seed = typeof _args[0] === 'string' ? String(_args[0]).trim() : '';\n"
        f"    const wantsStep2 = /step\\s*2|openstep2|gotostep2|tostep2|andopen/i.test({json.dumps(name)});\n"
        f"    const wantsCreate = /create|openform|openmodal|newpopup|themmoi/i.test({json.dumps(name)});\n"
        "    if (wantsCreate || wantsStep2) {\n"
        "      const addBtn = this.page.getByRole('button', {\n"
        "        name: /tạo mới|thêm mới|create|add(?! to)|new|\\+/i,\n"
        "      }).first();\n"
        "      if (await addBtn.isVisible().catch(() => false)) await addBtn.click();\n"
        "    }\n"
        "    if (seed) {\n"
        "      const box = this.page.locator(\n"
        "        'input[type=\"text\"], input:not([type]), textarea, [role=\"textbox\"]'\n"
        "      ).first();\n"
        "      if (await box.isVisible().catch(() => false)) await box.fill(seed);\n"
        "    }\n"
        "    if (seed || wantsStep2) {\n"
        "      const nextBtn = this.page.getByRole('button', { name: /tiếp|next|continue/i }).first();\n"
        "      if (await nextBtn.isVisible().catch(() => false)) await nextBtn.click();\n"
        "    }\n"
        "  }\n"
    )


def _is_feature_nav_method(method: str) -> bool:
    norm = _norm_key(method or "")
    if not norm:
        return False
    if norm.startswith("goto") and "login" not in norm:
        return True
    if "gotofeature" in norm or "openfeature" in norm or "openform" in norm:
        return True
    if norm.startswith("open") and any(
        x in norm for x in ("feature", "module", "page", "list", "create", "wizard", "step")
    ):
        return True
    return False


def _is_menu_nav_method(method: str) -> bool:
    """selectEvidenceMenu / clickSidebarXxx / openNavItem — not Phase-3 throw."""
    norm = _norm_key(method or "")
    if not norm:
        return False
    has_nav = any(
        x in norm for x in ("menu", "sidebar", "sidenav", "navitem", "menuitem", "drawer")
    )
    if not has_nav:
        return False
    return bool(
        re.match(r"^(select|click|open|goto|choose|pick|navigate|go)", norm)
        or norm.endswith("menu")
        or "sidebar" in norm
    )


def _menu_hint_regex_from_method(method: str) -> str:
    """selectEvidenceMenu → 'evidence' for /evidence/i (language-agnostic token)."""
    from app.services.e2e_stub_grounding import method_tokens

    stop = {
        "menu",
        "sidebar",
        "sidenav",
        "nav",
        "item",
        "link",
        "module",
        "drawer",
        "navitem",
        "menuitem",
    }
    tokens = [t for t in method_tokens(method or "") if t not in stop and len(t) >= 3]
    if not tokens:
        return ".*"
    # Longest token first for specificity
    tokens.sort(key=len, reverse=True)
    return tokens[0]


def _render_menu_nav_stub(method: str, *, feature_path: str = "") -> str:
    """
    Soft menu/sidebar navigation — portable across apps/languages.
    Prefer Spec arg label; else method-name token; else no-op if already on feature shell;
    else deep-link E2E_FEATURE_PATH. Never Phase-3 throw mid-journey.
    """
    name = method or "selectMenu"
    hint = _menu_hint_regex_from_method(name)
    hint_js = json.dumps(hint)
    baked = (feature_path or "").strip().replace("\\", "/")
    if baked and not baked.startswith("/") and not baked.startswith("http"):
        baked = f"/{baked}"
    baked_js = json.dumps(baked) if baked else '""'
    return f"""
  async {name}(..._args: unknown[]): Promise<void> {{
    const raw = _args.length ? _args[0] : undefined;
    const hint = new RegExp({hint_js}, 'i');
    const byArg = raw instanceof RegExp
      ? this.page.getByRole('link', {{ name: raw }})
          .or(this.page.getByRole('button', {{ name: raw }}))
          .or(this.page.getByRole('menuitem', {{ name: raw }}))
          .first()
      : typeof raw === 'string' && raw.trim()
        ? this.page.getByRole('link', {{ name: raw }})
            .or(this.page.getByRole('button', {{ name: raw }}))
            .or(this.page.getByRole('menuitem', {{ name: raw }}))
            .or(this.page.getByText(raw, {{ exact: false }}))
            .first()
        : null;
    if (byArg && (await byArg.isVisible().catch(() => false))) {{
      await byArg.click();
      return;
    }}
    const byHint = this.page.getByRole('navigation').getByRole('link', {{ name: hint }})
      .or(this.page.getByRole('link', {{ name: hint }}))
      .or(this.page.getByRole('menuitem', {{ name: hint }}))
      .first();
    if (await byHint.isVisible().catch(() => false)) {{
      await byHint.click();
      return;
    }}
    // Already on feature (deep-link / prior step) — idempotent, do not fail journey
    const shell = this.page.locator('main, [role="main"], h1, h2, [role="dialog"]').first();
    if (await shell.isVisible().catch(() => false)) return;
    const baked = {baked_js};
    const featurePath = (baked || process.env.E2E_FEATURE_PATH || '').trim();
    if (featurePath) {{
      const path = featurePath.startsWith('http') || featurePath.startsWith('/')
        ? featurePath
        : `/${{featurePath}}`;
      await this.page.goto(path, {{ waitUntil: 'domcontentloaded' }});
      return;
    }}
    throw new Error(
      'Menu nav: pass visible menu label as arg, or set E2E_FEATURE_PATH (deep-link).'
    );
  }}
"""


def _is_create_open_method(method: str) -> bool:
    norm = _norm_key(method or "")
    if not norm:
        return False
    if re.search(
        r"(click|open|press|tap)?(createnew|createbutton|entitycreate|addnew|newrecord|taomoi)",
        norm,
    ):
        return True
    if "create" in norm and any(
        x in norm for x in ("modal", "dialog", "drawer", "popup")
    ):
        return True
    if re.search(r"(open|click|press).*(create|addnew|taomoi|entitycreate)", norm):
        return True
    return norm in (
        "clickcreate",
        "opencreate",
        "clickadd",
        "clicknew",
        "opennew",
        "createnew",
    )


def _render_create_open_stub(method: str) -> str:
    """Open create: Spec label, else JHipster/a11y Create control (not shell main|body)."""
    name = method or "clickCreateNew"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    const raw = _args.length ? _args[0] : undefined;\n"
        "    const loc = raw instanceof RegExp\n"
        "      ? this.page.getByRole('button', { name: raw }).first()\n"
        "      : typeof raw === 'string' && raw.trim()\n"
        "        ? this.page.getByRole('button', { name: raw }).first()\n"
        "        : this.page.getByTestId('entityCreateButton')\n"
        "            .or(this.page.locator('#jh-create-entity'))\n"
        "            .or(this.page.getByRole('button', { name: /Tạo mới|Create|Add/i }))\n"
        "            .first();\n"
        "    await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
        "    await loc.click();\n"
        "  }\n"
    )


def _field_hint_from_method(method: str) -> str:
    """arrangeRequiredName → 'name'; fillSeizureLocation → 'seizure location'."""
    from app.services.e2e_stub_grounding import method_tokens

    stop = {
        "arrange",
        "prepare",
        "setup",
        "provide",
        "input",
        "fill",
        "type",
        "enter",
        "set",
        "select",
        "choose",
        "pick",
        "verify",
        "or",
        "and",
        "the",
        "required",
        "optional",
        "field",
        "value",
        "form",
        "open",
        "click",
        "expand",
        "toggle",
        "focus",
        "search",
        "filter",
        "clear",
        "combobox",
        "dropdown",
        "autocomplete",
        "typeahead",
        "multiselect",
        "ngselect",
        "matselect",
        "picker",
        "option",
    }
    tokens = [t for t in method_tokens(method or "") if t not in stop and len(t) >= 2]
    if not tokens:
        return ".*"
    return " ".join(tokens[:4])


def _is_select_field_method(method: str) -> bool:
    """selectStatus / chooseOption / open*Combobox* — not sidebar menu."""
    if _is_menu_nav_method(method):
        return False
    norm = _norm_key(method or "")
    if not norm:
        return False
    if any(
        x in norm
        for x in (
            "combobox",
            "dropdown",
            "autocomplete",
            "typeahead",
            "multiselect",
            "ngselect",
            "matselect",
        )
    ):
        return True
    if re.match(r"^(open|click|expand|toggle|focus|search|filter)", norm) and any(
        x in norm
        for x in ("select", "search", "filter", "picker", "combo", "dropdown", "option")
    ):
        return True
    return bool(re.match(r"^(select|choose|pick)", norm)) and not any(
        x in norm for x in ("menu", "sidebar", "sidenav", "drawer")
    )


def _is_leave_empty_method(method: str) -> bool:
    """leaveRequired*Empty / fillPartial*LeaveRestEmpty — clear required, do not invent fill."""
    norm = _norm_key(method or "")
    if not norm:
        return False
    if norm.startswith(("expect", "assert", "click", "goto", "open")):
        return False
    return bool(
        re.search(
            r"(leave\w*(empty|blank|rest)|omit\w+|unfilled|"
            r"incomplete\w*field|field\w*empty|empty\w*field)",
            norm,
        )
    )


def _is_expect_disabled_or_blocked(method: str) -> bool:
    """expectStep1IncompleteBlocksStep2 / expectNextDisabled — assert wizard Next disabled."""
    norm = _norm_key(method or "")
    if not norm.startswith(("expect", "assert")):
        return False
    if re.search(r"(allow|success|complete(?!step)|permitted|enabled)", norm):
        if not re.search(r"(disabled|block|incomplete|invalid|prevent)", norm):
            return False
    return bool(
        re.search(
            r"(disabled|block|incomplete|invalid|required|cannot|prevent|"
            r"stay.*step|not.*step|step1)",
            norm,
        )
    )


def _is_field_fill_method(method: str) -> bool:
    """arrangeRequiredName / fillSeizureLocation / setTitle — not Phase-3 throw."""
    norm = _norm_key(method or "")
    if not norm:
        return False
    if _is_menu_nav_method(method) or _is_feature_nav_method(method):
        return False
    if _is_select_field_method(method):
        return False
    if _is_leave_empty_method(method):
        return False
    return bool(
        re.match(
            r"^(arrange|prepare|setup|provide|input|fill|type|enter|set)",
            norm,
        )
    )


def _render_field_fill_stub(method: str) -> str:
    """
    Fill by label/placeholder derived from method tokens + Spec args.
    Fail-closed when no Spec value or no matching field (Rule 19 / P1).
    """
    name = method or "fillField"
    hint = _field_hint_from_method(name)
    hint_js = json.dumps(hint)
    name_js = json.dumps(name)
    return f"""
  async {name}(..._args: unknown[]): Promise<void> {{
    const raw = _args.length ? _args[0] : undefined;
    let q = '';
    if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {{
      q = String(raw).trim();
    }} else if (raw && typeof raw === 'object' && !Array.isArray(raw)) {{
      const data = raw as Record<string, unknown>;
      for (const k of ['value', 'name', 'text', 'label', 'title']) {{
        if (data[k] != null && String(data[k]).trim()) {{ q = String(data[k]).trim(); break; }}
      }}
      if (!q) {{
        for (const v of Object.values(data)) {{
          if (typeof v === 'string' && v.trim() && !/fixtures[/\\\\]|\\.(bin|pdf)$/i.test(v)) {{
            q = v.trim(); break;
          }}
        }}
      }}
    }}
    if (!q) {{
      throw new Error('Phase 3: unresolved POM stub `' + {name_js} + '` — '
        + 'pass fill value from Spec testData (E2E_GROUNDING fail-closed)');
    }}
    const hint = new RegExp({hint_js}.replace(/\\s+/g, '\\\\s*'), 'i');
    const field = this.page.getByLabel(hint)
      .or(this.page.getByPlaceholder(hint))
      .or(this.page.getByRole('textbox', {{ name: hint }}))
      .or(this.page.locator('input[type="text"], input:not([type]), textarea, [role="textbox"]').first())
      .first();
    if (await field.isVisible().catch(() => false)) {{
      await field.fill(q);
      return;
    }}
    throw new Error('Phase 3: unresolved POM stub `' + {name_js} + '` — '
      + 'no matching label/placeholder for field hint (E2E_GROUNDING fail-closed)');
  }}
"""


def _render_select_field_stub(method: str) -> str:
    """Combobox/select by method token + Spec option label — no invent first option."""
    name = method or "selectField"
    hint = _field_hint_from_method(name)
    hint_js = json.dumps(hint)
    name_js = json.dumps(name)
    return f"""
  async {name}(..._args: unknown[]): Promise<void> {{
    const raw = _args.length ? _args[0] : undefined;
    const optLabel = typeof raw === 'string' ? raw.trim()
      : raw instanceof RegExp ? raw
      : '';
    if (!optLabel) {{
      throw new Error('Phase 3: unresolved POM stub `' + {name_js} + '` — '
        + 'pass option label from Spec (E2E_GROUNDING fail-closed)');
    }}
    const hint = new RegExp({hint_js}.replace(/\\s+/g, '\\\\s*'), 'i');
    const field = this.page.getByRole('combobox', {{ name: hint }})
      .or(this.page.getByLabel(hint))
      .or(this.page.getByRole('combobox'))
      .or(this.page.getByRole('searchbox'))
      .or(this.page.locator('select').first())
      .first();
    await field.waitFor({{ state: 'visible', timeout: 15000 }});
    const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');
    if (tag === 'select') {{
      if (typeof optLabel === 'string') {{
        await field.selectOption({{ label: optLabel }});
      }}
      return;
    }}
    await field.click();
    if (typeof optLabel === 'string' && optLabel) {{
      await field.fill(optLabel).catch(() => undefined);
    }}
    if (optLabel instanceof RegExp) {{
      const opt = this.page.getByRole('option', {{ name: optLabel }}).first();
      await opt.waitFor({{ state: 'visible', timeout: 15000 }});
      await opt.click();
      return;
    }}
    const opt = this.page.getByRole('option', {{ name: optLabel }})
      .or(this.page.getByText(optLabel, {{ exact: false }}))
      .first();
    await opt.waitFor({{ state: 'visible', timeout: 15000 }});
    await opt.click();
  }}
"""


def _is_form_action_method(method: str) -> bool:
    norm = _norm_key(method or "")
    if not norm:
        return False
    if any(
        x in norm
        for x in (
            "addrelated",
            "relateddocument",
            "uploaddoc",
            "uploadfile",
            "attach",
            "setinputfiles",
            "fillform",
            "submitform",
        )
    ):
        return True
    if norm.startswith("add") and any(
        x in norm for x in ("doc", "file", "upload", "record", "item", "row")
    ):
        return True
    if norm.startswith("upload"):
        return True
    return False


def _is_wizard_next_method(method: str) -> bool:
    """
    Advance wizard / complete step N → Next/Continue button.
    Covers LLM names: goNext, completeStep1ToReachStep2, finishStep1, …
    """
    norm = _norm_key(method or "")
    if not norm:
        return False
    if norm.startswith(("expect", "assert", "get", "find", "locate")):
        return False
    if re.search(
        r"(gonext|clicknext|continuenext|nextstep|nextfrom|gotostep|"
        r"completestep|finishstep|submitstep|advancestep|reachstep|"
        r"tostep\d|step\d+to|movetonext)",
        norm,
    ):
        return True
    # completeXToReachY / finishXAndGoToY — not the substring inside "incomplete"
    if re.search(r"(?<![a-z])(complete|finish|submit|advance).*(step|next|reach)", norm):
        return True
    if re.search(r"(reach|goto|moveto).*step", norm) and "login" not in norm:
        return True
    return False


def _render_wizard_next_stub(method: str) -> str:
    """Click wizard Next — Spec label, else portable Next/Continue/Tiếp theo in dialog."""
    name = method or "goNext"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    const raw = _args.length ? _args[0] : undefined;\n"
        "    const scope = this.page.locator('ngb-modal-window, [role=\"dialog\"], form').last();\n"
        "    const nextBtn = raw instanceof RegExp\n"
        "      ? scope.getByRole('button', { name: raw }).first()\n"
        "      : typeof raw === 'string' && raw.trim()\n"
        "        ? scope.getByRole('button', { name: raw }).first()\n"
        "        : scope.getByRole('button', { name: /Tiếp theo|Next|Continue|Hoàn tất|Submit/i }).first();\n"
        "    await nextBtn.waitFor({ state: 'visible', timeout: 15000 });\n"
        "    await nextBtn.click();\n"
        "  }\n"
    )


def _render_leave_empty_stub(method: str) -> str:
    """Clear required name field in dialog — do not invent a fill value."""
    name = method or "leaveRequiredFieldEmpty"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    const dlg = this.page.locator('ngb-modal-window, [role=\"dialog\"]').last();\n"
        "    const field = dlg.locator('#field_name, [formControlName=\"name\"]')\n"
        "      .or(dlg.locator('input.stitch-modal-input, input[id^=\"field_\"]').first())\n"
        "      .first();\n"
        "    if (await field.isVisible().catch(() => false)) {\n"
        "      await field.fill('');\n"
        "    }\n"
        "  }\n"
    )


def _render_expect_disabled_stub(method: str) -> str:
    """Incomplete/blocked wizard step → Next must stay disabled (not R6 text, not body)."""
    name = method or "expectNextDisabled"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    const next = this.page.locator('ngb-modal-window, [role=\"dialog\"]').last()\n"
        "      .getByRole('button', { name: /Tiếp theo|Next|Continue/i }).first();\n"
        "    await expect(next).toBeDisabled({ timeout: 15000 });\n"
        "    const raw = _args.length ? _args[0] : undefined;\n"
        "    if (raw instanceof RegExp) {\n"
        "      await expect(this.page.getByText(raw).first()).toBeVisible({ timeout: 15000 });\n"
        "    }\n"
        "  }\n"
    )



def _render_form_action_stub(method: str) -> str:
    """
    add/upload/fill form actions — use args object (filePath, labels) + role heuristics.
    Avoid Phase-3 ungrounded throw after feature entry already succeeded.
    """
    name = method or "addRelatedDocument"
    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    const raw = _args.length ? _args[0] : undefined;\n"
        "    const data = raw && typeof raw === 'object' && !Array.isArray(raw)\n"
        "      ? (raw as Record<string, unknown>)\n"
        "      : {};\n"
        "    const filePath = String(\n"
        "      (data.filePath ?? data.path ?? data.file ??\n"
        "        (typeof raw === 'string' ? raw : '')) ||\n"
        "      'fixtures/generated.bin'\n"
        "    );\n"
        "    const fileInput = this.page.locator('input[type=\"file\"]').first();\n"
        "    if (await fileInput.count().catch(() => 0)) {\n"
        "      await fileInput.setInputFiles(filePath);\n"
        "    }\n"
        "    for (const [key, val] of Object.entries(data)) {\n"
        "      if (/file|path/i.test(key) || val == null) continue;\n"
        "      if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') continue;\n"
        "      const q = String(val).trim();\n"
        "      if (!q) continue;\n"
        "      const hint = key.replace(/([A-Z])/g, ' $1').replace(/^./, (c) => c.toUpperCase());\n"
        "      const field = this.page\n"
        "        .getByLabel(new RegExp(hint, 'i'))\n"
        "        .or(this.page.getByPlaceholder(new RegExp(hint, 'i')))\n"
        "        .or(this.page.getByRole('combobox', { name: new RegExp(hint, 'i') }))\n"
        "        .first();\n"
        "      if (!(await field.isVisible().catch(() => false))) continue;\n"
        "      const tag = await field.evaluate((el) => el.tagName.toLowerCase()).catch(() => '');\n"
        "      if (tag === 'select' || (await field.getAttribute('role').catch(() => '')) === 'combobox') {\n"
        "        await field.click();\n"
        "        const opt = this.page.getByRole('option', { name: q }).or(this.page.getByText(q, { exact: false })).first();\n"
        "        if (await opt.isVisible().catch(() => false)) await opt.click();\n"
        "      } else {\n"
        "        await field.fill(q);\n"
        "      }\n"
        "    }\n"
        "    const commit = this.page.getByRole('button', {\n"
        "      name: /thêm vào danh sách|add to list|lưu|save|thêm|add/i,\n"
        "    }).first();\n"
        "    if (await commit.isVisible().catch(() => false)) await commit.click();\n"
        "  }\n"
    )


def _render_smart_method_stub(
    method: str, *, dom_snapshot: str = "", feature_path: str = ""
) -> str:
    """
    Prefer: classified journey stubs → DOM grounded → Spec-arg clicks.
    E2E_GROUNDING fail-closed: no inventing button.first()/Save-regex when DOM+args empty.
    """
    from app.services.e2e_stub_grounding import (
        best_element_for_method,
        parse_dom_elements,
        render_dom_grounded_stub,
        render_ungrounded_fail_stub,
    )

    name = method or "action"
    low = name.lower()
    norm = _norm_key(name)

    # Known journey families first (portable — not app-specific selectors)
    if _is_feature_nav_method(name):
        return _render_feature_nav_stub(name, feature_path=feature_path)
    if _is_menu_nav_method(name):
        return _render_menu_nav_stub(name, feature_path=feature_path)

    # Prefer Inspect DOM before soft Act stubs (P1 fail-closed without invent)
    el = best_element_for_method(name, parse_dom_elements(dom_snapshot))
    if el:
        grounded = render_dom_grounded_stub(name, el)
        if grounded:
            return grounded

    if _is_create_open_method(name):
        return _render_create_open_stub(name)
    if _is_wizard_next_method(name):
        return _render_wizard_next_stub(name)
    if _is_leave_empty_method(name):
        return _render_leave_empty_stub(name)
    if _is_select_field_method(name):
        return _render_select_field_stub(name)
    if _is_field_fill_method(name):
        return _render_field_fill_stub(name)
    if _is_form_action_method(name):
        return _render_form_action_stub(name)

    if norm in ("clicklogout", "logout", "signout", "clicksignout"):
        return (
            f"\n  async {name}(): Promise<void> {{\n"
            "    const btn = this.page\n"
            "      .getByRole('button', { name: /log\\s*out|sign\\s*out|đăng\\s*xuất/i })\n"
            "      .or(this.page.getByRole('link', { name: /log\\s*out|sign\\s*out|đăng\\s*xuất/i }))\n"
            "      .first();\n"
            "    if (await btn.isVisible().catch(() => false)) {\n"
            "      await btn.click();\n"
            "    }\n"
            "  }\n"
        )

    if "registertab" in norm or norm in ("ensureregistertabactive", "gotoregister", "opensignup"):
        return (
            f"\n  async {name}(): Promise<void> {{\n"
            "    const tab = this.page.getByRole('tab', { name: /sign\\s*up|register|đăng\\s*ký/i }).first();\n"
            "    if (await tab.isVisible().catch(() => false)) {\n"
            "      await tab.click();\n"
            "    }\n"
            "  }\n"
        )

    if "logintab" in norm or norm in ("ensurelogintabactive", "opensignin"):
        return (
            f"\n  async {name}(): Promise<void> {{\n"
            "    const tab = this.page.getByRole('tab', { name: /log\\s*in|sign\\s*in|đăng\\s*nhập/i }).first();\n"
            "    if (await tab.isVisible().catch(() => false)) {\n"
            "      await tab.click();\n"
            "    }\n"
            "  }\n"
        )

    if low.startswith(("get", "find", "locate")):
        helper = _ts_visible_texts_from_arg_helper(indent="    ")
        return (
            f"\n  {name}(..._args: unknown[]): Locator {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            f"{helper}"
            "    if (raw instanceof RegExp) return this.page.getByText(raw).first();\n"
            "    const texts = __aitestVisibleTexts(raw);\n"
            "    if (texts.length) return this.page.getByText(texts[0], { exact: false }).first();\n"
            "    throw new Error(\n"
            f"      'Phase 3: unresolved POM stub `{name}` — "
            "get* needs Spec text (no shell main|body locator)'\n"
            "    );\n"
            "  }\n"
        )

    if low.startswith(("expect", "assert")):
        if _is_expect_disabled_or_blocked(name):
            return _render_expect_disabled_stub(name)
        helper = _ts_visible_texts_from_arg_helper(indent="    ")
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            f"{helper}"
            "    if (raw instanceof RegExp) {\n"
            "      await expect(this.page.getByText(raw).first()).toBeVisible({ timeout: 15000 });\n"
            "      return;\n"
            "    }\n"
            "    const texts = __aitestVisibleTexts(raw);\n"
            "    if (!texts.length) {\n"
            "      // R6 — do not treat main|h1 as business proof; Spec must pass expected text\n"
            "      throw new Error(\n"
            "        'BusinessAssertionFailed: expect* needs Expected outcome text from Spec '\n"
            "        + '(no shell landmark assert — R6)'\n"
            "      );\n"
            "    }\n"
            "    for (const q of texts) {\n"
            "      await expect(this.page.getByText(q, { exact: false }).first())\n"
            "        .toBeVisible({ timeout: 15000 });\n"
            "    }\n"
            "  }\n"
        )

    if low.startswith("click") or low.startswith("tap") or low.startswith("press"):
        # Spec arg → labeled click; bare invent button.first() → fail-closed (E2E_GROUNDING).
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    if (raw instanceof RegExp) {\n"
            "      const loc = this.page.getByText(raw).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            "    if (typeof raw === 'string' && raw.trim()) {\n"
            "      const loc = this.page.getByRole('button', { name: raw })\n"
            "        .or(this.page.getByText(raw, { exact: false })).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            f"    throw new Error('Phase 3: unresolved POM stub `{name}` — "
            "no Spec label and no DOM selector_candidates (E2E_GROUNDING fail-closed)');\n"
            "  }\n"
        )

    if low.startswith("fill") or low.startswith("type") or low.startswith("enter"):
        return _render_field_fill_stub(name)

    # Fixture / path helpers MUST be sync string (setInputFiles / getByText / goto).
    path_like = (
        "fixture" in low
        or "filepath" in low
        or (low.endswith("path") and "xpath" not in low)
        or "filename" in low
        or (
            ("file" in low or "doc" in low or "upload" in low or "fixture" in low)
            and (
                norm.startswith("ensure")
                or norm.startswith("build")
                or norm.startswith("make")
                or norm.startswith("create")
                or norm.startswith("get")
            )
        )
    )
    if path_like:
        return (
            f"\n  {name}(..._args: unknown[]): string {{\n"
            "    // Guard stub — sync path string (never Promise — avoids setInputFiles/getByText crash).\n"
            "    return String(_args[0] ?? 'fixtures/generated.bin');\n"
            "  }\n"
        )

    # Act/Arrange leftovers — prefer classified soft stubs; else fail-closed (no invent).
    if _is_select_field_method(name) or re.match(r"^(select|choose|pick)", norm):
        return _render_select_field_stub(name)
    if re.match(r"^(arrange|prepare|setup|provide|input|set)", norm):
        return _render_field_fill_stub(name)
    if re.match(r"^(open|expand|toggle|focus|search|filter|clear)", norm):
        if _is_select_field_method(name) or any(
            x in norm
            for x in ("combo", "select", "search", "filter", "dropdown", "picker")
        ):
            return _render_select_field_stub(name)
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    if (raw instanceof RegExp) {\n"
            "      const loc = this.page.getByRole('button', { name: raw })\n"
            "        .or(this.page.getByText(raw)).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            "    if (typeof raw === 'string' && raw.trim()) {\n"
            "      const loc = this.page.getByRole('button', { name: raw })\n"
            "        .or(this.page.getByText(raw, { exact: false })).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            f"    throw new Error('Phase 3: unresolved POM stub `{name}` — "
            "no Spec label and no DOM selector_candidates (E2E_GROUNDING fail-closed)');\n"
            "  }\n"
        )

    if re.match(
        r"^(click|tap|press|complete|finish|submit|advance)",
        norm,
    ):
        # Wizard already handled above; bare invent Save/Next → fail-closed.
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    if (raw instanceof RegExp) {\n"
            "      const loc = this.page.getByText(raw).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            "    if (typeof raw === 'string' && raw.trim()) {\n"
            "      const loc = this.page.getByRole('button', { name: raw })\n"
            "        .or(this.page.getByText(raw, { exact: false })).first();\n"
            "      await loc.waitFor({ state: 'visible', timeout: 15000 });\n"
            "      await loc.click();\n"
            "      return;\n"
            "    }\n"
            f"    throw new Error('Phase 3: unresolved POM stub `{name}` — "
            "no Spec label and no DOM selector_candidates (E2E_GROUNDING fail-closed)');\n"
            "  }\n"
        )

    # E2E_GROUNDING: fail-closed — never invent button.first() / Save-regex last resort.
    return render_ungrounded_fail_stub(name)


def _insert_methods_before_class_end(
    page_content: str,
    snippets: Iterable[str],
    *,
    class_name: str | None = None,
) -> str:
    joined = "".join(snippets)
    if not joined.strip():
        return page_content
    # Prefer closing brace of the target class (not file-level rfind — caused
    # stubs inserted after nested blocks / duplicate appends on re-guard).
    if class_name:
        class_match = re.search(
            rf"export\s+class\s+{re.escape(class_name)}\b[^{{]*\{{",
            page_content,
            re.DOTALL,
        )
        if class_match:
            body_start = class_match.end()
            depth = 1
            i = body_start
            while i < len(page_content) and depth > 0:
                ch = page_content[i]
                if ch == "{":
                    depth += 1
                elif ch == "}":
                    depth -= 1
                i += 1
            close_idx = i - 1
            if close_idx >= body_start:
                return page_content[:close_idx] + joined + page_content[close_idx:]
    idx = page_content.rfind("}")
    if idx < 0:
        return page_content + joined
    return page_content[:idx] + joined + page_content[idx:]


def _rewrite_pom_auth_calls_to_helper(spec_content: str, var_names: set[str]) -> str:
    """
    ``pom.ensureAuthenticated()`` is invalid — auth lives in fixtures/auth.helper
    (same contract as inject_ensure_authenticated). Rewrite calls; do not invent UI locators.
    """
    text = spec_content or ""
    if not var_names:
        return text
    changed = False
    for var in var_names:
        if not var:
            continue
        pat = re.compile(
            rf"await\s+{re.escape(var)}\.ensureAuthenticated\s*\([^)]*\)\s*;?",
        )
        if pat.search(text):
            text = pat.sub("await ensureAuthenticated(page)", text)
            changed = True
    if not changed:
        return text
    if not re.search(r"""from\s+['"][^'"]*auth\.helper['"]""", text):
        import_line = (
            "import { ensureAuthenticated } from '../../../_shared/fixtures/auth.helper';\n"
        )
        last_import = None
        for m in _IMPORT_LINE_RE.finditer(text):
            last_import = m
        if last_import:
            insert_at = last_import.end()
            rest = text[insert_at:]
            text = (
                text[:insert_at]
                + ("\n" if not rest.startswith("\n") else "")
                + import_line
                + (rest if rest.startswith("\n") else "\n" + rest)
            )
        else:
            text = import_line + text
    return normalize_collapsed_imports(text)


def fix_page_method_contract(
    spec_content: str, page_content: str, *, dom_snapshot: str = "", feature_path: str = ""
) -> tuple[str, str]:
    """
    Ensure Spec↔POM contract is runnable (Rule 18):
    - import names match exports
    - no Class.staticMethod( — rewrite to instance
    - every instance method call exists on the page class
    - Phase 3: new stubs prefer DOM selector_candidates
    - pom.ensureAuthenticated → auth.helper (never stub auth as UI)
    - gotoFeature* → E2E_FEATURE_PATH nav stub (not ungrounded throw)
    """
    if not (spec_content or "").strip() or not (page_content or "").strip():
        return spec_content, page_content

    cm = _CLASS_RE.search(page_content)
    leaf_hint = ""
    # Prefer leaf from first ../pages/ import
    im = _SPEC_PAGE_IMPORT_RE.search(spec_content)
    if im:
        leaf_hint = im.group("leaf") or ""

    spec_content, page_content = _align_spec_imports_to_page(
        spec_content, page_content, leaf_hint=leaf_hint
    )

    primary, _ = _exported_page_symbols(page_content)
    class_name = primary or (cm.group(1) if cm else None)
    if not class_name:
        return spec_content, page_content

    # Static Class.method( → instance
    static_calls = _collect_static_class_calls(spec_content, class_name)
    if static_calls:
        spec_content, var_name = _ensure_page_binding(spec_content, class_name)
        spec_content = _rewrite_static_calls_to_instance(
            spec_content, class_name, var_name
        )

    bindings = _find_page_bindings(spec_content)
    if not bindings:
        return spec_content, page_content

    bound_classes = {c for _, c in bindings}
    if class_name not in bound_classes:
        # Spec targets a different class than this page file — do not spam stubs.
        return spec_content, page_content

    target_bindings = [(v, c) for v, c in bindings if c == class_name]
    var_names = {v for v, _ in target_bindings}
    # Before collecting missing POM methods: move auth off the page object.
    spec_content = _rewrite_pom_auth_calls_to_helper(spec_content, var_names)

    existing = _extract_class_methods(page_content, class_name)
    existing_norm = {_norm_key(m): m for m in existing}
    needed: set[str] = set()
    for var_name, cls in target_bindings:
        needed |= _collect_spec_method_calls(spec_content, var_name)

    # ensureAuthenticated is provided by auth.helper after rewrite — never POM-stub it.
    missing = [
        m
        for m in sorted(needed)
        if _norm_key(m) not in existing_norm and _norm_key(m) != "ensureauthenticated"
    ]
    if not missing:
        return spec_content, page_content

    snippets: list[str] = []
    for method in missing:
        norm = _norm_key(method)
        alias_target = _METHOD_ALIASES.get(norm)
        if alias_target and alias_target in existing_norm:
            target = existing_norm[alias_target]
            snippets.append(_render_alias_method(method, target))
            continue
        if norm == "assertstillonloginurl":
            snippets.append(_render_expect_still_on_login_page(method="assertStillOnLoginUrl"))
            continue
        if norm == "getpagetext":
            snippets.append(_render_get_page_text())
            continue
        if norm.startswith("assert") and norm[6:] in existing_norm:
            target = existing_norm[norm[6:]]
            snippets.append(_render_alias_method(method, target))
            continue
        if norm.startswith("expect") and f"assert{norm[6:]}" in {_norm_key(x) for x in missing}:
            continue
        snippets.append(
            _render_smart_method_stub(
                method, dom_snapshot=dom_snapshot, feature_path=feature_path
            )
        )

    page_content = _insert_methods_before_class_end(
        page_content, snippets, class_name=class_name
    )
    # Replace leftover Phase-3 ungrounded throws on navigation methods
    page_content = _rewrite_ungrounded_nav_stubs(
        page_content, feature_path=feature_path, dom_snapshot=dom_snapshot
    )
    return spec_content, page_content


def _rewrite_ungrounded_nav_stubs(
    page_content: str, *, feature_path: str = "", dom_snapshot: str = ""
) -> str:
    """Swap Phase-3 ungrounded throws for soft / DOM stubs (Rule 19)."""
    text = page_content or ""
    pattern = re.compile(
        r"async\s+(\w+)\s*\([^)]*\)\s*:\s*Promise<\s*void\s*>\s*\{"
        r"\s*throw\s+new\s+Error\(\s*['\"]Phase 3: (?:ungrounded|unresolved) POM stub[^'\"]*['\"]\s*\)\s*;?\s*"
        r"\}",
        re.IGNORECASE,
    )

    def repl(m: re.Match[str]) -> str:
        name = m.group(1)
        stub = _render_smart_method_stub(
            name, feature_path=feature_path, dom_snapshot=dom_snapshot
        )
        # Keep original only for pure fail stubs (no Spec-arg gate).
        # Arg-gated stubs may mention "ungrounded"/"fail-closed" in throw text but accept Spec labels.
        low = (stub or "").lower()
        if "ungrounded" in low and "_args" not in (stub or ""):
            return m.group(0)
        return stub.strip()

    return pattern.sub(repl, text)


_POM_LANDMARK_EXPECT_RE = re.compile(
    r"await\s+expect\s*\(\s*this\.page\.locator\(\s*['\"]main,\s*\[role=",
    re.IGNORECASE,
)

_ASSIGN_SHELL_BODY_RE = re.compile(
    r"this\.(\w+)\s*=\s*this\.page\.locator\(\s*['\"]main,\s*\[role=[\"']main[\"']\],\s*body['\"]\s*\)\.first\(\)",
    re.IGNORECASE,
)


def _locator_init_expr(name: str) -> str:
    """Never bind action locators to main|body (toBeDisabled on body always fails)."""
    n = _norm_key(name)
    if re.search(r"(create|addnew|taomoi|entitycreate)", n) and re.search(
        r"(button|btn|open|click|new)", n
    ):
        return (
            "this.page.getByTestId('entityCreateButton')"
            ".or(this.page.locator('#jh-create-entity'))"
            ".or(this.page.getByRole('button', { name: /Tạo mới|Create|Add/i }))"
            ".first()"
        )
    if re.search(r"(next|submit|save|confirm|apply|button|btn)", n):
        return (
            "this.page.locator('ngb-modal-window, [role=\"dialog\"]').last()"
            ".getByRole('button', { name: /Tiếp theo|Next|Continue|Hoàn tất|Submit|Save/i })"
            ".first()"
        )
    if re.search(r"(input|field|textbox|name)", n):
        return (
            "this.page.locator('#field_name, [formControlName=\"name\"], "
            "[role=\"dialog\"] input:not([type=\"hidden\"])').first()"
        )
    return "this.page.locator('ngb-modal-window, [role=\"dialog\"], main').first()"


def _rewrite_shell_action_locators(page_content: str) -> str:
    """Rewrite this.nextButton = locator(main|body) to a real wizard/create control."""
    text = page_content or ""

    def repl(m: re.Match[str]) -> str:
        return f"this.{m.group(1)} = {_locator_init_expr(m.group(1))}"

    return _ASSIGN_SHELL_BODY_RE.sub(repl, text)


def _rewrite_expect_object_string_stubs(page_content: str) -> str:
    """
    Heal expect*/assert* stubs that do String(raw) → getByText('[object Object]')
    or R6-forbidden this.page.locator('main…').toBeVisible landmark fallback.
    Re-emit smart stub when those patterns are present.
    """
    text = page_content or ""
    if (
        "String(raw)" not in text
        and "asStr" not in text
        and not _POM_LANDMARK_EXPECT_RE.search(text)
    ):
        return text
    out: list[str] = []
    i = 0
    header_re = re.compile(
        r"async\s+(?P<name>expect\w*|assert\w*)\s*\([^)]*\)\s*:\s*Promise<\s*void\s*>\s*\{",
        re.IGNORECASE,
    )
    while i < len(text):
        m = header_re.search(text, i)
        if not m:
            out.append(text[i:])
            break
        out.append(text[i : m.start()])
        # Brace-match method body
        brace_at = m.end() - 1  # position of '{'
        depth = 0
        j = brace_at
        while j < len(text):
            ch = text[j]
            if ch == "{":
                depth += 1
            elif ch == "}":
                depth -= 1
                if depth == 0:
                    j += 1
                    break
            j += 1
        body = text[m.end() : j - 1]
        landmark_fake = bool(_POM_LANDMARK_EXPECT_RE.search(body))
        if "__aitestVisibleTexts" in body and not landmark_fake:
            out.append(text[m.start() : j])
        elif "String(raw)" in body or "asStr" in body or landmark_fake:
            out.append(_render_smart_method_stub(m.group("name")).strip())
        else:
            out.append(text[m.start() : j])
        i = j
    return "".join(out)


def _rewrite_feature_nav_seed_stubs(page_content: str, *, feature_path: str = "") -> str:
    """Re-emit gotoFeature* stubs that lack seed-fill / wantsStep2 handling."""
    text = page_content or ""
    pattern = re.compile(
        r"async\s+(?P<name>goto\w*|openFeature\w*|openForm\w*)\s*\([^)]*\)\s*:\s*Promise<\s*void\s*>\s*\{"
        r"(?P<body>[^{}]*(?:\{[^{}]*\}[^{}]*)*)"
        r"\}",
        re.IGNORECASE | re.DOTALL,
    )

    def repl(m: re.Match[str]) -> str:
        name = m.group("name")
        if not _is_feature_nav_method(name):
            return m.group(0)
        body = m.group("body") or ""
        if "const seed" in body and "wantsStep2" in body:
            return m.group(0)
        if "E2E_FEATURE_PATH" not in body and "ungrounded" not in body.lower():
            return m.group(0)
        return _render_feature_nav_stub(name, feature_path=feature_path).strip()

    return pattern.sub(repl, text)


def restore_playwright_file_suffixes(files: list) -> list:
    """
    Restore ``.spec.ts`` / ``.page.ts`` when a prior shorten stripped them to ``.ts``.
    Playwright testMatch is ``**/*.(spec|test).*`` — bare ``.ts`` under specs/ is invisible.
    Also rewrites ``../pages/<old>`` imports to the local page leaf when needed.
    """
    from app.llm.base import E2EFile

    out: list = []
    old_to_new_leaf: dict[str, str] = {}
    for item in files:
        path = (getattr(item, "path", "") or "").replace("\\", "/")
        kind = getattr(item, "kind", "") or ""
        content = getattr(item, "content", "") or ""
        low = path.lower()
        leaf = path.rsplit("/", 1)[-1] if path else ""
        new_path = path
        if leaf.endswith(".ts") and not leaf.endswith(
            (".spec.ts", ".test.ts", ".page.ts", ".d.ts", ".setup.ts", ".helper.ts")
        ):
            if kind == "spec" or "/specs/" in f"/{low}/":
                new_path = path[: -len(leaf)] + leaf[:-3] + ".spec.ts"
            elif kind == "page" or "/pages/" in f"/{low}/":
                new_path = path[: -len(leaf)] + leaf[:-3] + ".page.ts"
        if new_path != path:
            old_to_new_leaf[leaf] = new_path.rsplit("/", 1)[-1]
            if leaf.endswith(".ts"):
                old_to_new_leaf[leaf[:-3]] = new_path.rsplit("/", 1)[-1][:-3]
        out.append(E2EFile(path=new_path, content=content, kind=kind or "spec"))

    if not old_to_new_leaf:
        return out

    # Point specs at renamed page leaves (import often omits .ts)
    keys = sorted(old_to_new_leaf.keys(), key=len, reverse=True)
    for f in out:
        text = f.content or ""
        for old_leaf in keys:
            if old_leaf in text:
                text = text.replace(old_leaf, old_to_new_leaf[old_leaf])
        f.content = text

    # If a spec still imports a missing ../pages/X, rewrite to the sole local page.
    pages_by_root: dict[str, list[str]] = {}
    for f in out:
        p = (f.path or "").replace("\\", "/")
        if "/pages/" not in p.lower():
            continue
        root = p.split("/pages/")[0]
        leaf = p.rsplit("/", 1)[-1]
        stem = leaf[:-3] if leaf.endswith(".ts") else leaf
        pages_by_root.setdefault(root, []).append(stem)

    for f in out:
        p = (f.path or "").replace("\\", "/")
        if "/specs/" not in p.lower() and f.kind != "spec":
            continue
        root = p.split("/specs/")[0] if "/specs/" in p.lower() else ""
        locals_pages = pages_by_root.get(root) or []
        if len(locals_pages) != 1:
            continue
        target = locals_pages[0]

        def _repl(m: re.Match[str]) -> str:
            prefix, imported, suffix = m.group(1), m.group(2), m.group(3)
            leaf = imported.replace("\\", "/").rsplit("/", 1)[-1]
            if leaf == target or leaf.startswith(target):
                return m.group(0)
            return f"{prefix}../pages/{target}{suffix}"

        f.content = re.sub(
            r"""(from\s+['"])([^'"]*pages\/[^'"]+)(['"])""",
            _repl,
            f.content or "",
        )

    return out


def _parse_locator_contract(contract: str) -> dict[str, set[str]]:
    allowed: dict[str, set[str]] = {
        "data-cy": set(),
        "data-testid": set(),
        "id": set(),
        "name": set(),
        "formControlName": set(),
        "routes": set(),
    }
    for raw in (contract or "").splitlines():
        line = raw.strip()
        if not line or ":" not in line:
            continue
        key, val = line.split(":", 1)
        key = key.strip()
        if key not in allowed:
            continue
        blob = val.strip()
        if not blob or blob == "(none)":
            continue
        items = [x.strip().strip("\"'`") for x in blob.split(",")]
        allowed[key].update(x for x in items if x)
    return allowed


def _id_root_token(value: str) -> str:
    """
    Extract grounding id from Playwright CSS compounds / OR lists.

    Contract lists bare ids from FE. Models often emit:
    - ``#field_x .child`` (descendant)
    - ``#field_x, [formControlName="x"]`` (CSS OR; nested quotes truncate capture)

    Still grounded when the first simple id root is allow-listed.
    """
    v = (value or "").strip()
    if not v:
        return ""
    if v.startswith("#"):
        v = v[1:]
    # CSS OR list before descendant/class — take left-most simple selector
    if "," in v:
        v = v.split(",", 1)[0].strip()
    # Stop at descendant/combinator/class/attr/pseudo
    for sep in (" ", ">", "+", "~", ".", "[", ":"):
        if sep in v:
            v = v.split(sep, 1)[0]
            break
    return v.strip(" \t\r\n,\"'`")


def _field_id_to_form_control(root: str) -> str:
    """Angular/JHipster convention: id=\"field_{formControlName}\"."""
    r = (root or "").strip()
    if r.startswith("field_") and len(r) > 6:
        return r[6:]
    return ""


def _contains_ci(values: set[str], needle: str) -> bool:
    n = (needle or "").strip().lower()
    if not n:
        return False
    return any((v or "").strip().lower() == n for v in (values or set()))


def _value_allowed(key: str, value: str, allowed: dict[str, set[str]]) -> bool:
    if not value:
        return True
    bucket = allowed.get(key) or set()
    if value in bucket or _contains_ci(bucket, value):
        return True
    if key in ("data-cy", "data-testid"):
        alt = "data-testid" if key == "data-cy" else "data-cy"
        if value in (allowed.get(alt) or set()) or _contains_ci(
            allowed.get(alt) or set(), value
        ):
            return True
    if key == "id":
        root = _id_root_token(value)
        if root and root in bucket:
            return True
        if value.lstrip("#") in bucket:
            return True
        # Bridge: #field_X allowed when formControlName X is in contract
        fcn = _field_id_to_form_control(root)
        if fcn and fcn in (allowed.get("formControlName") or set()):
            return True
        return False
    if key == "formControlName":
        # Bridge reverse: control name allowed when id field_{name} is listed
        if f"field_{value}" in (allowed.get("id") or set()):
            return True
    if key == "name":
        # Common FE convention: name ~= formControlName ~= id field_{name}
        fcn = allowed.get("formControlName") or set()
        if value in fcn or _contains_ci(fcn, value):
            return True
        ids = allowed.get("id") or set()
        if f"field_{value}" in ids or _contains_ci(ids, f"field_{value}"):
            return True
    return False


# Match full locator('…') / ("…") / (`…`) bodies so nested quotes in CSS OR survive.
_LOCATOR_STR_RES = (
    re.compile(r"""locator\s*\(\s*'([^']*)'"""),
    re.compile(r'''locator\s*\(\s*"([^"]*)"'''),
    re.compile(r"""locator\s*\(\s*`([^`]*)`"""),
)
_HASH_ID_IN_CSS_RE = re.compile(r"""#([A-Za-z_][\w-]*)""")
_LOCATOR_ATTR_FCN_RE = re.compile(
    r"""formControlName\s*=\s*["']([^"']+)["']""",
    re.IGNORECASE,
)
_LOCATOR_ATTR_FCN_BARE_RE = re.compile(
    r"""\[\s*formControlName\s*=\s*([A-Za-z_][\w-]*)\s*\]""",
    re.IGNORECASE,
)


def _bucket_active(key: str, allowed: dict[str, set[str]]) -> bool:
    if allowed.get(key):
        return True
    # id ↔ formControlName bridge (Angular field_* convention)
    if key == "id" and allowed.get("formControlName"):
        return True
    if key == "formControlName" and allowed.get("id"):
        return True
    return False


def _is_invented_locator_placeholder(value: str) -> bool:
    """Reject template / dynamic locator fragments the LLM invents (e.g. ${fieldKey})."""
    return "${" in ((value or "").strip())


def _assert_locator_contract(files: list, locator_contract: str) -> None:
    allowed = _parse_locator_contract(locator_contract)
    if not any(allowed.values()):
        return

    patterns: dict[str, re.Pattern[str]] = {
        "data-cy": re.compile(
            r"""(?:data-cy\s*=\s*["'`]([^"'`]+)["'`]|getByTestId\s*\(\s*["'`]([^"'`]+)["'`]"""
            r"""|locator\s*\(\s*["'`]\[data-cy=["']([^"']+)["']\]["'`])"""
        ),
        "data-testid": re.compile(
            r"""(?:data-testid\s*=\s*["'`]([^"'`]+)["'`]|getByTestId\s*\(\s*["'`]([^"'`]+)["'`]"""
            r"""|locator\s*\(\s*["'`]\[data-testid=["']([^"']+)["']\]["'`])"""
        ),
        # Bare HTML id= only — locator('#…') via _LOCATOR_STR_RES below
        "id": re.compile(r"""\bid\s*=\s*["'`]([^"'`]+)["'`]"""),
        "name": re.compile(r"""name\s*=\s*["'`]([^"'`]+)["'`]"""),
        "formControlName": re.compile(r"""formControlName\s*=\s*["'`]([^"'`]+)["'`]"""),
        "routes": re.compile(r"""routerLink\s*=\s*["'`](/[^"'`]+)["'`]"""),
    }
    # Always reject invented ${…} placeholders (even when that hook bucket is empty).
    placeholder_pats: list[tuple[str, re.Pattern[str]]] = [
        ("name", patterns["name"]),
        ("formControlName", patterns["formControlName"]),
        ("data-cy", patterns["data-cy"]),
        ("data-testid", patterns["data-testid"]),
        ("id", patterns["id"]),
    ]
    violations: list[str] = []
    for f in files:
        path = (getattr(f, "path", "") or "").replace("\\", "/").lower()
        if "/pages/" not in f"/{path}/" and "/specs/" not in f"/{path}/":
            continue
        content = getattr(f, "content", "") or ""
        for key, pat in placeholder_pats:
            for m in pat.finditer(content):
                value = next((g for g in m.groups() if g), "")
                value = (value or "").strip()
                if value and _is_invented_locator_placeholder(value):
                    violations.append(f"{f.path}: {key}={value}")
        for key, pat in patterns.items():
            if not _bucket_active(key, allowed):
                continue
            for m in pat.finditer(content):
                value = next((g for g in m.groups() if g), "")
                value = (value or "").strip()
                if not value or _is_invented_locator_placeholder(value):
                    continue
                if not _value_allowed(key, value, allowed):
                    violations.append(f"{f.path}: {key}={value}")
        # locator("…") bodies: validate #id roots + formControlName attrs (CSS OR safe)
        if _bucket_active("id", allowed) or _bucket_active("formControlName", allowed):
            for str_pat in _LOCATOR_STR_RES:
                for m in str_pat.finditer(content):
                    body = m.group(1) or ""
                    if _is_invented_locator_placeholder(body):
                        violations.append(f"{f.path}: locator=${{…}}")
                        continue
                    if _bucket_active("id", allowed):
                        for id_m in _HASH_ID_IN_CSS_RE.finditer(body):
                            raw = (id_m.group(1) or "").strip()
                            if raw and _is_invented_locator_placeholder(raw):
                                violations.append(f"{f.path}: id={raw}")
                            elif raw and not _value_allowed("id", raw, allowed):
                                violations.append(f"{f.path}: id={raw}")
                    if _bucket_active("formControlName", allowed):
                        for fcn_m in _LOCATOR_ATTR_FCN_RE.finditer(body):
                            fcn = (fcn_m.group(1) or "").strip()
                            if fcn and _is_invented_locator_placeholder(fcn):
                                violations.append(f"{f.path}: formControlName={fcn}")
                            elif fcn and not _value_allowed(
                                "formControlName", fcn, allowed
                            ):
                                violations.append(f"{f.path}: formControlName={fcn}")
                        for fcn_m in _LOCATOR_ATTR_FCN_BARE_RE.finditer(body):
                            fcn = (fcn_m.group(1) or "").strip()
                            if fcn and _is_invented_locator_placeholder(fcn):
                                violations.append(f"{f.path}: formControlName={fcn}")
                            elif fcn and not _value_allowed(
                                "formControlName", fcn, allowed
                            ):
                                violations.append(f"{f.path}: formControlName={fcn}")
    if violations:
        seen: set[str] = set()
        uniq: list[str] = []
        for v in violations:
            if v in seen:
                continue
            seen.add(v)
            uniq.append(v)
        short = "; ".join(uniq[:5])
        raise E2EStrictGateError(
            "LocatorNotFound",
            "E2E_GROUNDING: generated selectors violate locator contract "
            f"(first: {short})",
        )


_ROLE_SIGNAL_RE = re.compile(
    r"(?i)\b(?:role|actor|authRole|auth_role|E2E_ROLE|vai\s*trò|quyền)\b"
)
_LANDMARK_SIGNAL_RE = re.compile(
    r"(?i)\b(?:feature\s*entry|landmark|popup|dialog|modal|screen|màn|form|tab)\b"
)
# Keywords OR labeled expectedOutcome: <prose> (Approved TC often has VN text without "assert")
_EXPECTED_SIGNAL_RE = re.compile(
    r"(?i)\b(?:expected|kỳ\s*vọng|must|phải|assert|thành\s*công|hiển\s*thị|"
    r"visible|success|redirect|contain|thấy|đúng|pass(?:ed)?|verify|kiểm\s*tra)\b"
)
_EXPECTED_LABELED_RE = re.compile(
    r"(?im)^\s*expected(?:Outcome|Result|_result)?\s*:\s*(.+)$"
)
_EMPTY_OUTCOME = frozenset(
    {"", "(none)", "-", "n/a", "na", "null", "none", "tbd", "todo"}
)

_CONTEXT_MISSING_HINTS: dict[str, str] = {
    "featurePath": (
        "thêm `path:` / `featurePath:` usable vào testData, hoặc FE routerLink / route-catalog"
    ),
    "role/authRef": (
        "thêm `authRole: <role>` vào testData/precondition, hoặc Auth Discover defaultRole / "
        "executionContext `authRole=…` (không invent role)"
    ),
    "landmark": "thêm landmark/screen/form trong context, hoặc FE locator contract + featurePath",
    "expectedOutcome": "thêm expectedResult / expectedOutcome rõ trên TC",
}


def _has_expected_outcome(auth_hints: str) -> bool:
    """True when TC carries a real expected outcome (field or keyword), not just empty."""
    text = auth_hints or ""
    for m in _EXPECTED_LABELED_RE.finditer(text):
        val = (m.group(1) or "").strip().strip("\"'`")
        if val.lower() not in _EMPTY_OUTCOME and len(val) >= 2:
            return True
    if _EXPECTED_SIGNAL_RE.search(text):
        return True
    # Non-trivial expected prose after "Expected result:" style dumps (no label)
    return False


def _validate_required_context(
    *,
    feature_path: str,
    auth_hints: str,
    mode: str,
    locator_contract: str = "",
) -> None:
    if mode in ("none", "public"):
        return
    missing: list[str] = []
    if not (feature_path or "").strip():
        missing.append("featurePath")
    if not _ROLE_SIGNAL_RE.search(auth_hints or ""):
        missing.append("role/authRef")
    # Soft landmark: a usable featurePath already names the screen; landmark prose optional.
    # FE locator contract further grounds the surface but is not required once path exists.
    has_grounding = bool((feature_path or "").strip())
    if not has_grounding and not _LANDMARK_SIGNAL_RE.search(auth_hints or ""):
        missing.append("landmark")
    if not _has_expected_outcome(auth_hints or ""):
        missing.append("expectedOutcome")
    if missing:
        need = ", ".join(missing)
        how = "; ".join(
            f"{k}: {_CONTEXT_MISSING_HINTS.get(k, 'bổ sung context')}" for k in missing
        )
        raise E2EStrictGateError(
            "ContextMissing",
            f"[Thiếu Context] thiếu {need}. {how}.",
        )


def _assert_no_brittle_locators(files: list) -> None:
    violations: list[str] = []
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/").lower()
        if "/pages/" not in f"/{p}/" and "/specs/" not in f"/{p}/":
            continue
        text = getattr(f, "content", "") or ""
        if re.search(r"nth-child\s*\(", text):
            violations.append(f"{getattr(f, 'path', '')}: nth-child")
        if re.search(r"locator\(\s*['\"][^'\"]*>\s*[^'\"]*['\"]\s*\)\.first\(", text):
            violations.append(f"{getattr(f, 'path', '')}: brittle locator().first()")
    if violations:
        raise E2EStrictGateError(
            "LocatorNotFound",
            "Brittle selector detected. Use data-testid/data-cy/role-based locators. "
            + "; ".join(violations[:4]),
        )


# Env keys Desktop / orchestrator actually inject (Rule 23).
_ALLOWED_E2E_ENV_EXACT = frozenset(
    {
        "E2E_BASE_URL",
        "E2E_USERNAME",
        "E2E_PASSWORD",
        "E2E_STORAGE_STATE",
        "E2E_LOGIN_PATH",
        "E2E_ROLE",
        "E2E_AUTH_ROLE",
        "E2E_FEATURE_PATH",
        "E2E_AUTH_MODE",
    }
)
_ALLOWED_E2E_ENV_ROLE_RE = re.compile(
    r"^E2E_[A-Z0-9_]+_(?:USERNAME|PASSWORD)$"
)
_PROCESS_ENV_E2E_RE = re.compile(
    r"""process\.env(?:\.|\[['\"])(E2E_[A-Z0-9_]+)(?:['"]\])?"""
)
# Also catch: (process.env as any).E2E_FOO / process.env['E2E_FOO']
_PROCESS_ENV_E2E_BRACKET_RE = re.compile(
    r"""process\.env\s*(?:as\s+any)?\s*\.\s*(E2E_[A-Z0-9_]+)"""
    r"""|process\.env\s*\[\s*['"](E2E_[A-Z0-9_]+)['"]\s*\]""",
    re.I,
)


def _is_allowed_e2e_env_key(key: str) -> bool:
    k = (key or "").strip().upper()
    if not k.startswith("E2E_"):
        return False
    if k in _ALLOWED_E2E_ENV_EXACT:
        return True
    return bool(_ALLOWED_E2E_ENV_ROLE_RE.match(k))


def _parse_testdata_seeds(test_data: str) -> dict[str, str]:
    """key=value from TC testData — exclude path/auth meta."""
    meta = {
        "path",
        "route",
        "url",
        "featurepath",
        "feature_path",
        "authrole",
        "auth_role",
        "role",
        "roles",
        "authrequired",
        "auth_required",
        "landmark",
        "multirole",
        "trace",
    }
    out: dict[str, str] = {}
    for line in (test_data or "").splitlines():
        m = re.match(r"^\s*([A-Za-z_][\w-]*)\s*[:=]\s*(.+)$", line)
        if not m:
            continue
        key = m.group(1).strip()
        val = m.group(2).strip().strip("\"'")
        if not val or key.lower() in meta:
            continue
        out[key] = val
        # Also index UPPER_SNAKE for env-name matching
        out[re.sub(r"[^A-Za-z0-9]+", "_", key).upper()] = val
    return out


def _env_key_to_seed_candidates(env_key: str) -> list[str]:
    """E2E_STORAGE_ROOM_NAME → STORAGE_ROOM_NAME, ROOM_NAME, roomName…"""
    k = (env_key or "").upper()
    if k.startswith("E2E_"):
        k = k[4:]
    parts = [p for p in k.split("_") if p]
    cands = [k, "_".join(parts)]
    if len(parts) >= 2:
        cands.append("_".join(parts[1:]))  # drop STORAGE prefix guess
        cands.append(parts[-1])
        cands.append(parts[-2] + "_" + parts[-1] if len(parts) >= 2 else parts[-1])
    # camelCase last two
    if len(parts) >= 2:
        camel = parts[-2].lower() + "".join(p.title() for p in parts[-1:])
        cands.append(camel)
    return [c for c in cands if c]


def _rewrite_or_assert_e2e_env_usage(files: list, *, test_data: str = "") -> None:
    """
    Rule 23: ban invented process.env.E2E_* outside Desktop/orchestrator inject set.
    If TC testData has a matching seed → rewrite to string literal; else ContextMissing.
    """
    seeds = _parse_testdata_seeds(test_data)
    invented: list[str] = []
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/").lower()
        if "/pages/" not in f"/{p}/" and "/specs/" not in f"/{p}/":
            continue
        # Skip shared auth helper (legitimately reads E2E_USERNAME etc.)
        if p.endswith("ensureauthenticated.ts") or "/_shared/" in f"/{p}/":
            # Still scan shared for invented keys beyond allowlist
            pass
        text = getattr(f, "content", "") or ""
        keys: set[str] = set()
        for m in _PROCESS_ENV_E2E_RE.finditer(text):
            keys.add(m.group(1).upper())
        for m in _PROCESS_ENV_E2E_BRACKET_RE.finditer(text):
            keys.add((m.group(1) or m.group(2) or "").upper())
        new_text = text
        for key in sorted(keys):
            if _is_allowed_e2e_env_key(key):
                continue
            seed_val = None
            for cand in _env_key_to_seed_candidates(key):
                if cand in seeds:
                    seed_val = seeds[cand]
                    break
                # case-insensitive seed keys
                for sk, sv in seeds.items():
                    if sk.upper() == cand.upper():
                        seed_val = sv
                        break
                if seed_val:
                    break
            if seed_val is not None:
                lit = json.dumps(seed_val)
                # Replace common access patterns with literal
                patterns = [
                    rf"process\.env\.{key}\b",
                    rf"process\.env\[['\"]{key}['\"]\]",
                    rf"\(process\.env\s+as\s+any\)\.{key}\b",
                ]
                for pat in patterns:
                    # Use function replacement so JSON escapes (e.g. "\uXXXX", backslashes)
                    # are emitted literally and never parsed as re.sub replacement escapes.
                    new_text = re.sub(pat, lambda _m, s=lit: s, new_text)
                continue
            invented.append(f"{getattr(f, 'path', '')}: {key}")
        if new_text != text:
            f.content = new_text
    if invented:
        raise E2EStrictGateError(
            "ContextMissing",
            "[Thiếu Context] invented process.env."
            + invented[0].split(": ")[-1]
            + " (Rule 23) — runner không inject key này. "
            "Dùng TC testData seed hoặc allowlist E2E_* (BASE_URL/USERNAME/PASSWORD/"
            "STORAGE_STATE/LOGIN_PATH/ROLE/FEATURE_PATH/E2E_<ROLE>_USERNAME|PASSWORD). "
            + "; ".join(invented[:4]),
        )


def apply_e2e_codegen_guards(
    files: list,
    *,
    dom_snapshot: str = "",
    auth_mode: str | None = None,
    use_storage: bool | None = None,
    test_case_title: str = "",
    auth_hints: str = "",
    headed: bool = False,
    feature_path: str = "",
    locator_contract: str = "",
    strict_gate: bool = False,
    enforce_journey: bool = True,
    enforce_stubs: bool = True,
    test_data: str = "",
) -> list:
    """Run deterministic guards across generated E2E files.

    Phase 2: after auth/entry inject, validate Auth → Feature entry → Act or raise
    ``E2ECodegenJourneyError`` (fail codegen — do not ship incomplete Specs).
    Phase 3: empty POM stubs rewritten from DOM or fail ``E2ECodegenStubError``.
    """
    from app.llm.base import E2EFile
    from app.services.e2e_auth_mode import (
        is_login_or_auth_tc,
        is_public_no_auth_signal,
        resolve_auth_mode,
        wants_no_auth_artifacts,
        wants_storage_state,
        wants_ui_auth_helper,
    )

    normalized: list[E2EFile] = []
    for item in files:
        if isinstance(item, E2EFile):
            normalized.append(
                E2EFile(path=item.path, content=item.content, kind=item.kind)
            )
        elif isinstance(item, dict):
            normalized.append(
                E2EFile(
                    path=str(item.get("path") or ""),
                    content=str(item.get("content") or ""),
                    kind=str(item.get("kind") or "spec"),
                )
            )

    # Soft suite hint only — never bake one path into every TC (batch Verify noise).
    feature_path = (feature_path or "").strip()
    if not feature_path:
        feature_path = infer_feature_path_from_files(normalized, hint="")
    multi_spec = (
        sum(
            1
            for f in normalized
            if getattr(f, "kind", "") == "spec"
            or "/specs/" in f"/{(f.path or '').replace(chr(92), '/').lower()}/"
            or (f.path or "").lower().endswith(".spec.ts")
        )
        > 1
    )
    # When batch has many Specs, leave bake empty in stubs — per-TC bake at end.
    stub_feature_path = "" if multi_spec else feature_path

    # Heal bad shorten leftovers: specs/*.ts (no .spec) / pages/*.ts (no .page)
    # → Playwright testMatch requires *.spec.ts|*.test.ts.
    normalized = restore_playwright_file_suffixes(normalized)

    # Drop AI garbage: .spec.ts that only re-declares @playwright/test (no test())
    cleaned: list[E2EFile] = []
    for f in normalized:
        p = f.path.replace("\\", "/").lower()
        is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
        if is_spec and is_bogus_spec_content(f.content or ""):
            continue
        cleaned.append(f)
    normalized = cleaned
    # Heal mashed / orphan imports BEFORE missing-POM synthesis so Specs that
    # lost ``import {`` still match _SPEC_PAGE_IMPORT_RE and get a page file.
    for f in normalized:
        p = (f.path or "").replace("\\", "/").lower()
        is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
        if is_spec:
            f.content = normalize_collapsed_imports(f.content or "")
    normalized = _ensure_referenced_page_files(normalized)

    # Empty / invalid storageState.json breaks Playwright load — drop the file
    normalized = [
        f
        for f in normalized
        if not (
            looks_like_storage_state_path(f.path)
            and not is_valid_storage_state_json(f.content or "")
        )
    ]

    page_by_base: dict[str, E2EFile] = {}
    for f in normalized:
        p = f.path.replace("\\", "/")
        if f.kind != "page" and "/pages/" not in p:
            continue
        base = p.rsplit("/", 1)[-1].lower()
        page_by_base[base] = f
        stem = base.replace(".page.ts", "").replace(".ts", "")
        page_by_base[f"{stem}.page"] = f

    for f in normalized:
        p = f.path.replace("\\", "/")
        if f.kind == "page" or "/pages/" in p:
            f.content = fix_duplicate_button_locators(f.content, dom_snapshot=dom_snapshot)
            f.content = _scope_bare_button_to_form(f.content)
            f.content = _rewrite_login_rejected_assertion(f.content)
            f.content = strip_feature_expects_from_goto(f.content)
            f.content = rewrite_networkidle_goto(f.content)

    for f in normalized:
        p = f.path.replace("\\", "/")
        if f.kind != "spec" and "/specs/" not in p:
            continue
        f.content = rewrite_networkidle_goto(f.content or "")
        for m in re.finditer(r"""from\s+['"]([^'"]+)['"]""", f.content):
            leaf = m.group(1).rsplit("/", 1)[-1].lower()
            candidates = [leaf, f"{leaf}.ts", f"{leaf}.page.ts"]
            page_file = next((page_by_base[c] for c in candidates if c in page_by_base), None)
            if page_file is None:
                continue
            f.content, page_file.content = fix_page_method_contract(
                f.content,
                page_file.content,
                dom_snapshot=dom_snapshot,
                feature_path=stub_feature_path,
            )
            f.content, page_file.content = _ensure_locator_fields_for_spec_expects(
                f.content, page_file.content
            )

    # Always rewrite leftover ungrounded throws (even if Spec↔POM already matched)
    for f in normalized:
        p = (f.path or "").replace("\\", "/")
        if f.kind == "page" or "/pages/" in p:
            f.content = _rewrite_ungrounded_nav_stubs(
                f.content or "",
                feature_path=stub_feature_path,
                dom_snapshot=dom_snapshot,
            )
            f.content = _rewrite_shell_action_locators(f.content or "")
            f.content = _rewrite_expect_object_string_stubs(f.content or "")
            f.content = _rewrite_feature_nav_seed_stubs(
                f.content or "", feature_path=stub_feature_path
            )

    has_valid_state = any(
        looks_like_storage_state_path(f.path)
        and is_valid_storage_state_json(f.content or "")
        for f in normalized
    )
    path_blob = " ".join((f.path or "") for f in normalized)
    # Do NOT scan generated Spec bodies for PUBLIC/auth signals — AI often writes
    # «Auth: PUBLIC — không ensureAuthenticated» on protected apps (circular).
    # Mode comes from TC title/path + SRS/DOM hints + storage JSON only.
    app_public = is_public_no_auth_signal(
        title=test_case_title,
        path=path_blob,
        dom_snapshot=dom_snapshot,
        hints=auth_hints or "",
    )
    mode = auth_mode or resolve_auth_mode(
        use_storage=bool(use_storage) if use_storage is not None else False,
        has_valid_storage_json=has_valid_state,
        is_login_tc=is_login_or_auth_tc(test_case_title, path_blob),
        app_public=app_public,
    )
    # Never leave storageState path in config when the JSON is absent → Playwright ENOENT.
    # Fall back to ui_helper (ensureAuthenticated + E2E_* env) for apps that need login.
    if wants_storage_state(mode) and not has_valid_state:
        mode = "ui_helper" if not app_public else "public"
    # Headed Chromium: show login UI as step 0 (storageState would skip the screen).
    if (
        headed
        and wants_storage_state(mode)
        and not app_public
        and not is_login_or_auth_tc(test_case_title, path_blob)
    ):
        mode = "ui_helper"
    if strict_gate:
        _validate_required_context(
            feature_path=feature_path,
            auth_hints=auth_hints,
            mode=mode,
            locator_contract=locator_contract or "",
        )
    prefer_storage = wants_storage_state(mode)
    for f in normalized:
        p = f.path.replace("\\", "/").lower()
        is_cfg = f.kind == "config" or p.endswith("playwright.config.ts")
        if not is_cfg:
            continue
        f.content = normalize_config_storage_state(
            f.content or "",
            has_valid_state=has_valid_state,
            prefer_storage=prefer_storage,
        )
        # ui_helper / public / login-TC: no globalSetup seed (would demand creds + write
        # storageState while Specs already use ensureAuthenticated or no auth).
        if not prefer_storage:
            f.content = re.sub(
                r"^[ \t]*globalSetup\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\n",
                "",
                f.content,
                flags=re.MULTILINE,
            )

    # Drop orphaned global.setup.ts when not in storage mode (avoids stale seeds
    # and matches config without globalSetup).
    if not prefer_storage:
        normalized = [
            f
            for f in normalized
            if not (f.path or "")
            .replace("\\", "/")
            .lower()
            .endswith("/fixtures/global.setup.ts")
        ]

    # Rewrite cross-TC page imports to local ../pages/ (each TC has its own config)
    for f in normalized:
        p = f.path.replace("\\", "/")
        is_spec = f.kind == "spec" or "/specs/" in f"/{p.lower()}/" or p.lower().endswith(".spec.ts")
        if is_spec:
            f.content = normalize_collapsed_imports(f.content or "")
            f.content = _rewrite_cross_tc_imports(f.content, f.path, normalized)

    # Strip test.use({ storageState }) from specs when not in storage mode
    # (keep anonymous empty storageState override for deliberate unauthenticated TCs)
    if not prefer_storage:
        for f in normalized:
            p = f.path.replace("\\", "/").lower()
            is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
            if is_spec:
                f.content = _strip_spec_storage_state(f.content)

    # Validation specs: replace click-submit with assert-disabled
    for f in normalized:
        p = f.path.replace("\\", "/").lower()
        is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
        if is_spec:
            f.content = _rewrite_validation_spec_click_to_disabled(f.content)

    # Rewrite hardcoded getByText('exact message') to regex partial match
    for f in normalized:
        p = f.path.replace("\\", "/").lower()
        is_spec_or_page = (
            f.kind in ("spec", "page")
            or "/specs/" in f"/{p}/"
            or "/pages/" in f"/{p}/"
        )
        if is_spec_or_page:
            f.content = _relax_hardcoded_error_text(f.content)
            f.content = _relax_exact_gettext(f.content)
            f.content = _fix_literal_regex_gettext(f.content)
            f.content = _fix_nested_expect_on_pom_asserts(f.content)
            f.content = _fix_promise_coercion_crashes(f.content)
            f.content = _sync_async_path_helpers(f.content)
            f.content = _sync_async_locator_getters(f.content)
            f.content = fix_select_option_label_regexp(f.content)

    # Mutual exclusion: ui_helper injects ensureAuthenticated; storage/public/none strip it
    if wants_ui_auth_helper(mode):
        normalized = ensure_auth_helper_files(
            normalized, feature_path=stub_feature_path
        )
    else:
        for f in normalized:
            p = (f.path or "").replace("\\", "/").lower()
            is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
            if is_spec:
                f.content = strip_ensure_authenticated(f.content or "")
        if wants_no_auth_artifacts(mode):
            normalized = [
                f
                for f in normalized
                if not re.search(
                    r"(?i)/(?:auth\.helper\.ts|global\.setup\.ts|storagestate\.json)$",
                    (f.path or "").replace("\\", "/"),
                )
            ]
        # Phase 2: storage/public feature Specs still need Feature entry
        if mode in ("storage", "public"):
            normalized = ensure_feature_entry_on_feature_specs(
                normalized, feature_path=stub_feature_path, require_auth_call=False
            )

    # Final Feature-entry pass for every non-login Spec (ui_helper may have already
    # injected; idempotent). require_auth_call=False so storage leftovers / Auth
    # category TCs still get ``test.step('1. Feature entry')`` before Phase-2 enforce.
    if mode not in ("none",):
        normalized = ensure_feature_entry_on_feature_specs(
            normalized, feature_path=stub_feature_path, require_auth_call=False
        )

    # After Auth(0) + Feature entry(1) inject, LLM Act steps often restart at 1.
    # Renumber every test.step to continuous 0..N so step capture / headed runner works.
    for f in normalized:
        p = (f.path or "").replace("\\", "/").lower()
        is_spec = f.kind == "spec" or "/specs/" in f"/{p}/" or p.endswith(".spec.ts")
        if not is_spec:
            continue
        f.content = renumber_spec_test_steps(f.content or "")
        f.content = _strip_orphan_type_imports(f.content or "")
        f.content = normalize_collapsed_imports(f.content or "")
        f.content = canonicalize_ensure_authenticated_imports(
            f.content,
            spec_path=getattr(f, "path", "") or "",
            helper_path=next(
                (
                    (x.path or "").replace("\\", "/")
                    for x in normalized
                    if (x.path or "").replace("\\", "/").lower().endswith(
                        "auth.helper.ts"
                    )
                ),
                "",
            ),
        )
        f.content = normalize_collapsed_imports(f.content or "")

    if enforce_journey:
        # Final fail-safe for ui_helper mode: ensure Auth step exists before
        # strict journey validation. Some model outputs keep unusual Spec shapes
        # that may bypass earlier inject pass.
        if mode == "ui_helper":
            helper_path = _module_prefix_for_fixtures(normalized) + "/fixtures/auth.helper.ts"
            for f in normalized:
                p = (getattr(f, "path", "") or "").replace("\\", "/")
                is_spec = (
                    getattr(f, "kind", "") == "spec"
                    or "/specs/" in f"/{p}/"
                    or p.endswith(".spec.ts")
                )
                if not is_spec:
                    continue
                if _is_login_or_auth_spec(p, getattr(f, "content", "") or ""):
                    continue
                if not _spec_has_ensure_authenticated_call(f.content or ""):
                    fixed = inject_ensure_authenticated(
                        f.content or "",
                        spec_path=getattr(f, "path", "") or "",
                        helper_path=helper_path,
                    )
                    fixed = inject_feature_entry_step(
                        fixed,
                        feature_path=stub_feature_path,
                        require_auth_call=True,
                    )
                    f.content = _reorder_feature_entry_before_act(
                        _reorder_feature_entry_after_auth(
                            normalize_collapsed_imports(fixed)
                        )
                    )
        from app.services.e2e_journey_enforce import (
            assert_e2e_ts_syntax_ok,
            assert_feature_journey_ok,
            heal_feature_journey_order,
            heal_missing_business_assertions,
        )

        # Always heal Auth→Feature order before strict enforce (LLM often navigates first).
        for f in normalized:
            p = (getattr(f, "path", "") or "").replace("\\", "/")
            is_spec = (
                getattr(f, "kind", "") == "spec"
                or "/specs/" in f"/{p}/"
                or p.endswith(".spec.ts")
            )
            if not is_spec:
                continue
            if _is_login_or_auth_spec(p, getattr(f, "content", "") or ""):
                continue
            f.content = heal_feature_journey_order(
                _reorder_feature_entry_before_act(
                    _reorder_feature_entry_after_auth(f.content or "")
                )
            )

        if strict_gate:
            for f in normalized:
                p = (getattr(f, "path", "") or "").replace("\\", "/")
                is_spec = (
                    getattr(f, "kind", "") == "spec"
                    or "/specs/" in f"/{p}/"
                    or p.endswith(".spec.ts")
                )
                if not is_spec:
                    continue
                if _is_login_or_auth_spec(p, getattr(f, "content", "") or ""):
                    continue
                # R6: strip fake heals only — never inject generic main|nav asserts
                f.content = heal_missing_business_assertions(
                    f.content or "",
                    expected_hint=auth_hints or "",
                )

        assert_feature_journey_ok(
            normalized,
            mode=mode,
            test_case_title=test_case_title,
            enforce_business_assertions=strict_gate,
        )
        # R9 — brace/syntax before publish
        assert_e2e_ts_syntax_ok(normalized)

    if enforce_stubs:
        from app.services.e2e_stub_grounding import assert_no_empty_pass_stubs

        assert_no_empty_pass_stubs(normalized, dom_snapshot=dom_snapshot)
        # Empty→DOM fail path injects Phase-3 throws AFTER the soft rewrite above.
        # Re-heal so journey Act/Arrange never ships ungrounded (Rule 19).
        for f in normalized:
            p = (f.path or "").replace("\\", "/")
            if f.kind == "page" or "/pages/" in p:
                f.content = _rewrite_ungrounded_nav_stubs(
                    f.content or "",
                    feature_path=stub_feature_path,
                    dom_snapshot=dom_snapshot,
                )

    # Per-TC deep-link bake (force) — fixes suite noise like /admin/case-record on Evidence TCs
    _bake_feature_paths_per_tc(normalized, hint=feature_path)
    for f in normalized:
        p = (f.path or "").replace("\\", "/")
        if not (f.content or "").strip():
            continue
        f.content = rewrite_nested_aitest_imports(f.content or "", p)
        f.content = fix_playwright_shim_reference(f.content or "", p)
    _assert_locator_contract(normalized, locator_contract)
    # Rule 23: ban invented E2E_* env (always — not only strict_gate)
    _rewrite_or_assert_e2e_env_usage(
        normalized,
        test_data=test_data or auth_hints or "",
    )
    if strict_gate:
        _assert_no_brittle_locators(normalized)

    return normalized


def strip_feature_expects_from_goto(content: str) -> str:
    """
    goto() must only navigate. AI often adds expect(listitem).toBeVisible() which
    fails on login-walled apps before auth — strip those asserts (keep page.goto).
    """
    text = content or ""

    def _strip_body(body: str) -> str:
        lines = body.splitlines(keepends=True)
        kept: list[str] = []
        for line in lines:
            stripped = line.lstrip()
            # Drop expect(...).toBeVisible/toHaveCount/etc. — not navigation
            if re.match(
                r"await\s+expect\s*\(",
                stripped,
            ) or re.match(r"expect\s*\(", stripped):
                continue
            kept.append(line)
        return "".join(kept)

    # Match async goto(...) { ... } at class method indentation
    pattern = re.compile(
        r"(async\s+goto\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{)(.*?)(\n[ \t]*\})",
        re.DOTALL,
    )

    def _repl(m: re.Match[str]) -> str:
        head, body, tail = m.group(1), m.group(2), m.group(3)
        return head + _strip_body(body) + tail

    return pattern.sub(_repl, text)


def _spec_calls_ensure_authenticated(content: str) -> bool:
    """True when Spec imports or calls ensureAuthenticated (ignore comments)."""
    text = content or ""
    # Drop block + line comments so «// no ensureAuthenticated» does not count.
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    text = re.sub(r"//.*?$", " ", text, flags=re.MULTILINE)
    return bool(
        re.search(
            r"""(?:import\s*\{[^}]*\bensureAuthenticated\b|ensureAuthenticated\s*\()""",
            text,
        )
    )


def _spec_has_ensure_authenticated_call(content: str) -> bool:
    """True only when Spec actually calls ensureAuthenticated(page)."""
    text = content or ""
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.DOTALL)
    text = re.sub(r"//.*?$", " ", text, flags=re.MULTILINE)
    return bool(re.search(r"""\bensureAuthenticated\s*\(\s*page\b""", text))


def spec_calls_ensure_authenticated(content: str) -> bool:
    """Public alias for orchestrator preflight."""
    return _spec_calls_ensure_authenticated(content)


def _is_login_or_auth_spec(path: str, content: str) -> bool:
    from app.services.e2e_auth_mode import is_login_or_auth_tc, is_public_no_auth_signal

    p = (path or "").replace("\\", "/")
    # Prefer path + test()/describe() titles — not full body (feature steps often
    # mention «đăng nhập» / «không đăng nhập» without being Login TCs).
    titles = " ".join(
        m.group(1)
        for m in re.finditer(
            r"""test(?:\.(?:describe|only|skip))?\s*\(\s*['"`]([^'"`]{0,120})""",
            content or "",
        )
    )
    blob = f"{p}\n{titles}"
    if is_public_no_auth_signal(title=blob, path=p):
        return False
    if is_login_or_auth_tc(title=blob, path=p):
        return True
    return False


def _module_prefix_for_fixtures(files: Iterable) -> str:
    """Return E2ETest/_shared prefix for suite-wide fixtures (auth/storage)."""
    from app.services.test_output_layout import e2e_shared_root

    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        if not p:
            continue
        low = p.lower()
        if "/_shared/" in low:
            return p[: low.find("/_shared/") + len("/_shared")]
        if "/e2etest/" in low:
            idx = low.find("/e2etest/")
            return p[: idx + len("/e2etest")] + "/_shared"
    return e2e_shared_root()


def _auth_helper_import_line(spec_path: str, helper_path: str) -> str:
    import os

    spec_dir = os.path.dirname((spec_path or "").replace("\\", "/")) or "."
    rel = os.path.relpath((helper_path or "").replace("\\", "/"), spec_dir).replace(
        "\\", "/"
    )
    if rel.endswith(".ts"):
        rel = rel[:-3]
    if not rel.startswith("."):
        rel = f"./{rel}"
    # Always end with `;\n` — callers must NOT .strip() this or the next import glues on.
    return f"import {{ ensureAuthenticated }} from '{rel}';\n"


_IMPORT_LINE_RE = re.compile(
    r"^import\s.+?(?:;|$)",
    re.MULTILINE,
)


def normalize_collapsed_imports(content: str) -> str:
    """
    Heal mashed import glue into separate lines.

    Staging Forensic showed mashed imports → SyntaxError → 6/6 FAIL.
    Also restores ``import {`` when a multiline named import lost its opener.
    """
    text = content or ""
    if not text:
        return text
    # from '…'import / from "…"import  (missing newline + optional semicolon)
    text = re.sub(
        r"""(from\s*['"][^'"]+['"])\s*(import\b)""",
        r"\1;\n\2",
        text,
    )
    # `;import` when previous import ended mid-line
    text = re.sub(r""";(import\b)""", r";\n\1", text)
    # Orphan multiline named-import body (missing `import {`)
    text = re.sub(
        r"(;)\s*\n(?P<body>(?:[ \t]+(?:type\s+)?[\w$]+(?:\s+as\s+[\w$]+)?\s*,\s*\n)+"
        r"[ \t]*\})\s*from\s+(?P<q>['\"][^'\"]+['\"])\s*;?",
        r"\1\nimport {\n\g<body> from \g<q>;",
        text,
        flags=re.IGNORECASE,
    )
    # Ensure each import … from '…' ends with semicolon before EOL (when alone on line)
    text = re.sub(
        r"""^(import\s.+from\s*['"][^'"]+['"])\s*$""",
        r"\1;",
        text,
        flags=re.MULTILINE,
    )
    # Fix glued test steps: `});await test.step(...)` → newline between steps.
    text = re.sub(r"\}\);\s*await\s+test\.step\(", "});\n\n  await test.step(", text)
    return text


def canonicalize_ensure_authenticated_imports(
    content: str, *, spec_path: str = "", helper_path: str = ""
) -> str:
    """Point every ensureAuthenticated import at suite ``_shared/fixtures/auth.helper``.

    Also inserts the import when Spec *calls* ``ensureAuthenticated(page)`` but
    AI forgot the import line (common with multiline POM imports).
    """
    text = normalize_collapsed_imports(content or "")
    if "ensureAuthenticated" not in text:
        return text
    if spec_path and helper_path:
        want = _auth_helper_import_line(spec_path, helper_path)
    else:
        want = (
            "import { ensureAuthenticated } from '../../../_shared/fixtures/auth.helper';\n"
        )
    pat = re.compile(
        r"""import\s*\{\s*ensureAuthenticated\s*\}\s*from\s*['"][^'"]+['"]\s*;?"""
    )
    has_import = bool(pat.search(text))
    has_call = bool(re.search(r"\bensureAuthenticated\s*\(", text))
    if not has_import and not has_call:
        return text
    # Drop existing ensureAuthenticated imports (if any), then insert one canonical line
    if has_import:
        text = pat.sub("", text)
        text = re.sub(r"\n{3,}", "\n\n", text)
        text = normalize_collapsed_imports(text)

    last_import = None
    for m in _IMPORT_LINE_RE.finditer(text):
        last_import = m
    if last_import:
        insert_at = last_import.end()
        rest = text[insert_at:]
        text = (
            text[:insert_at]
            + ("\n" if not rest.startswith("\n") else "")
            + want
            + (rest if rest.startswith("\n") else "\n" + rest)
        )
    elif text.lstrip().startswith("///"):
        nl = text.find("\n")
        text = (
            (text[: nl + 1] + want + text[nl + 1 :]) if nl >= 0 else (want + text)
        )
    else:
        text = want + text
    return normalize_collapsed_imports(text)


def ensure_auth_helper_files(
    files: list, *, feature_path: str = ""
) -> list:
    """
    Ensure _shared/fixtures/auth.helper.ts is the canonical helper and inject
    ensureAuthenticated into feature specs when storageState is absent.
    Phase 2: always inject Feature entry on feature Specs (even if auth already present).
    """
    from app.llm.base import E2EFile

    out: list = list(files)
    feature_specs: list = []
    feature_need_auth: list = []
    has_feature_spec = False
    for f in out:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        is_spec = getattr(f, "kind", "") == "spec" or "/specs/" in f"/{p}/" or p.endswith(
            ".spec.ts"
        )
        if not is_spec:
            continue
        if _is_login_or_auth_spec(p, getattr(f, "content", "") or ""):
            continue
        has_feature_spec = True
        feature_specs.append(f)
        content = getattr(f, "content", "") or ""
        if not _spec_has_ensure_authenticated_call(content):
            feature_need_auth.append(f)

    shared_prefix = _module_prefix_for_fixtures(out)
    helper_path = f"{shared_prefix}/fixtures/auth.helper.ts"

    # Collapse duplicate per-TC auth.helper copies into the suite _shared path
    cleaned: list = []
    helper_written = False
    for f in out:
        p = (getattr(f, "path", "") or "").replace("\\", "/").lower()
        if p.endswith("auth.helper.ts"):
            if helper_written:
                continue
            f.path = helper_path
            f.content = _AUTH_HELPER_TS
            cleaned.append(f)
            helper_written = True
            continue
        cleaned.append(f)
    out = cleaned

    if not helper_written and (has_feature_spec or feature_need_auth):
        out.append(E2EFile(path=helper_path, content=_AUTH_HELPER_TS, kind="fixture"))

    for f in feature_need_auth:
        f.content = inject_ensure_authenticated(
            f.content or "",
            spec_path=getattr(f, "path", "") or "",
            helper_path=helper_path,
        )
    for f in feature_specs:
        f.content = inject_feature_entry_step(
            f.content or "",
            feature_path=feature_path,
            require_auth_call=True,
        )
        # Normalize any ensureAuthenticated import (auth.helper or AI wrong path) → _shared
        sp = getattr(f, "path", "") or ""
        content = normalize_collapsed_imports(f.content or "")
        if "ensureAuthenticated" in content:
            content = canonicalize_ensure_authenticated_imports(
                content, spec_path=sp, helper_path=helper_path
            )
        f.content = normalize_collapsed_imports(content)

    return out


def ensure_feature_entry_on_feature_specs(
    files: list,
    *,
    feature_path: str = "",
    require_auth_call: bool = False,
) -> list:
    """Phase 2 — inject Feature entry on every non-login Spec."""
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        is_spec = getattr(f, "kind", "") == "spec" or "/specs/" in f"/{p}/" or p.endswith(
            ".spec.ts"
        )
        if not is_spec:
            continue
        if _is_login_or_auth_spec(p, getattr(f, "content", "") or ""):
            continue
        f.content = inject_feature_entry_step(
            f.content or "",
            feature_path=feature_path,
            require_auth_call=require_auth_call,
        )
        f.content = _reorder_feature_entry_before_act(
            _reorder_feature_entry_after_auth(f.content or "")
        )
    return files


def inject_feature_entry_step(
    spec_content: str,
    *,
    feature_path: str = "",
    require_auth_call: bool = True,
) -> str:
    """
    After auth, ensure Viewer opens the feature under test (Phase C).
    Uses E2E_FEATURE_PATH (or baked feature_path). Never invents routes.

    Skip only when Phase-2 ``spec_has_feature_entry`` already passes.
    Always insert AFTER ``ensureAuthenticated`` when present — never before Auth.
    """
    text = spec_content or ""
    has_explicit_entry = bool(
        re.search(r"test\.step\s*\(\s*['\"][^'\"]*feature\s*entry", text, re.IGNORECASE)
        or re.search(r"\b(?:gotoFeature|openFeature)\s*\(", text)
        or (re.search(r"E2E_FEATURE_PATH", text) and re.search(r"page\.goto\s*\(", text))
    )
    if has_explicit_entry:
        # Repair: injected Feature entry sometimes landed before Auth.
        return _reorder_feature_entry_before_act(
            _reorder_feature_entry_after_auth(text)
        )
    if require_auth_call and not re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", text):
        return text

    baked = (feature_path or "").strip().replace("\\", "/")
    if baked and not baked.startswith("/") and not baked.startswith("http"):
        baked = f"/{baked}"
    baked_js = json.dumps(baked) if baked else '""'

    step = (
        "\n  await test.step('1. Feature entry', async () => {\n"
        f"    const baked = {baked_js};\n"
        "    const featurePath = (baked || process.env.E2E_FEATURE_PATH || '').trim();\n"
        "    if (featurePath) {\n"
        "      const path = featurePath.startsWith('http') || featurePath.startsWith('/')\n"
        "        ? featurePath\n"
        "        : `/${featurePath}`;\n"
        "      await page.goto(path, { waitUntil: 'domcontentloaded' });\n"
        "    }\n"
        "    // Landmark on feature shell — never invent routes when path empty\n"
        "    await page.locator('main, [role=\"main\"], nav, h1, h2, [data-cy], [data-testid]')"
        ".first().waitFor({ state: 'visible', timeout: 15000 }).catch(() => undefined);\n"
        "  });"
    )

    # Prefer Auth test.step that contains ensureAuthenticated (any index, multiline).
    auth_step = re.search(
        r"await\s+test\.step\s*\(\s*['\"][^'\"]*(?:[Aa]uth|[Ll]ogin|[Dd]ăng)[^'\"]*['\"]\s*,\s*"
        r"async\s*\(\s*\)\s*=>\s*\{"
        r".*?ensureAuthenticated\s*\(\s*page\s*\)\s*;?"
        r".*?\}\s*\)\s*;",
        text,
        re.DOTALL | re.IGNORECASE,
    )
    if auth_step:
        return _reorder_feature_entry_before_act(
            _reorder_feature_entry_after_auth(
                text[: auth_step.end()] + step + text[auth_step.end() :]
            )
        )
    # Bare ensureAuthenticated — semicolon optional
    m = re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;?", text)
    if m:
        return _reorder_feature_entry_before_act(
            _reorder_feature_entry_after_auth(text[: m.end()] + step + text[m.end() :])
        )
    # Do NOT prepend at test() open when Auth exists only as import — wait for call.
    if re.search(r"ensureAuthenticated", text):
        return text
    pattern = re.compile(
        r"(test(?:\.(?:only|skip))?\s*\("
        r"(?:[^;]*?)"
        r"async\s*\(\s*\{(?P<fix>[^}]*)\}\s*(?:,\s*\w+)?\s*\)\s*=>\s*\{)",
        re.DOTALL,
    )

    def repl(m: "re.Match[str]") -> str:
        fixtures = m.group("fix")
        if not re.search(r"\bpage\b", fixtures):
            return m.group(0)
        return m.group(0) + step

    new_text, n = pattern.subn(repl, text, count=1)
    return (
        _reorder_feature_entry_before_act(_reorder_feature_entry_after_auth(new_text))
        if n
        else text
    )


_FEATURE_ENTRY_BLOCK_RE = re.compile(
    r"\n?\s*await\s+test\.step\s*\(\s*['\"][^'\"]*"
    r"(?:Feature\s*entry|Vào\s*chức\s*năng|feature\s*entry|mở\s*màn)"
    r"[^'\"]*['\"]\s*,\s*"
    r"async\s*\(\s*\)\s*=>\s*\{.*?\}\s*\)\s*;",
    re.DOTALL | re.IGNORECASE,
)


_TEST_STEP_BLOCK_RE = re.compile(
    r"\n?\s*await\s+test\.step\s*\(\s*['\"](?P<title>[^'\"]+)['\"]\s*,\s*"
    r"async\s*\(\s*\)\s*=>\s*\{.*?\}\s*\)\s*;",
    re.DOTALL | re.IGNORECASE,
)


def _is_meta_step_title(title: str) -> bool:
    t = (title or "").strip()
    return bool(
        re.search(r"(?:feature\s*entry|vào\s*chức\s*năng|mở\s*màn)", t, re.IGNORECASE)
        or re.search(
            r"(?:đăng\s*nhập|login|authenticat|^\d+\.\s*auth\b)",
            t,
            re.IGNORECASE,
        )
    )


def _reorder_feature_entry_after_auth(spec_content: str) -> str:
    """Move a Feature-entry test.step to immediately after ensureAuthenticated when misplaced."""
    from app.services.e2e_journey_enforce import reorder_feature_entry_after_auth

    return reorder_feature_entry_after_auth(spec_content)


def _reorder_feature_entry_before_act(spec_content: str) -> str:
    """Move Feature entry test.step before the first Act test.step when misplaced."""
    from app.services.e2e_journey_enforce import reorder_feature_entry_before_act

    return reorder_feature_entry_before_act(spec_content)

def inject_ensure_authenticated(
    spec_content: str,
    *,
    spec_path: str = "",
    helper_path: str = "",
) -> str:
    """Add import + visible test.step for login before POM actions."""
    text = normalize_collapsed_imports(spec_content or "")
    # Already imported from anywhere — canonicalize path instead of double-import
    if re.search(r"""import\s*\{\s*ensureAuthenticated\s*\}""", text):
        text = canonicalize_ensure_authenticated_imports(
            text, spec_path=spec_path, helper_path=helper_path
        )
        return _inject_ensure_auth_calls(normalize_collapsed_imports(text))

    if spec_path and helper_path:
        import_line = _auth_helper_import_line(spec_path, helper_path)
    else:
        import_line = (
            "import { ensureAuthenticated } from '../../../_shared/fixtures/auth.helper';\n"
        )
    last_import = None
    for m in _IMPORT_LINE_RE.finditer(text):
        last_import = m
    if last_import:
        insert_at = last_import.end()
        # Ensure we don't glue onto the remainder of the line
        rest = text[insert_at:]
        sep = "" if rest.startswith("\n") else "\n"
        text = text[:insert_at] + sep + import_line + (
            rest if rest.startswith("\n") or not rest else "\n" + rest.lstrip()
        )
    else:
        text = import_line + text

    return _inject_ensure_auth_calls(normalize_collapsed_imports(text))


def _inject_ensure_auth_calls(text: str) -> str:
    """
    Each test that uses `page` starts with a visible login step so headed
    Playwright / list reporter show Step 0 before feature steps.
    """
    # Already wrapped as a named step
    if re.search(
        r"test\.step\s*\(\s*['\"][^'\"]*(?:[Dd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat)",
        text,
    ) and re.search(r"ensureAuthenticated\s*\(\s*page\s*\)", text):
        return text
    # Bare call → upgrade to test.step
    if re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;", text):
        text = re.sub(
            r"^[ \t]*await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;\s*$",
            "  await test.step('0. Đăng nhập / authenticate', async () => {\n"
            "    await ensureAuthenticated(page);\n"
            "  });",
            text,
            flags=re.MULTILINE,
            count=1,
        )
        # If multiple tests, upgrade all bare calls
        text = re.sub(
            r"^[ \t]*await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;\s*$",
            "  await test.step('0. Đăng nhập / authenticate', async () => {\n"
            "    await ensureAuthenticated(page);\n"
            "  });",
            text,
            flags=re.MULTILINE,
        )
        return text

    pattern = re.compile(
        r"(test(?:\.(?:only|skip))?\s*\("
        r"(?:[^;]*?)"
        r"async\s*\(\s*\{(?P<fix>[^}]*)\}\s*(?:,\s*\w+)?\s*\)\s*=>\s*\{)",
        re.DOTALL,
    )

    def repl(m: re.Match[str]) -> str:
        fixtures = m.group("fix")
        if not re.search(r"\bpage\b", fixtures):
            return m.group(0)
        return (
            m.group(0)
            + "\n  await test.step('0. Đăng nhập / authenticate', async () => {"
            + "\n    await ensureAuthenticated(page);"
            + "\n  });"
        )

    return pattern.sub(repl, text)


def is_bogus_spec_content(content: str) -> bool:
    """True when a 'spec' is actually a type-shim / declare-module dump."""
    text = content or ""
    if re.search(r"\btest\s*\(", text):
        return False
    if "declare module" in text and "@playwright/test" in text:
        return True
    # Empty or only reference/import noise
    stripped = re.sub(r"^\s*///.*$", "", text, flags=re.MULTILINE).strip()
    if not stripped:
        return True
    return False


def _e2e_suite_root_from_path(file_path: str) -> str | None:
    """Return ``[{pkg}/]AItest/E2ETest`` prefix from a normalized file path."""
    p = (file_path or "").replace("\\", "/").strip("/")
    if not p:
        return None
    parts = p.split("/")
    for i, seg in enumerate(parts):
        if seg == "AItest" and i + 1 < len(parts) and parts[i + 1] == "E2ETest":
            return "/".join(parts[: i + 2])
    return None


def fix_playwright_shim_reference(content: str, file_path: str) -> str:
    """Recompute ``/// <reference path=…>`` → ``_shared/types/playwright-shim.d.ts``."""
    text = content or ""
    if "playwright/test" not in text.lower():
        return text
    suite = _e2e_suite_root_from_path(file_path)
    if not suite:
        return text
    shim_abs = f"{suite}/_shared/types/playwright-shim.d.ts"
    file_dir = os.path.dirname(file_path.replace("\\", "/")) or "."
    rel = os.path.relpath(shim_abs, file_dir).replace("\\", "/")
    new_ref = f'/// <reference path="{rel}" />'
    if re.search(r"///\s*<reference\s+path=", text):
        return re.sub(
            r'///\s*<reference\s+path=["\'][^"\']*["\']\s*/>',
            new_ref,
            text,
            count=1,
        )
    return f"{new_ref}\n{text}"


def rewrite_nested_aitest_imports(content: str, file_path: str) -> str:
    """
    LLM sometimes emits ``../AItest/E2ETest/_shared/pages/X`` from files already
    under the suite — rewrite to correct relative imports.
    """
    text = content or ""
    if "AItest" not in text and "aitest" not in text.lower():
        return text
    suite = _e2e_suite_root_from_path(file_path)
    if not suite:
        return text
    import_re = re.compile(r"""(from\s+['"])([^'"]+)(['"])""")

    def _repl(m: re.Match[str]) -> str:
        prefix, raw, suffix = m.group(1), m.group(2).replace("\\", "/"), m.group(3)
        if "AItest/E2ETest" not in raw and "aitest/e2etest" not in raw.lower():
            return m.group(0)
        tail_m = re.search(
            r"(?:^|[./]*)(?:[^/]+/)*AItest/E2ETest/(.+)$", raw, re.IGNORECASE
        )
        if not tail_m:
            return m.group(0)
        tail = tail_m.group(1)
        target = f"{suite}/{tail}"
        if not target.endswith((".ts", ".tsx", ".js", ".jsx")):
            # import spec usually omits extension — keep as-is for relpath target
            pass
        from_dir = os.path.dirname(file_path.replace("\\", "/")) or "."
        rel = os.path.relpath(target, from_dir).replace("\\", "/")
        rel = re.sub(r"\.(tsx?|jsx?)$", "", rel, flags=re.IGNORECASE)
        if not rel.startswith("."):
            rel = f"./{rel}"
        return f"{prefix}{rel}{suffix}"

    return import_re.sub(_repl, text)


def _rewrite_cross_tc_imports(content: str, spec_path: str, all_files: list) -> str:
    """
    Specs import POM from suite ``_shared/pages`` (or legacy sibling ``../pages``).
    AI sometimes generates cross-TC imports like ``../../OtherTC/pages/foo.page``.
    Rewrite those to ``_shared/pages`` (preferred) or local ``../pages``.
    """
    if not content:
        return content

    import_re = re.compile(r"""(from\s+['"])([^'"]+)(['"])""")

    def _repl(m: re.Match[str]) -> str:
        prefix, raw_path, suffix = m.group(1), m.group(2).replace("\\", "/"), m.group(3)
        if "/pages/" not in raw_path:
            return m.group(0)
        # Nested LLM path like ../AItest/E2ETest/_shared/pages/foo — normalize first
        if "AItest/E2ETest" in raw_path or "aitest/e2etest" in raw_path.lower():
            if spec_path:
                fixed = rewrite_nested_aitest_imports(
                    f"{prefix}{raw_path}{suffix}", spec_path
                )
                inner = re.match(r"""from\s+['"]([^'"]+)['"]""", fixed)
                if inner:
                    raw_path = inner.group(1)
        # Already suite-shared or classic sibling — keep
        if "/_shared/pages/" in raw_path or raw_path.startswith("../pages/"):
            return m.group(0)
        leaf = raw_path.rsplit("/pages/", 1)[-1].lstrip("/")
        if not leaf:
            return m.group(0)
        # Prefer relative import into suite _shared from this Spec path
        if spec_path:
            import os

            shared_page = None
            for f in all_files or []:
                p = (getattr(f, "path", "") or "").replace("\\", "/")
                if "/_shared/pages/" in p.lower() and p.rsplit("/", 1)[-1] == leaf.split("/")[-1]:
                    shared_page = p
                    break
                if p.lower().endswith("/" + leaf.lower()) or p.lower().endswith(
                    "/" + leaf.lower() + ".ts"
                ):
                    if "/_shared/pages/" in p.lower():
                        shared_page = p
                        break
            if shared_page:
                spec_dir = os.path.dirname(spec_path.replace("\\", "/")) or "."
                target = shared_page
                if not target.endswith(".ts") and leaf.endswith(".ts"):
                    pass
                elif target.endswith(".ts"):
                    target = target[:-3]
                elif not leaf.endswith(".ts"):
                    # import specs usually omit .ts
                    pass
                rel = os.path.relpath(shared_page, spec_dir).replace("\\", "/")
                if rel.endswith(".ts"):
                    rel = rel[:-3]
                if not rel.startswith("."):
                    rel = f"./{rel}"
                return f"{prefix}{rel}{suffix}"
        return f"{prefix}../../../_shared/pages/{leaf}{suffix}"

    return import_re.sub(_repl, content)


def strip_spec_storage_state(content: str) -> str:
    """Remove test.use({ storageState: ... }) from spec when storageState file is missing."""
    return re.sub(
        r"test\.use\(\s*\{\s*storageState\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\}\s*\)\s*;?\s*\n?",
        "",
        content,
        flags=re.IGNORECASE,
    )


def _strip_spec_storage_state(content: str) -> str:
    return strip_spec_storage_state(content)


# Playwright selectOption({ label }) requires string — AI often passes a RegExp var.
_SELECT_OPTION_LABEL_CALL_RE = re.compile(
    r"(?P<indent>[ \t]*)await\s+(?P<recv>(?:this\.)?[\w.]+)\.selectOption\(\s*"
    r"\{\s*label\s*:\s*(?P<label>[^}\n]+?)\s*\}\s*\)\s*;",
    re.IGNORECASE,
)


def fix_select_option_label_regexp(content: str) -> str:
    """
    Rewrite ``locator.selectOption({ label: reOrString })`` so native <select>
    never receives a RegExp (Playwright: expected string, got object).

    Safe for any project: string literals stay; variables/RegExp resolve via
    matching ``<option>`` text first.
    """
    text = content or ""
    if "selectOption" not in text:
        return text

    def _is_string_literal(expr: str) -> bool:
        s = (expr or "").strip()
        return bool(re.match(r"""^(['"])(?:\\.|(?!\1).)*\1$""", s))

    def _repl(m: re.Match[str]) -> str:
        indent = m.group("indent")
        recv = m.group("recv").strip()
        label = m.group("label").strip()
        if _is_string_literal(label):
            return m.group(0)
        # Keep value/index forms untouched (this regex only matches label:)
        return (
            f"{indent}{{\n"
            f"{indent}  const __aitestSelectLabel = {label};\n"
            f"{indent}  if (typeof __aitestSelectLabel === 'string') {{\n"
            f"{indent}    await {recv}.selectOption({{ label: __aitestSelectLabel }});\n"
            f"{indent}  }} else {{\n"
            f"{indent}    const __aitestSelectRe =\n"
            f"{indent}      __aitestSelectLabel instanceof RegExp\n"
            f"{indent}        ? __aitestSelectLabel\n"
            f"{indent}        : new RegExp(String(__aitestSelectLabel), 'i');\n"
            f"{indent}    const __aitestOptTexts = await {recv}.locator('option').allTextContents();\n"
            f"{indent}    const __aitestHit = __aitestOptTexts.find((t) =>\n"
            f"{indent}      __aitestSelectRe.test((t || '').trim()),\n"
            f"{indent}    );\n"
            f"{indent}    if (!__aitestHit) {{\n"
            f"{indent}      throw new Error(`No <option> matching ${{__aitestSelectRe}}`);\n"
            f"{indent}    }}\n"
            f"{indent}    await {recv}.selectOption({{ label: __aitestHit.trim() }});\n"
            f"{indent}  }}\n"
            f"{indent}}}"
        )

    return _SELECT_OPTION_LABEL_CALL_RE.sub(_repl, text)


_HARDCODED_ERROR_TEXT_RE = re.compile(
    r"""(getByText|getByRole\([^)]*\)\.filter\(\s*\{\s*hasText\s*:\s*)(['"])([^'"]{20,})\2""",
)


def _relax_hardcoded_error_text(content: str) -> str:
    """
    Rewrite page.getByText('Đăng nhập thất bại. Sai email hoặc mật khẩu.')
    → page.getByText(/thất bại|fail/i)  (regex partial match).

    Only touches long (≥20 char) Vietnamese/English error-like strings.
    """
    if not content:
        return content

    error_keywords_re = re.compile(
        r"thất bại|lỗi|error|fail|invalid|không hợp lệ|không thành công|"
        r"thiếu|missing|unauthorized|expired|hết hạn",
        re.IGNORECASE,
    )

    def _repl(m: re.Match[str]) -> str:
        method = m.group(1)
        text = m.group(3)
        if not error_keywords_re.search(text):
            return m.group(0)
        # Extract 1-2 short keywords for regex
        words = error_keywords_re.findall(text)
        if not words:
            return m.group(0)
        unique = list(dict.fromkeys(w.lower() for w in words))[:2]
        pattern = "|".join(re.escape(w) for w in unique)
        return f"{method}/{pattern}/i"

    return _HARDCODED_ERROR_TEXT_RE.sub(_repl, content)


_EXACT_GETBYTEXT_RE = re.compile(
    r"""getByText\(\s*(['"])([^'"]+?)\1\s*,\s*\{\s*exact\s*:\s*true\s*\}\s*\)""",
    re.IGNORECASE,
)

# getByText('foo.*bar|baz') — AI stringified a regex; Playwright treats it as literal text.
_LITERAL_REGEX_GETBYTEXT_RE = re.compile(
    r"""getByText\(\s*(['"])([^'"]*(?:\.\*|\\[sdwSDW]|\\s|\||\[\^?)[^'"]*)\1"""
    r"""(?:\s*,\s*\{[^}]*\})?\s*\)""",
)

_NESTED_EXPECT_POM_RE = re.compile(
    r"""await\s+expect\s*\(\s*(?:await\s+)?(\w+)\."""
    r"""(expect\w+|assert\w+|get\w+|find\w+|locate\w+)\s*\(([^)]*)\)\s*\)\s*\."""
    r"""toBe(?:Visible|Hidden|Attached|Checked|Enabled|Disabled|Focused)\s*\([^;]*\)\s*;""",
    re.IGNORECASE,
)

# expect(pom.someProp).toBeVisible() — property may be undefined if never declared.
_NESTED_EXPECT_POM_PROP_RE = re.compile(
    r"""await\s+expect\s*\(\s*(\w+)\.(\w+)\s*\)\s*\."""
    r"""toBe(?:Visible|Hidden|Attached|Checked|Enabled|Disabled|Focused)\s*\(([^;]*)\)\s*;""",
    re.IGNORECASE,
)

_ASYNC_LOCATOR_GETTER_RE = re.compile(
    r"""async\s+(get\w+|find\w+|locate\w+)\s*(\([^)]*\))\s*:\s*Promise\s*<\s*Locator\s*>\s*\{""",
    re.IGNORECASE,
)

_LOCATOR_FIELD_DECL_RE = re.compile(
    r"""(?:readonly\s+)?(\w+)\s*:\s*Locator\b""",
    re.MULTILINE,
)


def _relax_exact_gettext(content: str) -> str:
    """
    getByText('Todo riêng của B', { exact: true }) → getByText(/Todo\\s+riêng\\s+của\\s+B/i)

    Brittle exact labels break across locales/spacing; keep short labels (≤2 chars) unchanged.
    """
    if not content:
        return content

    def _repl(m: re.Match[str]) -> str:
        text = m.group(2)
        if len(text.strip()) <= 2:
            return m.group(0)
        parts = [p for p in re.split(r"\s+", text.strip()) if p]
        if not parts:
            return m.group(0)
        pat = r"\s+".join(re.escape(p) for p in parts)
        return f"getByText(/{pat}/i)"

    return _EXACT_GETBYTEXT_RE.sub(_repl, content)


def _fix_literal_regex_gettext(content: str) -> str:
    """getByText('a.*b|c') → getByText(/a.*b|c/i) so meta-chars are not literal UI text."""
    if not content:
        return content

    def _repl(m: re.Match[str]) -> str:
        body = m.group(2)
        # Already a regex literal nearby — leave alone if odd quotes
        if not body or "/" in body[:1]:
            return m.group(0)
        return f"getByText(/{body}/i)"

    return _LITERAL_REGEX_GETBYTEXT_RE.sub(_repl, content)


def _fix_nested_expect_on_pom_asserts(content: str) -> str:
    """
    await expect(await pom.expectTodoVisible('x')).toBeVisible()
    → await pom.expectTodoVisible('x')

    await expect(await pom.getItem('x')).toBeVisible()
    → await expect(pom.getItem('x')).toBeVisible()  (sync Locator getter)

    Nested expect on void POM asserts yields: toBeVisible called with undefined.
    """
    if not content:
        return content

    def _repl_call(m: re.Match[str]) -> str:
        var, method, args = m.group(1), m.group(2), m.group(3)
        low = (method or "").lower()
        if low.startswith(("expect", "assert")):
            return f"await {var}.{method}({args});"
        # get*/find*/locate* — keep expect around sync Locator return
        return f"await expect({var}.{method}({args})).toBeVisible();"

    out = _NESTED_EXPECT_POM_RE.sub(_repl_call, content)

    # await expect(page.getByText(pom.expectX(...))).toBeVisible()
    # → await pom.expectX(...)   (void assert passed as text → "[object Promise]")
    def _repl_gettext_assert(m: re.Match[str]) -> str:
        var, method, args = m.group(1), m.group(2), m.group(3)
        return f"await {var}.{method}({args});"

    out = re.sub(
        r"""await\s+expect\s*\(\s*(?:this\.)?page\.getByText\s*\(\s*(?:await\s+)?"""
        r"""(\w+)\.(expect\w+|assert\w+)\s*\(([^)]*)\)\s*\)\s*\)\s*\."""
        r"""toBe(?:Visible|Hidden|Attached)\s*\([^;]*\)\s*;""",
        _repl_gettext_assert,
        out,
        flags=re.IGNORECASE,
    )
    return out


_ASYNC_PATH_HELPER_RE = re.compile(
    r"""async\s+(?P<name>\w*(?:fixture|Fixture|FilePath|filePath|FileName|fileName|UploadPath|uploadPath|\w*Path)\w*)"""
    r"""\s*\((?P<args>[^)]*)\)\s*:\s*Promise\s*<\s*string\s*>\s*\{""",
    re.IGNORECASE,
)

_ASYNC_PATH_HELPER_ENSURE_RE = re.compile(
    r"""async\s+(?P<name>(?:ensure|build|make|create|get)\w*(?:File|Doc|Upload|Fixture)\w*)"""
    r"""\s*\((?P<args>[^)]*)\)\s*:\s*Promise\s*<\s*string\s*>\s*\{""",
    re.IGNORECASE,
)


def _sync_async_path_helpers(content: str) -> str:
    """async fooPath(): Promise<string> → fooPath(): string (avoids path/getByText Promise)."""
    if not content:
        return content

    def _repl(m: re.Match[str]) -> str:
        return f"{m.group('name')}({m.group('args')}): string {{"

    out = _ASYNC_PATH_HELPER_RE.sub(_repl, content)
    out = _ASYNC_PATH_HELPER_ENSURE_RE.sub(_repl, out)
    # Freestanding export async function → sync
    out = re.sub(
        r"""export\s+async\s+function\s+(\w*(?:fixture|Fixture|File|Path|Upload)\w*)\s*\(([^)]*)\)\s*:\s*Promise\s*<\s*string\s*>""",
        r"export function \1(\2): string",
        out,
        flags=re.IGNORECASE,
    )
    return out


def _fix_promise_coercion_crashes(content: str) -> str:
    """
    Fix Spec patterns that pass a Promise into Playwright APIs:
    - setInputFiles(sel, helper()) → setInputFiles(sel, await helper())
    - getByText(helper()) → getByText(await helper()) when helper looks async-named
    - goto(pom.getUrl()) → goto(await pom.getUrl()) for async getters still present
    After _sync_async_path_helpers, await on sync fn is harmless in TS? Actually await on
    non-Promise wraps value — fine at runtime. Prefer adding await for call sites that
    still reference async helpers from AI output.
    """
    if not content:
        return content
    out = content

    # setInputFiles(..., expr) without await on call.
    # First arg must be [^,)]+ — never cross the closing ')' of a 1-arg call
    # (old [^,]+ matched past ');' into `[key, val]` and injected `await val`).
    def _await_files(m: re.Match[str]) -> str:
        prefix, arg = m.group(1), m.group(2).strip()
        if arg.startswith("await ") or arg.startswith("'") or arg.startswith('"') or arg.startswith("`"):
            return m.group(0)
        if re.match(r"^[\w.]+$", arg):  # bare var — leave
            return m.group(0)
        # function / method call
        if re.search(r"\w+\s*\(", arg) and not arg.lstrip().startswith("await"):
            return f"{prefix}await {arg})"
        return m.group(0)

    out = re.sub(
        r"""(setInputFiles\s*\(\s*[^,)]+,\s*)([^)]+)\)""",
        _await_files,
        out,
    )
    # Single-arg: setInputFiles(helper()) → setInputFiles(await helper())
    def _await_files_1(m: re.Match[str]) -> str:
        prefix, arg = m.group(1), m.group(2).strip()
        if arg.startswith("await ") or arg.startswith("'") or arg.startswith('"') or arg.startswith("`"):
            return m.group(0)
        if re.match(r"^[\w.]+$", arg):
            return m.group(0)
        if re.search(r"\w+\s*\(", arg):
            return f"{prefix}await {arg})"
        return m.group(0)

    out = re.sub(
        r"""(setInputFiles\s*\(\s*)((?:await\s+)?\w+(?:\.\w+)*\s*\([^)]*\))\s*\)""",
        _await_files_1,
        out,
    )

    # getByText(pom.foo()) — single call arg only (skip getByText(x, { exact }))
    # Path/fixture helpers must NOT become visible-text asserts (generated.bin).
    def _gettext_call(m: re.Match[str]) -> str:
        inner = m.group(1).strip()
        low = inner.lower()
        if re.search(
            r"(?:fixture|filepath|filename|uploadpath|docpath|ensure\w*file|build\w*file|make\w*file)\s*\(",
            low,
        ):
            return (
                "/* guard: skipped getByText(pathHelper) — use setInputFiles instead */ "
                "await Promise.resolve()"
            )
        if inner.startswith("await "):
            return m.group(0)
        return f"getByText(await {inner})"

    out = re.sub(
        r"""getByText\s*\(\s*((?:await\s+)?\w+(?:\.\w+)*\s*\([^)]*\))\s*\)""",
        _gettext_call,
        out,
    )

    # goto(pom.getUrl()) — single call arg only
    out = re.sub(
        r"""goto\s*\(\s*((?:await\s+)?\w+(?:\.\w+)*\s*\([^)]*\))\s*\)""",
        lambda m: (
            m.group(0)
            if m.group(1).strip().startswith("await ")
            else f"goto(await {m.group(1).strip()})"
        ),
        out,
    )
    return out


def _extract_locator_field_names(page_content: str) -> set[str]:
    return {m.group(1) for m in _LOCATOR_FIELD_DECL_RE.finditer(page_content or "")}


def _ensure_locator_fields_for_spec_expects(
    spec_content: str, page_content: str
) -> tuple[str, str]:
    """
    If Spec uses expect(pom.foo).toBeVisible and foo is not a Locator field,
    declare `readonly foo: Locator` and init in constructor to page.locator('body').
    """
    if not spec_content or not page_content:
        return spec_content, page_content
    primary, _ = _exported_page_symbols(page_content)
    if not primary:
        return spec_content, page_content
    bindings = {v: c for v, c in _find_page_bindings(spec_content) if c == primary}
    if not bindings:
        return spec_content, page_content
    existing_fields = _extract_locator_field_names(page_content)
    existing_methods = {_norm_key(m) for m in _extract_class_methods(page_content, primary)}
    needed: set[str] = set()
    for var in bindings:
        for m in _NESTED_EXPECT_POM_PROP_RE.finditer(spec_content):
            if m.group(1) != var:
                continue
            prop = m.group(2)
            if prop in ("page", "locator", "context"):
                continue
            if prop in existing_fields:
                continue
            # Method call form handled elsewhere; bare prop only
            if _norm_key(prop) in existing_methods:
                continue
            needed.add(prop)
    # this.foo.or(...) in page — undeclared Locator → TypeError reading 'or'
    for m in re.finditer(r"this\.(\w+)\.or\s*\(", page_content or ""):
        prop = m.group(1)
        if prop in ("page", "locator", "context"):
            continue
        if prop not in existing_fields and _norm_key(prop) not in existing_methods:
            needed.add(prop)
    if not needed:
        return spec_content, page_content

    # Insert field decls after class open / with other fields
    class_match = re.search(
        rf"export\s+class\s+{re.escape(primary)}\b[^{{]*\{{",
        page_content,
        re.DOTALL,
    )
    if not class_match:
        return spec_content, page_content
    insert_at = class_match.end()
    decls = "".join(f"\n  readonly {name}: Locator;" for name in sorted(needed))
    page_content = page_content[:insert_at] + decls + page_content[insert_at:]

    # Init AFTER this.page = page — otherwise this.page is undefined → .locator crash.
    page_assign = re.search(
        r"this\.page\s*=\s*page\s*;",
        page_content,
    )
    init = "".join(
        f"\n    this.{name} = {_locator_init_expr(name)};"
        for name in sorted(needed)
    )
    if page_assign:
        at = page_assign.end()
        page_content = page_content[:at] + init + page_content[at:]
    else:
        ctor = re.search(
            r"constructor\s*\([^)]*\)\s*(?::\s*[^{]+)?\s*\{",
            page_content,
        )
        if ctor:
            # No this.page= yet — assign page first then fields
            boot = "\n    this.page = page;" + init
            page_content = page_content[: ctor.end()] + boot + page_content[ctor.end() :]
    return spec_content, page_content


def _sync_async_locator_getters(content: str) -> str:
    """async getItem(): Promise<Locator> → getItem(): Locator (sync getter)."""
    if not content:
        return content
    return _ASYNC_LOCATOR_GETTER_RE.sub(r"\1\2: Locator {", content)


_VALIDATION_HINT_RE = re.compile(
    r"validation|bỏ\s*trống|để\s*trống|empty|boundary|negative|"
    r"thiếu|missing|không\s*nhập|không\s*điền|blank|required",
    re.IGNORECASE,
)
_DISABLED_EXPECTATION_HINT_RE = re.compile(
    r"bỏ\s*trống|để\s*trống|empty|blank|required|thiếu|missing|không\s*nhập|không\s*điền",
    re.IGNORECASE,
)


def _rewrite_validation_spec_click_to_disabled(content: str) -> str:
    """
    Validation / negative specs: if the test title hints at form-validation
    (empty field, missing data, invalid input…) and the spec calls
    page-object clickSubmit() or submitButton.click(), rewrite to
    expect(submitButton).toBeDisabled() — because client-side validation
    disables the button before any click can succeed.
    """
    if not content:
        return content
    if not _VALIDATION_HINT_RE.search(content):
        return content
    # Only force disabled-button pattern for empty/missing-required input cases.
    # Invalid-format cases (e.g. malformed email) may still allow submit.
    if not _DISABLED_EXPECTATION_HINT_RE.search(content):
        return content

    # Pattern: await <obj>.clickSubmit(); → await <obj>.expectSubmitDisabled();
    out = re.sub(
        r"await\s+(\w+)\.clickSubmit\(\s*\)\s*;",
        r"await \1.expectSubmitDisabled();",
        content,
    )
    # Pattern: await <obj>.submitButton.click(...); → await expect(<obj>.submitButton).toBeDisabled();
    out = re.sub(
        r"await\s+(\w+)\.submitButton\.click\([^)]*\)\s*;",
        r"await expect(\1.submitButton).toBeDisabled();",
        out,
    )
    # Pattern: await page.locator('form').getByRole('button'...).click(...);
    # in a validation context → expect(...).toBeDisabled()
    out = re.sub(
        r"await\s+(page\.locator\(['\"]form['\"]\)\.getByRole\(['\"]button['\"][^)]*\)(?:\.first\(\))?)"
        r"\.click\([^)]*\)\s*;",
        r"await expect(\1).toBeDisabled();",
        out,
    )

    # Strip toHaveAttribute('required') — AI assumes HTML attrs that many apps don't use.
    # Disabled-button assertion is sufficient for validation.
    out = re.sub(
        r"\s*await\s+expect\([^)]+\)\.toHaveAttribute\(\s*['\"]required['\"]\s*\)\s*;\s*\n?",
        "\n",
        out,
    )

    # If we rewired clickSubmit → expectSubmitDisabled, ensure the page object has that method.
    # Also remove steps after the disabled assertion that expect network responses
    # (a disabled button can't trigger HTTP).
    if "expectSubmitDisabled" in out and "expectSubmitDisabled" not in content:
        # Remove subsequent waitForResponse / waitForRequest steps that assume a submit happened
        out = re.sub(
            r"await\s+test\.step\([^)]*(?:Quan sát|Observe|response|HTTP|status)[^)]*,\s*async\s*\(\)\s*=>\s*\{"
            r"[^}]*waitForResponse[^}]*\}\s*\)\s*;",
            "",
            out,
            flags=re.IGNORECASE | re.DOTALL,
        )

    # If expect() is used but not imported, add it
    if "await expect(" in out and "expect" not in content.split("from")[0]:
        if "import { test, expect }" not in out and "import { expect" not in out:
            out = out.replace(
                "import { test }",
                "import { test, expect }",
                1,
            )

    return out


def looks_like_storage_state_path(path: str) -> bool:
    p = (path or "").replace("\\", "/").lower()
    return p.endswith("storagestate.json") or "/fixtures/storagestate.json" in p


def is_valid_storage_state_json(content: str) -> bool:
    """Playwright rejects empty {} — need cookies and/or origins arrays."""
    raw = (content or "").strip()
    if not raw or raw == "{}":
        return False
    try:
        data = json.loads(raw)
    except Exception:
        return False
    if not isinstance(data, dict):
        return False
    cookies = data.get("cookies")
    origins = data.get("origins")
    if isinstance(cookies, list) and len(cookies) > 0:
        return True
    if isinstance(origins, list) and len(origins) > 0:
        return True
    return False


def normalize_config_storage_state(
    content: str,
    *,
    has_valid_state: bool,
    prefer_storage: bool = False,
) -> str:
    """
    Playwright resolves storageState relative to the config file directory.
    When prefer_storage (authMode=storage), keep ./fixtures/storageState.json.
    Otherwise strip storageState so UI-helper / headed-visible-login does not skip the form.
    """
    text = content or ""
    if not prefer_storage:
        # Remove storageState line(s) — including one-line `use: { storageState: '...' }`
        text = re.sub(
            r"^[ \t]*storageState\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\n",
            "",
            text,
            flags=re.MULTILINE | re.IGNORECASE,
        )
        text = re.sub(
            r"""storageState\s*:\s*['\"][^'\"]*['\"]\s*,?""",
            "",
            text,
            flags=re.IGNORECASE,
        )
        return text

    del has_valid_state  # prefer_storage path always uses canonical relative fixture
    rel = "./fixtures/storageState.json"
    if re.search(r"storageState\s*:", text, re.IGNORECASE):
        text = re.sub(
            r"(storageState\s*:\s*)(['\"])[^'\"]*\2",
            rf"\1'{rel}'",
            text,
            flags=re.IGNORECASE,
        )
    else:
        # Insert into use: { ... }
        text = re.sub(
            r"(use\s*:\s*\{)",
            rf"\1\n    storageState: '{rel}',",
            text,
            count=1,
        )
    return text


def strip_ensure_authenticated(spec_content: str) -> str:
    """Remove ensureAuthenticated import + calls (storage / login-TC modes)."""
    text = spec_content or ""
    text = re.sub(
        r"^import\s+\{\s*ensureAuthenticated\s*\}\s+from\s+['\"][^'\"]*auth\.helper['\"]\s*;?\s*\n?",
        "",
        text,
        flags=re.MULTILINE,
    )
    # Wrapped visible login step
    text = re.sub(
        r"^[ \t]*await\s+test\.step\s*\(\s*['\"][^'\"]*(?:[Dd]ăng\s*nhập|[Ll]ogin|[Aa]uthenticat)[^'\"]*['\"]\s*,\s*"
        r"async\s*\(\s*\)\s*=>\s*\{[^{}]*ensureAuthenticated\s*\(\s*page\s*\)\s*;?\s*\}\s*\)\s*;\s*\n?",
        "",
        text,
        flags=re.MULTILINE,
    )
    text = re.sub(
        r"^[ \t]*await\s+ensureAuthenticated\s*\(\s*page\s*\)\s*;\s*\n?",
        "",
        text,
        flags=re.MULTILINE,
    )
    return text


def rewrite_networkidle_goto(content: str) -> str:
    """goto must use domcontentloaded — never networkidle (SPA hang risk)."""
    text = content or ""
    return re.sub(
        r"""(page\.goto\s*\(\s*[^,)]+\s*,\s*\{[^}]*?waitUntil\s*:\s*['"])networkidle(['"])""",
        r"\1domcontentloaded\2",
        text,
        flags=re.IGNORECASE,
    )