"""Tests for deterministic E2E codegen guards."""

from __future__ import annotations

import json

from app.llm.base import E2EFile
from app.services.e2e_codegen_guard import (
    apply_e2e_codegen_guards,
    fix_duplicate_button_locators,
    fix_page_method_contract,
    inject_ensure_authenticated,
    strip_feature_expects_from_goto,
)


LOGIN_PAGE = """\
/// <reference path="../types/playwright-shim.d.ts" />
import { expect, type Locator, type Page } from '@playwright/test';

export class LoginPage {
  readonly page: Page;
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly loginButton: Locator;

  constructor(page: Page) {
    this.page = page;
    this.emailInput = page.getByLabel('Email');
    this.passwordInput = page.getByLabel('Mật khẩu');
    this.loginButton = page.getByRole('button', { name: 'Đăng nhập' });
  }

  async goto(): Promise<void> {
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
  }

  async fillEmail(email: string): Promise<void> {
    await this.emailInput.fill(email);
  }

  async fillPassword(password: string): Promise<void> {
    await this.passwordInput.fill(password);
  }

  async clickLogin(): Promise<void> {
    await this.loginButton.click();
  }

  async expectLoginFormVisible(): Promise<void> {
    await expect(this.emailInput).toBeVisible();
    await expect(this.passwordInput).toBeVisible();
    await expect(this.loginButton).toBeVisible();
  }
}
"""

LOGIN_SPEC = """\
/// <reference path="../types/playwright-shim.d.ts" />
import { test } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test('bad contract', async ({ page, baseURL }) => {
  const loginPage = new LoginPage(page);
  await loginPage.gotoLogin();
  await loginPage.fillEmail('a@b.com');
  await loginPage.fillPassword('secret');
  await loginPage.clickLogin();
  await loginPage.assertStillOnLoginUrl(baseURL ?? 'http://localhost:5174/');
  await loginPage.assertLoginFormVisible();
  const pageText = await loginPage.getPageText();
});
"""

DOM_TABLIST = """
- tablist "Auth mode":
  - button "Đăng nhập"
- form:
  - button "Đăng nhập"
"""


def test_fix_duplicate_button_locators_scopes_to_form():
    fixed = fix_duplicate_button_locators(LOGIN_PAGE, dom_snapshot=DOM_TABLIST)
    assert "locator('form').getByRole('button', { name: 'Đăng nhập' }).first()" in fixed
    assert fixed.count("getByRole('button', { name: 'Đăng nhập' })") == 1


def test_fix_duplicate_button_locators_scopes_auth_page_without_dom_snapshot():
    page = """\
export class LoginPage {
  constructor(page: Page) {
    this.passwordInput = page.getByLabel('Mật khẩu');
    this.submitButton = page.getByRole('button', { name: /đăng nhập/i });
  }
}
"""
    fixed = fix_duplicate_button_locators(page, dom_snapshot="")
    assert "locator('form').getByRole('button', { name: /đăng nhập/i }).first()" in fixed


def test_fix_page_method_contract_adds_aliases():
    _, page = fix_page_method_contract(LOGIN_SPEC, LOGIN_PAGE)
    assert "async gotoLogin()" in page
    assert "await this.goto()" in page
    assert "async assertLoginFormVisible()" in page
    assert "await this.expectLoginFormVisible()" in page
    assert "async getPageText()" in page
    assert "async assertStillOnLoginUrl" in page


def test_apply_e2e_codegen_guards_integration():
    files = [
        E2EFile(path="AItest/E2ETest/Auth/pages/login.page.ts", content=LOGIN_PAGE, kind="page"),
        E2EFile(path="AItest/E2ETest/Auth/specs/login.spec.ts", content=LOGIN_SPEC, kind="spec"),
    ]
    out = apply_e2e_codegen_guards(files, dom_snapshot=DOM_TABLIST)
    page = next(f for f in out if f.kind == "page")
    assert "locator('form')" in page.content
    assert "async gotoLogin()" in page.content


