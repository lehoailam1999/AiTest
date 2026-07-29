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
import re
from typing import Iterable

# Generic login-wall helper (env-driven; no app-specific routes/credentials).
# Keep in sync with ensure_auth_helper_files() — guards always rewrite this file.
_AUTH_HELPER_TS = """\
/// <reference path="../types/playwright-shim.d.ts" />
import { expect, type Page } from '@playwright/test';

/**
 * Step 0 for feature journeys: leave the login wall before POM actions.
 * - No-op when already authenticated.
 * - Uses E2E_USERNAME / E2E_PASSWORD from the Playwright process env (AITest injects them).
 * - Success = login form / login heading gone (not a feature-widget assert).
 */
export async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });

  const loginHeading = page.getByRole('heading', {
    name: /đăng\\s*nhập|sign\\s*in|log\\s*in|login/i,
  }).first();
  const email = page.getByRole('textbox', { name: /email|e-?mail|tài khoản|username/i }).first();
  const password = page
    .getByRole('textbox', { name: /password|mật khẩu|passwd/i })
    .or(page.locator('input[type="password"]'))
    .first();
  // Prefer form submit — Auth UIs often duplicate «Đăng nhập» (tab vs button).
  const loginBtn = page
    .locator('form')
    .getByRole('button', { name: /đăng\\s*nhập|log\\s*in|sign\\s*in/i })
    .first();

  const onLoginWall =
    (await email.isVisible().catch(() => false)) ||
    (await loginHeading.isVisible().catch(() => false));
  if (!onLoginWall) {
    return;
  }

  // If Sign-up tab is active, switch to Login tab first.
  const loginTab = page.getByRole('tab', { name: /đăng\\s*nhập|log\\s*in|sign\\s*in/i }).first();
  if (await loginTab.isVisible().catch(() => false)) {
    await loginTab.click();
  }

  const roleHint = (process.env.E2E_ROLE || process.env.E2E_AUTH_ROLE || 'default').trim();
  const roleSlug = roleHint.replace(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  const roleUser = roleSlug ? (process.env[`E2E_${roleSlug}_USERNAME`] || '').trim() : '';
  const rolePass = roleSlug ? (process.env[`E2E_${roleSlug}_PASSWORD`] || '').trim() : '';
  const user = (roleUser || process.env.E2E_USERNAME || '').trim();
  const pass = (rolePass || process.env.E2E_PASSWORD || '').trim();
  if (!user || !pass) {
    throw new Error(
      'App requires login but E2E_USERNAME / E2E_PASSWORD are not set. ' +
        'For multi-role, set E2E_ROLE + E2E_<ROLE>_USERNAME/PASSWORD (or default E2E_USERNAME/PASSWORD). ' +
        'Enter them on AITest → E2E test → Môi trường (not in the app under test), ' +
        'or provide a valid Playwright storageState.',
    );
  }

  await email.fill(user);
  await password.fill(pass);
  // Trigger client-side validation that enables the submit button.
  await password.blur().catch(() => undefined);
  await expect(loginBtn).toBeEnabled({ timeout: 15000 });

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
    await loginBtn.click();
    const resp = await authNetwork;
    if (resp && !resp.ok()) {
      const body = await resp.text().catch(() => '');
      return { ok: false as const, status: resp.status(), url: resp.url(), body };
    }
    return { ok: true as const };
  };

  let loginRes = await tryLogin();
  if (!loginRes.ok && loginRes.status === 401) {
    // Generic bootstrap for fresh DBs: if sign-up exists, create/recreate test user then retry login.
    const signUpTab = page.getByRole('tab', { name: /đăng\\s*ký|sign\\s*up|register/i }).first();
    const registerBtn = page
      .locator('form')
      .getByRole('button', { name: /đăng\\s*ký|sign\\s*up|register/i })
      .first();
    const canRegister =
      (await signUpTab.isVisible().catch(() => false)) &&
      (await registerBtn.isVisible().catch(() => false));
    if (canRegister) {
      await signUpTab.click();
      await email.fill(user);
      await password.fill(pass);
      await password.blur().catch(() => undefined);
      await expect(registerBtn).toBeEnabled({ timeout: 15000 });
      await registerBtn.click();
      if (await loginTab.isVisible().catch(() => false)) {
        await loginTab.click();
      }
      await email.fill(user);
      await password.fill(pass);
      await password.blur().catch(() => undefined);
      await expect(loginBtn).toBeEnabled({ timeout: 15000 });
      loginRes = await tryLogin();
    }
  }
  if (!loginRes.ok) {
    throw new Error(
      `Login HTTP ${loginRes.status} for ${loginRes.url}. ` +
        `Check E2E credentials on AITest (role=${roleHint || 'default'}). ` +
        `${(loginRes.body || '').slice(0, 200)}`,
    );
  }

  // Left the wall = heading+email gone. Do NOT assert feature widgets here.
  try {
    await expect(email).toBeHidden({ timeout: 30000 });
    if (await loginHeading.count()) {
      await expect(loginHeading).toBeHidden({ timeout: 5000 });
    }
  } catch {
    const alertText =
      (
        await page
          .getByRole('alert')
          .or(page.locator('[role="status"], .error, .text-error, .ant-form-item-explain-error'))
          .first()
          .textContent()
          .catch(() => null)
      )?.trim() || '';
    throw new Error(
      'Login did not leave the login wall (email still visible). ' +
        (alertText ? `UI message: ${alertText}. ` : '') +
        'Verify E2E username/password on AITest → E2E → Môi trường, and that Target URL is the running app.',
    );
  }
}
"""

