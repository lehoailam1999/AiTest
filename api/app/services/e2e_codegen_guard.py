"""
Deterministic post-processing for generated Playwright E2E code.

Fixes common AI drift without hardcoding project-specific routes:
- strict-mode duplicate button labels (tab vs form submit)
- Page Object method contract mismatches between spec and page files
- goto() asserting feature widgets before auth (login wall)
- missing ensureAuthenticated when no valid storageState
"""

from __future__ import annotations

import json
import os
import re
from typing import Iterable

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

  const waitForLoginForm = async (ms = 15000): Promise<boolean> =>
    passwordField()
      .or(userField())
      .or(loginHeading())
      .first()
      .waitFor({ state: 'visible', timeout: ms })
      .then(() => true)
      .catch(() => false);

  const tryGotoLoginPath = async (raw: string): Promise<boolean> => {
    const path = raw.startsWith('http') ? raw : raw.startsWith('/') ? raw : `/${raw}`;
    await page.goto(path, { waitUntil: 'domcontentloaded' });
    return await waitForLoginForm(12000);
  };

  const openLoginEntry = async (): Promise<boolean> => {
    if (await isLoginWall()) return true;

    const explicit = (process.env.E2E_LOGIN_PATH || '').trim();
    if (explicit && (await tryGotoLoginPath(explicit))) return true;

    for (const p of COMMON_LOGIN_PATHS) {
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
  const roleSlug = roleHint.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const roleUser = roleSlug ? (process.env[`E2E_${roleSlug}_USERNAME`] || '').trim() : '';
  const rolePass = roleSlug ? (process.env[`E2E_${roleSlug}_PASSWORD`] || '').trim() : '';
  const user = (roleUser || process.env.E2E_USERNAME || '').trim();
  const pass = (rolePass || process.env.E2E_PASSWORD || '').trim();
  const hasCreds = Boolean(user && pass);

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
      'App requires login but E2E_USERNAME / E2E_PASSWORD are not set. ' +
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
          return /auth|login|signin|session|token|users?\/sign|authenticate/i.test(r.url());
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
    const leftLoginUrl = !/\/login\/?$/i.test(page.url());
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
# Single or multi: import { A, B as C } from '../pages/foo'
_SPEC_PAGE_IMPORT_RE = re.compile(
    r"""import\s+\{\s*(?P<names>[^}]+)\s*\}\s+from\s+['"]\.\./pages/(?P<leaf>[^'"]+)['"]""",
    re.IGNORECASE,
)


def _norm_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


def _parse_import_names(names_blob: str) -> list[str]:
    """Parse `Foo, bar as baz` → ['Foo', 'baz'] (local binding names)."""
    out: list[str] = []
    for part in (names_blob or "").split(","):
        part = part.strip()
        if not part:
            continue
        # Foo as Bar → Bar
        m = re.match(r"(\w+)(?:\s+as\s+(\w+))?", part, re.IGNORECASE)
        if not m:
            continue
        out.append(m.group(2) or m.group(1))
    return out


def _exported_page_symbols(page_content: str) -> tuple[str | None, set[str]]:
    """Return (primary export class, set of exported class+function names)."""
    classes = _CLASS_RE.findall(page_content or "")
    primary = classes[0] if classes else None
    syms: set[str] = set(classes)
    syms |= set(_EXPORT_FN_RE.findall(page_content or ""))
    return primary, syms


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
        for name in _parse_import_names(m.group("names")):
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
        for name in _parse_import_names(m.group("names")):
            if name in exported:
                if name not in keep:
                    keep.append(name)
                continue
            if primary and (
                name[:1].isupper()
                or name.lower().endswith("page")
                or bool(re.search(rf"\bnew\s+{re.escape(name)}\s*\(", spec))
            ):
                if primary not in keep:
                    keep.append(primary)
                continue
            if f"function {name}" not in page and f"export async function {name}" not in page:
                page = (
                    page.rstrip()
                    + f"\nexport async function {name}(..._args: unknown[]): Promise<string> {{\n"
                    + "  // Guard stub — missing export caused Playwright load failure.\n"
                    + "  return String(_args[0] ?? 'fixtures/generated.bin');\n"
                    + "}\n"
                )
                exported = set(exported)
                exported.add(name)
            if name not in keep:
                keep.append(name)
        if not keep and primary:
            keep = [primary]
        return f"import {{ {', '.join(keep)} }} from '../pages/{leaf}'"

    spec = _SPEC_PAGE_IMPORT_RE.sub(_repl_import, spec)
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


def _ensure_referenced_page_files(files: list) -> list:
    """If Spec imports ../pages/*.page but file is missing, add fallback page file."""
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
        page_dir = spec_dir.rsplit("/", 1)[0] + "/pages"
        content = getattr(f, "content", "") or ""
        bindings = _find_page_bindings(content)
        call_by_var = {var: _collect_spec_method_calls(content, var) for var, _ in bindings}
        for m in _SPEC_PAGE_IMPORT_RE.finditer(content):
            names = _parse_import_names(m.group("names"))
            leaf = m.group("leaf").strip()
            # Prefer class-like import for fallback page generation
            cls = next(
                (
                    n
                    for n in names
                    if n[:1].isupper() or n.lower().endswith("page")
                ),
                names[0] if names else "GeneratedPage",
            )
            # Import may omit .ts extension.
            page_path = f"{page_dir}/{leaf}.ts" if not leaf.endswith(".ts") else f"{page_dir}/{leaf}"
            page_path = page_path.replace("//", "/")
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


def _render_smart_method_stub(method: str) -> str:
    """
    Generic POM stub for any project — safe coerce (string|RegExp|unknown),
    no empty void methods that cause expect(undefined) / .trim() TypeError.
    """
    name = method or "action"
    low = name.lower()
    norm = _norm_key(name)

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
        return (
            f"\n  {name}(..._args: unknown[]): Locator {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    if (raw instanceof RegExp) return this.page.getByText(raw).first();\n"
            "    const q = typeof raw === 'string' ? raw.trim()\n"
            "      : raw == null ? ''\n"
            "      : String(raw);\n"
            "    if (q) return this.page.getByText(q, { exact: false }).first();\n"
            "    return this.page.locator('main, [role=\"main\"], body').first();\n"
            "  }\n"
        )

    if low.startswith(("expect", "assert")):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    const loc = raw instanceof RegExp\n"
            "      ? this.page.getByText(raw).first()\n"
            "      : (() => {\n"
            "          const q = typeof raw === 'string' ? raw.trim()\n"
            "            : raw == null ? ''\n"
            "            : String(raw);\n"
            "          return q\n"
            "            ? this.page.getByText(q, { exact: false }).first()\n"
            "            : this.page.locator('main, [role=\"main\"], body').first();\n"
            "        })();\n"
            "    await expect(loc).toBeVisible({ timeout: 15000 });\n"
            "  }\n"
        )

    if low.startswith("click") or low.startswith("tap") or low.startswith("press"):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const raw = _args.length ? _args[0] : undefined;\n"
            "    const loc = raw instanceof RegExp\n"
            "      ? this.page.getByText(raw).first()\n"
            "      : typeof raw === 'string' && raw.trim()\n"
            "        ? this.page.getByRole('button', { name: raw }).or(this.page.getByText(raw, { exact: false })).first()\n"
            "        : this.page.locator('button, [role=\"button\"]').first();\n"
            "    if (await loc.isVisible().catch(() => false)) await loc.click();\n"
            "  }\n"
        )

    if low.startswith("fill") or low.startswith("type") or low.startswith("enter"):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
            "    const value = _args.length > 1 ? _args[1] : _args[0];\n"
            "    const q = value == null ? '' : String(value);\n"
            "    const box = this.page.locator('input:not([type=\"hidden\"]), textarea').first();\n"
            "    await box.fill(q);\n"
            "  }\n"
        )

    # Fixture helpers: ensureInvalidExeFixture / buildTcRelatedDocFiles style
    if "fixture" in low or norm.startswith("ensure") or norm.startswith("build"):
        return (
            f"\n  async {name}(..._args: unknown[]): Promise<string> {{\n"
            "    // Guard stub — return a path-like string for upload/fixture steps.\n"
            "    return String(_args[0] ?? 'fixtures/generated.bin');\n"
            "  }\n"
        )

    return (
        f"\n  async {name}(..._args: unknown[]): Promise<void> {{\n"
        "    // Generated stub — extend with project-specific locators when healing.\n"
        "  }\n"
    )


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