def test_guards_drop_empty_storage_state_and_bogus_spec():
    cfg = """\
import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: {
    baseURL: 'http://localhost:3000',
    storageState: "AItest/E2ETest/Mod/fixtures/storageState.json",
  },
});
"""
    bogus = """\
/// <reference path="../types/playwright-shim.d.ts" />
declare module '@playwright/test' {
  export const test: any;
}
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/fixtures/storageState.json",
            content="{}",
            kind="fixture",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/specs/broken.spec.ts",
            content=bogus,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/playwright.config.ts",
            content=cfg,
            kind="config",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/specs/ok.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    paths = [f.path.replace("\\", "/") for f in out]
    assert not any(p.endswith("storageState.json") for p in paths)
    assert not any(p.endswith("broken.spec.ts") for p in paths)
    assert any(p.endswith("ok.spec.ts") for p in paths)
    cfg_out = next(f for f in out if f.path.endswith("playwright.config.ts"))
    assert "storageState" not in cfg_out.content


def test_guards_normalize_valid_storage_path_relative():
    state = json.dumps({"cookies": [{"name": "a", "value": "b", "domain": "localhost", "path": "/"}], "origins": []})
    cfg = """\
export default defineConfig({
  use: {
    storageState: "AItest/E2ETest/Mod/fixtures/storageState.json",
  },
});
"""
    files = [
        E2EFile(path="AItest/E2ETest/Mod/fixtures/storageState.json", content=state, kind="fixture"),
        E2EFile(path="AItest/E2ETest/Mod/playwright.config.ts", content=cfg, kind="config"),
    ]
    out = apply_e2e_codegen_guards(files)
    cfg_out = next(f for f in out if f.kind == "config")
    assert "./fixtures/storageState.json" in cfg_out.content
    assert "AItest/E2ETest" not in cfg_out.content.split("storageState")[1][:80]


def test_strip_feature_expects_from_goto():
    page = """\
export class TodoPage {
  async goto(): Promise<void> {
    await this.page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(this.todoItems.first()).toBeVisible();
  }
}
"""
    fixed = strip_feature_expects_from_goto(page)
    assert "this.page.goto" in fixed
    assert "toBeVisible" not in fixed


def test_inject_ensure_authenticated_adds_call():
    spec = """\
import { test } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';

test('update title', async ({ page }) => {
  const todo = new TodoPage(page);
  await todo.goto();
});
"""
    out = inject_ensure_authenticated(spec)
    assert "from '../fixtures/auth.helper'" in out
    assert "await ensureAuthenticated(page);" in out
    assert "0. Đăng nhập / authenticate" in out or "test.step" in out
    assert out.index("ensureAuthenticated") < out.index("todo.goto")


def test_guards_inject_auth_helper_for_feature_spec_without_storage():
    todo_page = """\
export class TodoPage {
  async goto(): Promise<void> {
    await this.page.goto('/');
    await expect(this.todoItems.first()).toBeVisible();
  }
}
"""
    todo_spec = """\
import { test } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';

test('update title', async ({ page }) => {
  const todo = new TodoPage(page);
  await todo.goto();
});
"""
    files = [
        E2EFile(path="AItest/E2ETest/Todo/pages/todo.page.ts", content=todo_page, kind="page"),
        E2EFile(path="AItest/E2ETest/Todo/specs/update-todo-title.spec.ts", content=todo_spec, kind="spec"),
    ]
    out = apply_e2e_codegen_guards(files)
    page = next(f for f in out if f.kind == "page")
    assert "toBeVisible" not in page.content
    helper = next(f for f in out if f.path.replace("\\", "/").endswith("auth.helper.ts"))
    assert "ensureAuthenticated" in helper.content
    assert "E2E_USERNAME" in helper.content
    assert "E2E_ROLE" in helper.content
    assert "E2E_<ROLE>_USERNAME" in helper.content
    # Landing → login discovery (project-agnostic; Forensic-inspired)
    assert "E2E_LOGIN_PATH" in helper.content
    assert "COMMON_LOGIN_PATHS" in helper.content or "'/login'" in helper.content
    assert "data-cy" in helper.content
    assert "openLoginEntry" in helper.content or "LOGIN_NAME" in helper.content
    assert "signUpTab" in helper.content
    assert "tryRegisterAndRelogin" in helper.content
    assert (
        "Login did not leave the login wall" in helper.content
        or "password still visible" in helper.content
    )
    assert "localStorage" in helper.content
    spec = next(f for f in out if f.kind == "spec")
    assert "await ensureAuthenticated(page);" in spec.content


def test_guards_refresh_existing_auth_helper():
    old = """\
