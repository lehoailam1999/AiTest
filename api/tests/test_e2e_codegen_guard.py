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
    assert "locator('form').getByRole('button', { name: 'Đăng nhập' })" in fixed
    assert fixed.count("getByRole('button', { name: 'Đăng nhập' })") == 1


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
    assert "signUpTab" in helper.content
    assert "status === 401" in helper.content
    assert "Login did not leave the login wall" in helper.content
    assert "getByRole('tab'" in helper.content
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
    assert "Login did not leave the login wall" in helper.content
    assert "await expect(email).toBeHidden" in helper.content


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