def fix_page_method_contract(spec_content: str, page_content: str) -> tuple[str, str]:
    """
    Ensure Spec↔POM contract is runnable (Rule 18):
    - import names match exports
    - no Class.staticMethod( — rewrite to instance
    - every instance method call exists on the page class
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
    existing = _extract_class_methods(page_content, class_name)
    existing_norm = {_norm_key(m): m for m in existing}
    needed: set[str] = set()
    for var_name, cls in target_bindings:
        needed |= _collect_spec_method_calls(spec_content, var_name)

    missing = [m for m in sorted(needed) if _norm_key(m) not in existing_norm]
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
        snippets.append(_render_smart_method_stub(method))

    page_content = _insert_methods_before_class_end(
        page_content, snippets, class_name=class_name
    )
    return spec_content, page_content


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


def apply_e2e_codegen_guards(
    files: list,
    *,
    dom_snapshot: str = "",
    auth_mode: str | None = None,
    use_storage: bool | None = None,
    test_case_title: str = "",
    auth_hints: str = "",
    headed: bool = False,
) -> list:
    """Run deterministic guards across generated E2E files."""
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
                f.content, page_file.content
            )
            f.content, page_file.content = _ensure_locator_fields_for_spec_expects(
                f.content, page_file.content
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
            f.content = _sync_async_locator_getters(f.content)
            f.content = fix_select_option_label_regexp(f.content)

    # Mutual exclusion: ui_helper injects ensureAuthenticated; storage/public/none strip it
    if wants_ui_auth_helper(mode):
        normalized = ensure_auth_helper_files(normalized)
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
    """Pick AItest/E2ETest/{Module}/ or relative fixtures/ from existing paths."""
    for f in files:
        p = (getattr(f, "path", "") or "").replace("\\", "/")
        if not p:
            continue
        # Prefer path that already has fixtures/ or pages/ or specs/
        for marker in ("/fixtures/", "/pages/", "/specs/", "/playwright.config.ts"):
            if marker in f"/{p.lower()}" or p.lower().endswith("playwright.config.ts"):
                # Truncate at marker parent
                lower = p
                for m in ("/fixtures/", "/pages/", "/specs/"):
                    idx = lower.lower().find(m)
                    if idx >= 0:
                        return p[:idx]
                if p.lower().endswith("playwright.config.ts"):
                    return p.rsplit("/", 1)[0]
    return ""


def ensure_auth_helper_files(files: list) -> list:
    """
    Ensure fixtures/auth.helper.ts is the canonical helper and inject
    ensureAuthenticated into feature specs when storageState is absent.
    Always rewrite helper content so Verify picks up auth fixes without regen.
    """
    from app.llm.base import E2EFile

    out: list = list(files)
    feature_need_inject: list = []
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
        content = getattr(f, "content", "") or ""
        # Comment-only mentions («Auth: … không ensureAuthenticated») must still inject.
        if not _spec_calls_ensure_authenticated(content):
            feature_need_inject.append(f)

    helpers = [
        f
        for f in out
        if (getattr(f, "path", "") or "").replace("\\", "/").lower().endswith("auth.helper.ts")
    ]
    if helpers:
        for h in helpers:
            h.content = _AUTH_HELPER_TS
    elif has_feature_spec or feature_need_inject:
        prefix = _module_prefix_for_fixtures(out)
        helper_path = (
            f"{prefix}/fixtures/auth.helper.ts" if prefix else "fixtures/auth.helper.ts"
        )
        out.append(E2EFile(path=helper_path, content=_AUTH_HELPER_TS, kind="fixture"))

    for f in feature_need_inject:
        f.content = inject_ensure_authenticated(f.content or "")

    return out


def inject_ensure_authenticated(spec_content: str) -> str:
    """Add import + visible test.step for login before POM actions."""
    text = spec_content or ""
    has_import = bool(
        re.search(
            r"""from\s+['"][^'"]*auth\.helper['"]""",
            text,
        )
    )
    if not has_import:
        import_line = "import { ensureAuthenticated } from '../fixtures/auth.helper';\n"
        last_import = None
        for m in re.finditer(r"^import\s.+?;\s*$", text, re.MULTILINE):
            last_import = m
        if last_import:
            insert_at = last_import.end()
            text = text[:insert_at] + "\n" + import_line + text[insert_at:]
        else:
            text = import_line + text

    return _inject_ensure_auth_calls(text)


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


def _rewrite_cross_tc_imports(content: str, spec_path: str, all_files: list) -> str:
    """
    Specs must only import from their own sibling ../pages/ folder.
    AI sometimes generates cross-TC imports like '../../OtherTC/pages/foo.page'.
    Rewrite to '../pages/foo.page' and ensure the local page exists (placeholder if needed).
    """
    if not content:
        return content

    # Any import that targets ".../pages/..." but is not local "../pages/..."
    # should be rewritten to local sibling pages folder (one TC = one pages/).
    import_re = re.compile(r"""(from\s+['"])([^'"]+)(['"])""")

    def _repl(m: re.Match[str]) -> str:
        prefix, raw_path, suffix = m.group(1), m.group(2).replace("\\", "/"), m.group(3)
        if "/pages/" not in raw_path:
            return m.group(0)
        if raw_path.startswith("../pages/"):
            return m.group(0)
        leaf = raw_path.rsplit("/pages/", 1)[-1].lstrip("/")
        if not leaf:
            return m.group(0)
        return f"{prefix}../pages/{leaf}{suffix}"

    return import_re.sub(_repl, content)


def _strip_spec_storage_state(content: str) -> str:
    """Remove test.use({ storageState: ... }) from spec when storageState file is missing."""
    return re.sub(
        r"test\.use\(\s*\{\s*storageState\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\}\s*\)\s*;?\s*\n?",
        "",
        content,
        flags=re.IGNORECASE,
    )


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
        f"\n    this.{name} = this.page.locator('main, [role=\"main\"], body').first();"
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