export async function ensureAuthenticated(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.getByRole('textbox').first()).toBeHidden();
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/Todo/fixtures/auth.helper.ts", content=old, kind="fixture"),
        E2EFile(
            path="AItest/E2ETest/Todo/specs/update.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "import { ensureAuthenticated } from '../fixtures/auth.helper';\n"
                "test('x', async ({ page }) => { await ensureAuthenticated(page); });\n"
            ),
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    helper = next(f for f in out if f.path.replace("\\", "/").endswith("auth.helper.ts"))
    assert "Login did not leave the login wall" in helper.content or "password still visible" in helper.content
    assert "passwordField()" in helper.content or "toBeHidden" in helper.content
    assert "E2E_LOGIN_PATH" in helper.content
    assert "data-cy" in helper.content


def test_guards_skip_auth_inject_for_login_spec():
    files = [
        E2EFile(path="AItest/E2ETest/Auth/pages/login.page.ts", content=LOGIN_PAGE, kind="page"),
        E2EFile(path="AItest/E2ETest/Auth/specs/login.spec.ts", content=LOGIN_SPEC, kind="spec"),
    ]
    out = apply_e2e_codegen_guards(files, dom_snapshot=DOM_TABLIST)
    assert not any(f.path.replace("\\", "/").endswith("auth.helper.ts") for f in out)
    spec = next(f for f in out if f.kind == "spec")
    assert "ensureAuthenticated" not in spec.content


def test_guards_create_missing_page_file_from_spec_import():
    spec = """\
import { test } from '@playwright/test';
import { TodoUpdatePage } from '../pages/todo-update.page';

test('x', async ({ page }) => {
  const po = new TodoUpdatePage(page);
  await po.goto();
  await po.openEdit();
  await po.submit();
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Todo/specs/todo-update.spec.ts",
            content=spec,
            kind="spec",
        )
    ]
    out = apply_e2e_codegen_guards(files)
    page = next(
        f
        for f in out
        if f.path.replace("\\", "/").endswith("pages/todo-update.page.ts")
    )
    assert "export class TodoUpdatePage" in page.content
    assert "async openEdit" in page.content
    assert "async submit" in page.content


def test_guards_scope_bare_button_to_form():
    page_src = """\