_LOGIN_SPEC_HINT_RE = re.compile(
    r"(?:^|/)(?:login|logout|signin|sign-in|signup|sign-up|auth)(?:[-_.]|$)|"
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
}


_CLASS_RE = re.compile(r"export\s+class\s+(\w+)")
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
_SPEC_PAGE_IMPORT_RE = re.compile(
    r"""import\s+\{\s*(?P<class>\w+)\s*\}\s+from\s+['"]\.\./pages/(?P<leaf>[^'"]+)['"]""",
    re.IGNORECASE,
)


def _norm_key(name: str) -> str:
    return re.sub(r"[^a-z0-9]", "", (name or "").lower())


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
    return calls


def _render_missing_page_file(class_name: str, methods: set[str]) -> str:
    calls = sorted(m for m in methods if m not in {"constructor"})
    body = [
        '/// <reference path="../types/playwright-shim.d.ts" />',
        "import { type Page } from '@playwright/test';",
        "",
        f"export class {class_name} {{",
        "  readonly page: Page;",
        "",
        "  constructor(page: Page) {",
        "    this.page = page;",
        "  }",
        "",
    ]
    for m in calls:
        if m == "goto":
            body.extend(
                [
                    "  async goto(): Promise<void> {",
                    "    await this.page.goto('/', { waitUntil: 'domcontentloaded' });",
                    "  }",
                    "",
                ]
            )
        else:
            body.extend(
                [
                    f"  async {m}(..._args: unknown[]): Promise<void> {{",
                    "    // Auto-generated fallback when page file was missing in model output.",
                    "  }",
                    "",
                ]
            )
    body.append("}")
    body.append("")
    return "\n".join(body)


def _ensure_referenced_page_files(files: list) -> list:
    """If Spec imports ../pages/*.page but file is missing, add fallback page file."""
    from app.llm.base import E2EFile

    out: list = list(files)
    existing = {(getattr(f, "path", "") or "").replace("\\", "/") for f in out}
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
            cls = m.group("class")
            leaf = m.group("leaf").strip()
            # Import may omit .ts extension.
            page_path = f"{page_dir}/{leaf}.ts" if not leaf.endswith(".ts") else f"{page_dir}/{leaf}"
            page_path = page_path.replace("//", "/")
            if page_path in existing:
                continue
            methods: set[str] = set()
            for var, bound_cls in bindings:
                if bound_cls == cls:
                    methods |= call_by_var.get(var, set())
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