export class LoginPage {
  constructor(page: Page) {
    this.submitButton = page.getByRole('button');
  }
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/Auth/pages/login.page.ts", content=page_src, kind="page"),
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    page = next(f for f in out if f.kind == "page")
    assert "page.locator('form').getByRole('button')" in page.content
    assert "page.getByRole('button')" not in page.content.replace(
        "page.locator('form').getByRole('button')", ""
    )


def test_guards_rewrite_validation_spec_click_to_disabled():
    """Validation spec: clickSubmit() → expectSubmitDisabled()."""
    spec = """\
import { test, expect } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test.describe('[E2E-Validation] Đăng nhập - Bỏ trống mật khẩu', () => {
  test('Bỏ trống mật khẩu', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.goto();
    await loginPage.fillEmail('user@example.com');
    await loginPage.clearPassword();
    await loginPage.clickSubmit();
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/Validation/specs/login-empty-pw.spec.ts",
            content=spec,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    spec_out = next(f for f in out if f.kind == "spec")
    assert "expectSubmitDisabled" in spec_out.content
    assert "clickSubmit" not in spec_out.content


def test_guards_validation_does_not_touch_normal_spec():
    """Non-validation spec: clickSubmit() stays."""
    spec = """\
import { test } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test('Login thành công', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
  await loginPage.fillEmail('user@example.com');
  await loginPage.fillPassword('secret');
  await loginPage.clickSubmit();
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/Login/specs/login-ok.spec.ts",
            content=spec,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    spec_out = next(f for f in out if f.kind == "spec")
    assert "clickSubmit" in spec_out.content
    assert "expectSubmitDisabled" not in spec_out.content


def test_guards_rewrite_deep_cross_tc_page_import_to_local_pages():
    spec = """\
import { test } from '@playwright/test';
import { LoginPage } from '../../../Đăng nhập/[E2E-BusinessRules] Đăng nhập - Sai mật khẩu/pages/login.page';

test('x', async ({ page }) => {
  const loginPage = new LoginPage(page);
  await loginPage.goto();
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/To do list/[E2E-Validation] Đăng nhập - Sai email/specs/login-invalid-email.spec.ts",
            content=spec,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    spec_out = next(f for f in out if f.kind == "spec")
    assert "from '../pages/login.page'" in spec_out.content
    assert "from '../../../Đăng nhập/" not in spec_out.content


def test_guards_invalid_email_case_keeps_click_submit():
    spec = """\
import { test } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test.describe('[E2E-Validation] Đăng nhập - Nhập email sai định dạng', () => {
  test('x', async ({ page }) => {
    const loginPage = new LoginPage(page);
    await loginPage.fillEmail('bad-email');
    await loginPage.fillPassword('Abcdef1!');
    await loginPage.clickSubmit();
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login-invalid-email.spec.ts",
            content=spec,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    spec_out = next(f for f in out if f.kind == "spec")
    assert "clickSubmit" in spec_out.content
    assert "expectSubmitDisabled" not in spec_out.content


def test_rewrite_login_rejected_handles_html5_invalid_email_without_dom_snapshot():
    page = """\
export class LoginPage {
  readonly emailInput: Locator;
  readonly passwordInput: Locator;
  readonly submitButton: Locator;

  async expectErrorMessage(): Promise<void> {
    await this.page.getByText(/email/i).first().waitFor({ state: 'visible' });
  }

  async expectLoginRejected(): Promise<void> {
    await this.expectErrorMessage();
  }

  async expectOnLoginScreen(): Promise<void> {}
}
"""
    from app.services.e2e_codegen_guard import _rewrite_login_rejected_assertion

    fixed = _rewrite_login_rejected_assertion(page)
    assert "checkValidity()" in fixed
    assert "expectOnLoginScreen()" in fixed


def test_missing_login_page_fallback_handles_submit_button_field_usage():
    spec = """\
import { test } from '@playwright/test';
import { LoginPage } from '../pages/login.page';

test('x', async ({ page }) => {
  const loginPage = new LoginPage(page);
  if (await loginPage.submitButton.isEnabled()) {
    await loginPage.clickSubmit();
  } else {
    await loginPage.expectSubmitDisabled();
  }
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login.spec.ts",
            content=spec,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files)
    page = next(f for f in out if f.kind == "page")
    assert "readonly submitButton: Locator;" in page.content
    assert "async isSubmitEnabled" in page.content
    assert "async clickSubmit" in page.content


def test_guards_use_storage_flag_without_valid_json_falls_back_to_ui_helper():
    """useStorage but no JSON in bundle → strip storageState/globalSetup + ensureAuthenticated."""
    cfg = """\
export default defineConfig({
  globalSetup: './fixtures/global.setup.ts',
  use: {
    storageState: "AItest/E2ETest/Mod/fixtures/storageState.json",
  },
});
"""
    feature_spec = """\
import { test } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';

test('update title', async ({ page }) => {
  const todo = new TodoPage(page);
  await todo.goto();
});
"""
    files = [
        E2EFile(path="AItest/E2ETest/Mod/playwright.config.ts", content=cfg, kind="config"),
        E2EFile(
            path="AItest/E2ETest/Mod/specs/update.spec.ts",
            content=feature_spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/pages/todo.page.ts",
            content="export class TodoPage { async goto() {} }",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files, use_storage=True, test_case_title="Update title"
    )
    cfg_out = next(f for f in out if f.kind == "config")
    assert "storageState" not in cfg_out.content
    assert "globalSetup" not in cfg_out.content
    assert not any(
        f.path.replace("\\", "/").endswith("global.setup.ts") for f in out
    )
    spec = next(f for f in out if f.kind == "spec")
    assert "await ensureAuthenticated(page);" in spec.content
    assert "0. Đăng nhập / authenticate" in spec.content
    assert any(f.path.endswith("auth.helper.ts") for f in out)


def test_guards_headed_forces_visible_login_step_even_with_storage():
    """Headed Verify should not skip login UI via storageState."""
    cfg = """\
export default defineConfig({
  use: { storageState: './fixtures/storageState.json' },
});
"""
    state = '{"cookies":[{"name":"a","value":"b","domain":"localhost","path":"/"}],"origins":[]}'
    feature_spec = """\
import { test } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';
test('feature', async ({ page }) => {
  const todo = new TodoPage(page);
  await todo.goto();
});
"""
    files = [
        E2EFile(path="AItest/E2ETest/Mod/playwright.config.ts", content=cfg, kind="config"),
        E2EFile(
            path="AItest/E2ETest/Mod/fixtures/storageState.json",
            content=state,
            kind="fixture",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/specs/feature.spec.ts",
            content=feature_spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/pages/todo.page.ts",
            content="export class TodoPage { async goto() {} }",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        use_storage=True,
        test_case_title="Update todo title",
        headed=True,
    )
    cfg_out = next(f for f in out if f.kind == "config")
    assert "storageState" not in cfg_out.content
    spec = next(f for f in out if f.kind == "spec")
    assert "0. Đăng nhập / authenticate" in spec.content


def test_guards_rewrite_networkidle_goto():
    from app.services.e2e_codegen_guard import rewrite_networkidle_goto

    src = "await this.page.goto('/x', { waitUntil: 'networkidle' });"
    assert "domcontentloaded" in rewrite_networkidle_goto(src)
    assert "networkidle" not in rewrite_networkidle_goto(src)


def test_fix_nested_expect_on_pom_asserts():
    from app.services.e2e_codegen_guard import _fix_nested_expect_on_pom_asserts

    src = (
        "await expect(await todo.expectTodoVisible('Todo riêng của B')).toBeVisible();\n"
        "await expect(todo.assertTitleShown('Hi')).toBeVisible({ timeout: 5000 });\n"
    )
    out = _fix_nested_expect_on_pom_asserts(src)
    assert "await todo.expectTodoVisible('Todo riêng của B');" in out
    assert "await todo.assertTitleShown('Hi');" in out
    assert "expect(await" not in out
    assert "toBeVisible" not in out


def test_fix_nested_expect_unwraps_void_and_keeps_locator_getter():
    from app.services.e2e_codegen_guard import _fix_nested_expect_on_pom_asserts

    src = (
        "await expect(await pom.expectSubmitDisabled()).toBeVisible();\n"
        "await expect(await pom.getErrorBanner('x')).toBeVisible();\n"
    )
    out = _fix_nested_expect_on_pom_asserts(src)
    assert "await pom.expectSubmitDisabled();" in out
    assert "await expect(pom.getErrorBanner('x')).toBeVisible();" in out
    assert "expect(await pom.expect" not in out


def test_ensure_locator_fields_for_undefined_prop_expect():
    from app.services.e2e_codegen_guard import (
        _ensure_locator_fields_for_spec_expects,
        apply_e2e_codegen_guards,
    )
    from app.llm.base import E2EFile

    spec = """\
import { test, expect } from '@playwright/test';
import { DocPage } from '../pages/doc.page';
test('x', async ({ page }) => {
  const pom = new DocPage(page);
  await expect(pom.submitButton).toBeVisible();
});
"""
    page = """\
import { type Locator, type Page } from '@playwright/test';
export class DocPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
}
"""
    _, out_page = _ensure_locator_fields_for_spec_expects(spec, page)
    assert "readonly submitButton: Locator" in out_page
    assert "this.submitButton =" in out_page
    # Must init AFTER this.page = page (else undefined.locator)
    page_i = out_page.index("this.page = page")
    btn_i = out_page.index("this.submitButton =")
    assert page_i < btn_i

    out = apply_e2e_codegen_guards(
        [
            E2EFile(path="AItest/E2ETest/M/T/specs/a.spec.ts", content=spec, kind="spec"),
            E2EFile(path="AItest/E2ETest/M/T/pages/doc.page.ts", content=page, kind="page"),
        ]
    )
    page_out = next(f.content for f in out if f.kind == "page")
    assert "submitButton" in page_out
    assert page_out.index("this.page = page") < page_out.index("this.submitButton =")


def test_relax_exact_gettext():
    from app.services.e2e_codegen_guard import _relax_exact_gettext

    src = "await expect(page.getByText('Todo riêng của B', { exact: true })).toBeVisible();"
    out = _relax_exact_gettext(src)
    assert "{ exact: true }" not in out
    assert "getByText(/Todo" in out
    assert "/i)" in out


def test_fix_literal_regex_gettext():
    from app.services.e2e_codegen_guard import _fix_literal_regex_gettext

    src = "await expect(page.getByText('tài khoản.*todo|quản lý\\\\s*todo').first()).toBeVisible();"
    out = _fix_literal_regex_gettext(src)
    assert "getByText(/tài khoản.*todo|quản lý\\\\s*todo/i)" in out
    assert "getByText('tài khoản" not in out


def test_sync_async_locator_getters():
    from app.services.e2e_codegen_guard import _sync_async_locator_getters

    src = "  async getTodoItem(text: string): Promise<Locator> {\n    return this.page.getByText(text);\n  }\n"
    out = _sync_async_locator_getters(src)
    assert "async getTodoItem" not in out
    assert "getTodoItem(text: string): Locator {" in out


def test_fix_page_method_contract_adds_logout_and_register_stubs():
    from app.services.e2e_codegen_guard import fix_page_method_contract

    spec = """\
const login = new LoginPage(page);
await login.ensureRegisterTabActive();
await login.clickLogout();
"""
    page = """\
export class LoginPage {
  constructor(public page: import('@playwright/test').Page) {}
  async goto() {}
}
"""
    _, out = fix_page_method_contract(spec, page)
    assert "async ensureRegisterTabActive" in out
    assert "async clickLogout" in out
    assert "đăng" in out
    assert "xuất" in out or "sign" in out.lower()
    assert "tab" in out.lower()


def test_fix_page_method_contract_skips_class_mismatch():
    from app.services.e2e_codegen_guard import fix_page_method_contract

    spec = "const login = new LoginPage(page);\nawait login.goto();\n"
    page = "export class OtherPage {\n  constructor(public page: any) {}\n}\n"
    _, out = fix_page_method_contract(spec, page)
    assert out == page
    assert "async goto" not in out


def test_fix_page_method_contract_idempotent_on_reapply():
    from app.services.e2e_codegen_guard import fix_page_method_contract

    spec = """\
const login = new LoginPage(page);
await login.clickLogout();
"""
    page = """\
export class LoginPage {
  constructor(public page: import('@playwright/test').Page) {}
  async goto() {}
}
"""
    _, once = fix_page_method_contract(spec, page)
    _, twice = fix_page_method_contract(spec, once)
    assert once.count("async clickLogout") == twice.count("async clickLogout") == 1


def test_fix_page_rewrites_static_pom_calls():
    from app.services.e2e_codegen_guard import fix_page_method_contract

    spec = """\
import { test } from '@playwright/test';
import { DocPage } from '../pages/doc.page';

test('upload', async ({ page }) => {
  const path = await DocPage.ensureInvalidExeFixture();
  await DocPage.goto();
});
"""
    page = """\
export class DocPage {
  constructor(public page: import('@playwright/test').Page) {}
}
"""
    out_spec, out_page = fix_page_method_contract(spec, page)
    assert "DocPage.ensureInvalidExeFixture" not in out_spec
    assert "DocPage.goto" not in out_spec
    assert "new DocPage" in out_spec
    assert "ensureInvalidExeFixture" in out_page
    assert "async goto" in out_page or "goto(" in out_page


def test_fix_page_aligns_import_class_name():
    from app.services.e2e_codegen_guard import fix_page_method_contract

    spec = """\
import { WrongName } from '../pages/doc.page';
test('x', async ({ page }) => {
  const p = new WrongName(page);
  await p.goto();
});
"""
    page = """\
export class DocPage {
  constructor(public page: import('@playwright/test').Page) {}
}
"""
    out_spec, out_page = fix_page_method_contract(spec, page)
    assert "DocPage" in out_spec
    assert "WrongName" not in out_spec
    assert "async goto" in out_page


def test_guards_apply_expect_and_exact_fixes():
    spec = """\
import { test, expect } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';

test('isolation', async ({ page }) => {
  const todo = new TodoPage(page);
  await expect(await todo.expectOwnedTodo('Todo riêng của B')).toBeVisible();
  await expect(page.getByText('Todo riêng của B', { exact: true })).toBeVisible();
});
"""
    page = """\
export class TodoPage {
  constructor(public page: import('@playwright/test').Page) {}
  async getOwnedTodo(text: string): Promise<Locator> {
    return this.page.getByText(text, { exact: true });
  }
  async expectOwnedTodo(text: string): Promise<void> {
    await expect(this.page.getByText(text, { exact: false })).toBeVisible();
  }
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/Todo/pages/todo.page.ts", content=page, kind="page"),
        E2EFile(path="AItest/E2ETest/Todo/specs/iso.spec.ts", content=spec, kind="spec"),
    ]
    out = apply_e2e_codegen_guards(files, use_storage=True, test_case_title="Todo B")
    spec_out = next(f for f in out if f.kind == "spec")
    page_out = next(f for f in out if f.kind == "page")
    assert "await todo.expectOwnedTodo('Todo riêng của B');" in spec_out.content
    assert "exact: true" not in spec_out.content
    assert "async getOwnedTodo" not in page_out.content
    assert "getOwnedTodo(text: string): Locator {" in page_out.content


def test_guards_public_app_strips_auth_even_when_storage_checked():
    """SRS/TC says no login → public mode wins over Desktop useStorageState."""
    cfg = """\
export default defineConfig({
  globalSetup: './fixtures/global.setup.ts',
  use: {
    storageState: "./fixtures/storageState.json",
  },
});
"""
    feature_spec = """\
import { test } from '@playwright/test';
import { TodoPage } from '../pages/todo.page';
import { ensureAuthenticated } from '../fixtures/auth.helper';

test.use({
  storageState: "./fixtures/storageState.json",
});

test('xem danh sach', async ({ page }) => {
  await ensureAuthenticated(page);
  const todo = new TodoPage(page);
  await todo.goto();
});
"""
    files = [
        E2EFile(path="AItest/E2ETest/To-do/playwright.config.ts", content=cfg, kind="config"),
        E2EFile(
            path="AItest/E2ETest/To-do/specs/view.spec.ts",
            content=feature_spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/To-do/pages/todo.page.ts",
            content="export class TodoPage { async goto() {} }",
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/To-do/fixtures/auth.helper.ts",
            content="export async function ensureAuthenticated() {}",
            kind="fixture",
        ),
        E2EFile(
            path="AItest/E2ETest/To-do/fixtures/global.setup.ts",
            content="export default async function() {}",
            kind="fixture",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        use_storage=True,
        test_case_title="Xem danh sách công việc",
        auth_hints="Không yêu cầu đăng nhập trong phiên bản này.",
        dom_snapshot=(
            "main heading Danh sách công việc button Thêm mới "
            "listitem ABC form title description"
        ),
    )
    paths = [f.path.replace("\\", "/") for f in out]
    assert not any(p.endswith("auth.helper.ts") for p in paths)
    assert not any(p.endswith("global.setup.ts") for p in paths)
    cfg_out = next(f for f in out if f.kind == "config")
    assert "storageState" not in cfg_out.content
    assert "globalSetup" not in cfg_out.content
    spec = next(f for f in out if f.kind == "spec")
    assert "ensureAuthenticated" not in spec.content
    assert "storageState" not in spec.content


def test_guards_inject_despite_ai_public_comment_and_negated_login_step():
    """
    AI often writes «Auth: PUBLIC — không ensureAuthenticated» + step «không đăng nhập»
    on protected apps. Guards must still inject a real login step (not trust comments).
    """
    feature_spec = """\
/// <reference path=\"../types/playwright-shim.d.ts\" />
import { test } from '@playwright/test';
import { FeaturePage } from '../pages/feature.page';

/**
 * Auth: PUBLIC — không storageState / ensureAuthenticated
 */
test.describe('[E2E-Validation] Feature form', () => {
  test('Bỏ trống trường bắt buộc', async ({ page }) => {
  const pom = new FeaturePage(page);

  await test.step('0. Mở ứng dụng (PUBLIC — không đăng nhập)', async () => {
    await pom.goto();
  });

    await test.step('1. Submit empty', async () => {
      await pom.submit();
    });
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Feature/specs/validation.spec.ts",
            content=feature_spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Feature/pages/feature.page.ts",
            content=(
                "export class FeaturePage {\n"
                "  constructor(private page: any) {}\n"
                "  async goto() { await this.page.goto('/'); }\n"
                "  async submit() {}\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/Feature/playwright.config.ts",
            content=(
                "export default defineConfig({\n"
                "  use: { storageState: './fixtures/storageState.json' },\n"
                "});\n"
            ),
            kind="config",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        use_storage=True,
        test_case_title="Validation bỏ trống trường bắt buộc",
        headed=True,
    )
    helper = next(
        (f for f in out if f.path.replace("\\", "/").endswith("auth.helper.ts")),
        None,
    )
    assert helper is not None, "auth.helper.ts must be created"
    spec = next(f for f in out if f.path.replace("\\", "/").endswith(".spec.ts"))
    assert "await ensureAuthenticated(page)" in spec.content
    assert "0. Đăng nhập / authenticate" in spec.content
    cfg = next(f for f in out if f.kind == "config")
    assert "storageState" not in cfg.content


def test_guards_restore_stripped_spec_and_page_suffix():
    """Prior shorten left specs/foo-hash.ts — Playwright would report No tests found."""
    files = [
        E2EFile(
            path="AItest/E2ETest/M/specs/them-tai-lieu-hash.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "import { Page } from '../pages/them-tai-lieu-old.page';\n"
                "test('x', async ({ page }) => { await page.goto('/'); });\n"
            ),
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/M/pages/them-tai-lieu-hash.ts",
            content="export class Page { constructor(public page: any) {} }\n",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(files, test_case_title="Validation form", headed=True)
    paths = [f.path.replace("\\", "/") for f in out]
    assert any(p.endswith(".spec.ts") for p in paths)
    assert any(p.endswith(".page.ts") for p in paths)
    assert not any(p.endswith("/them-tai-lieu-hash.ts") for p in paths)
    spec = next(f for f in out if f.path.replace("\\", "/").endswith(".spec.ts"))
    assert "../pages/them-tai-lieu-hash.page" in spec.content or "them-tai-lieu-hash.page" in spec.content


def test_guards_fix_select_option_label_regexp():
    """Playwright selectOption label must be string — RegExp var causes runtime TypeError."""
    from app.services.e2e_codegen_guard import fix_select_option_label_regexp

    page = """\
export class EvidencePage {
  async selectTrangThai(optionLabel: string | RegExp): Promise<void> {
    const name =
      optionLabel instanceof RegExp
        ? optionLabel
        : new RegExp(optionLabel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&'), 'i');
    await expect(this.trangThaiSelect).toBeVisible();
    const tag = await this.trangThaiSelect.evaluate((el: HTMLElement) => el.tagName);
    if (String(tag).toLowerCase() === 'select') {
      await this.trangThaiSelect.selectOption({ label: name });
      return;
    }
    await this.trangThaiSelect.click();
    await this.page.getByRole('option', { name }).first().click();
  }
}
"""
    fixed = fix_select_option_label_regexp(page)
    assert "selectOption({ label: name })" not in fixed
    assert "typeof __aitestSelectLabel === 'string'" in fixed
    assert "locator('option').allTextContents()" in fixed
    # String literal must stay untouched
    keep = "await this.status.selectOption({ label: 'Đang phân tích' });"
    assert fix_select_option_label_regexp(keep) == keep

    files = [
        E2EFile(
            path="AItest/E2ETest/M/pages/evidence.page.ts",
            content=page,
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/M/specs/evidence.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "import { EvidencePage } from '../pages/evidence.page';\n"
                "test('x', async ({ page }) => {\n"
                "  const pom = new EvidencePage(page);\n"
                "  await pom.selectTrangThai(/đang phân tích/i);\n"
                "});\n"
            ),
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files, test_case_title="Boundary 255 chars")
    page_out = next(f for f in out if f.path.endswith("evidence.page.ts"))
    assert "selectOption({ label: name })" not in page_out.content
    assert "__aitestSelectLabel" in page_out.content