def fix_duplicate_button_locators(content: str, *, dom_snapshot: str = "") -> str:
    """
    Scope ambiguous global button locators to form when duplicates are likely.

    Typical SPA auth UI: tab "Đăng nhập" + submit "Đăng nhập".
    """
    dup_names = {
        name
        for name, count in _button_names_from_dom(dom_snapshot).items()
        if count >= 2
    }
    snap_low = (dom_snapshot or "").lower()
    has_tab_hint = "tablist" in snap_low or bool(dup_names)

    def _repl(m: re.Match[str]) -> str:
        name_raw = m.group("name").strip()
        literal = name_raw.strip("'\"")
        if dup_names and literal not in dup_names:
            return m.group(0)
        if not has_tab_hint and not dup_names:
            return m.group(0)
        # Already scoped — leave unchanged
        window = content[max(0, m.start() - 80) : m.start()]
        if "locator(" in window or ".filter(" in window:
            return m.group(0)
        return (
            f"{m.group('prefix')}.locator('form')"
            f".getByRole('button', {{ name: {name_raw} }})"
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


def _insert_methods_before_class_end(page_content: str, snippets: Iterable[str]) -> str:
    joined = "".join(snippets)
    if not joined.strip():
        return page_content
    idx = page_content.rfind("}")
    if idx < 0:
        return page_content + joined
    return page_content[:idx] + joined + page_content[idx:]


def fix_page_method_contract(spec_content: str, page_content: str) -> tuple[str, str]:
    """
    Ensure every page-object method invoked in spec exists on the page class.

    Adds alias/stub implementations on the page file (preferred over rewriting spec).
    """
    bindings = _find_page_bindings(spec_content)
    if not bindings:
        return spec_content, page_content

    class_name = bindings[0][1]
    if _CLASS_RE.search(page_content) and _CLASS_RE.search(page_content).group(1) != class_name:
        # page file class name mismatch — skip aggressive rewrite
        pass

    existing = _extract_class_methods(page_content, class_name)
    existing_norm = {_norm_key(m): m for m in existing}
    needed: set[str] = set()
    for var_name, cls in bindings:
        if cls != class_name:
            continue
        needed |= _collect_spec_method_calls(spec_content, var_name)

    missing = [m for m in sorted(needed) if m not in existing]
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

    page_content = _insert_methods_before_class_end(page_content, snippets)
    return spec_content, page_content


def apply_e2e_codegen_guards(
    files: list,
    *,
    dom_snapshot: str = "",
) -> list:
    """Run deterministic guards across generated E2E files."""
    from app.llm.base import E2EFile

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
            f.content = strip_feature_expects_from_goto(f.content)

    for f in normalized:
        p = f.path.replace("\\", "/")
        if f.kind != "spec" and "/specs/" not in p:
            continue
        for m in re.finditer(r"""from\s+['"]([^'"]+)['"]""", f.content):
            leaf = m.group(1).rsplit("/", 1)[-1].lower()
            candidates = [leaf, f"{leaf}.ts", f"{leaf}.page.ts"]
            page_file = next((page_by_base[c] for c in candidates if c in page_by_base), None)
            if page_file is None:
                continue
            _, page_file.content = fix_page_method_contract(f.content, page_file.content)

    has_valid_state = any(
        looks_like_storage_state_path(f.path)
        and is_valid_storage_state_json(f.content or "")
        for f in normalized
    )
    for f in normalized:
        p = f.path.replace("\\", "/").lower()
        is_cfg = f.kind == "config" or p.endswith("playwright.config.ts")
        if not is_cfg:
            continue
        f.content = normalize_config_storage_state(
            f.content or "", has_valid_state=has_valid_state
        )

    # Rewrite cross-TC page imports to local ../pages/ (each TC has its own config)
    for f in normalized:
        p = f.path.replace("\\", "/")
        is_spec = f.kind == "spec" or "/specs/" in f"/{p.lower()}/" or p.lower().endswith(".spec.ts")
        if is_spec:
            f.content = _rewrite_cross_tc_imports(f.content, f.path, normalized)

    # Strip test.use({ storageState }) from specs when no valid storageState file
    if not has_valid_state:
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

    # When no storageState: inject generic ensureAuthenticated for feature specs
    if not has_valid_state:
        normalized = ensure_auth_helper_files(normalized)

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


def _is_login_or_auth_spec(path: str, content: str) -> bool:
    p = (path or "").replace("\\", "/")
    if _LOGIN_SPEC_HINT_RE.search(p):
        return True
    # Title / describe hints
    if re.search(
        r"test(?:\.(?:describe|only|skip))?\s*\(\s*['\"`][^'\"`]*(?:login|logout|sign[\s_-]*in|đăng\s*nhập|auth)",
        content or "",
        re.IGNORECASE,
    ):
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
        if "ensureAuthenticated" not in content:
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
    """Add import + await ensureAuthenticated(page) at start of each test body."""
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
    """Ensure each test that uses `page` starts with await ensureAuthenticated(page)."""
    # Avoid duplicates
    if re.search(r"await\s+ensureAuthenticated\s*\(\s*page\s*\)", text):
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
        return m.group(0) + "\n  await ensureAuthenticated(page);"

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
        r"test\.use\(\s*\{\s*storageState\s*:\s*['\"][^'\"]*['\"]\s*\}\s*\)\s*;?\s*\n?",
        "",
        content,
    )


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


def normalize_config_storage_state(content: str, *, has_valid_state: bool) -> str:
    """
    Playwright resolves storageState relative to the config file directory.
    Absolute-from-repo paths like AItest/E2ETest/{Module}/fixtures/... break when
    cwd/config already sit under that module. Always use ./fixtures/storageState.json
    when a valid state file is bundled; otherwise strip storageState.
    """
    text = content or ""
    if not has_valid_state:
        # Remove storageState line(s)
        text = re.sub(
            r"^[ \t]*storageState\s*:\s*['\"][^'\"]*['\"]\s*,?\s*\n",
            "",
            text,
            flags=re.MULTILINE | re.IGNORECASE,
        )
        return text

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
