"""Tests for deterministic E2E codegen guards."""

from __future__ import annotations

import json
import re

from app.llm.base import E2EFile
from app.services.e2e_codegen_guard import (
    apply_e2e_codegen_guards,
    canonicalize_ensure_authenticated_imports,
    fix_duplicate_button_locators,
    fix_page_method_contract,
    inject_ensure_authenticated,
    normalize_collapsed_imports,
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


def test_guards_enforce_locator_contract_reject_unknown_hook():
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/pages/login.page.ts",
            content=(
                "export class LoginPage {\n"
                "  constructor(public page: any) {}\n"
                "  async submit() { await this.page.locator('[data-testid=\"wrong-id\"]').click(); }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    contract = "\n".join(
        [
            "data-cy: submit-btn",
            "data-testid: login-submit, username",
            "id: (none)",
            "name: (none)",
            "formControlName: (none)",
            "routes: /login",
        ]
    )
    try:
        apply_e2e_codegen_guards(files, locator_contract=contract)
        assert False, "expected locator-contract grounding failure"
    except ValueError as e:
        assert "E2E_GROUNDING" in str(e)
        assert "data-testid=wrong-id" in str(e)


def test_guards_reject_invented_locator_template_placeholder():
    """LLM sometimes emits name=${fieldKey} / formControlName=${fieldKey} — fail-closed."""
    files = [
        E2EFile(
            path="AItest/E2ETest/_shared/pages/evidence.page.ts",
            content=(
                "export class EvidencePage {\n"
                "  constructor(public page: any) {}\n"
                "  field(fieldKey: string) {\n"
                "    return this.page.locator(`[name=\"${fieldKey}\"]`);\n"
                "  }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/_shared/specs/evidence.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    contract = "\n".join(
        [
            "data-cy: (none)",
            "data-testid: (none)",
            "id: evidenceName",
            "name: evidenceName, evidenceCode",
            "formControlName: evidenceName",
            "routes: /admin/evidence",
        ]
    )
    try:
        apply_e2e_codegen_guards(files, locator_contract=contract)
        assert False, "expected placeholder locator grounding failure"
    except ValueError as e:
        assert "E2E_GROUNDING" in str(e)
        assert "fieldKey" in str(e) or "${" in str(e)


def test_guards_enforce_locator_contract_accepts_allowed_hook():
    files = [
        E2EFile(
            path="AItest/E2ETest/Auth/pages/login.page.ts",
            content=(
                "export class LoginPage {\n"
                "  constructor(public page: any) {}\n"
                "  async submit() { await this.page.locator('[data-testid=\"login-submit\"]').click(); }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/Auth/specs/login.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    contract = "\n".join(
        [
            "data-cy: submit-btn",
            "data-testid: login-submit, username",
            "id: (none)",
            "name: (none)",
            "formControlName: (none)",
            "routes: /login",
        ]
    )
    out = apply_e2e_codegen_guards(files, locator_contract=contract)
    assert any(f.kind == "page" for f in out)


def test_guards_accept_css_or_id_with_nested_form_control():
    """User fail: locator('#field_x, [formControlName=\"x\"]') must not false-positive."""
    files = [
        E2EFile(
            path="AItest/E2ETest/_shared/pages/create.page.ts",
            content=(
                "export class P {\n"
                "  constructor(public page: any) {}\n"
                "  async pick() {\n"
                "    await this.page.locator("
                "'#field_caseRecords, [formControlName=\"caseRecords\"]').click();\n"
                "  }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/Vật-chứng/TC/specs/create.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "test('x', async ({ page }) => {\n"
                "  await page.locator("
                "'#field_caseRecords, [formControlName=\"caseRecords\"]').click();\n"
                "});\n"
            ),
            kind="spec",
        ),
    ]
    contract = "\n".join(
        [
            "data-cy: entityCreateButton",
            "data-testid: (none)",
            "id: field_caseRecords",
            "name: (none)",
            "formControlName: caseRecords",
            "routes: /admin/evidence",
        ]
    )
    out = apply_e2e_codegen_guards(
        files, locator_contract=contract, enforce_journey=False, enforce_stubs=False
    )
    assert any(f.kind == "page" for f in out)


def test_guards_accept_field_id_via_form_control_bridge():
    """#field_X allowed when only formControlName X is in contract (Angular convention)."""
    files = [
        E2EFile(
            path="AItest/E2ETest/M/pages/x.page.ts",
            content=(
                "export class P {\n"
                "  constructor(public page: any) {}\n"
                "  async pick() { await this.page.locator('#field_caseRecords').click(); }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/M/specs/x.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    contract = "formControlName: caseRecords\nid: (none)\ndata-cy: (none)\n"
    out = apply_e2e_codegen_guards(
        files, locator_contract=contract, enforce_journey=False, enforce_stubs=False
    )
    assert any(f.kind == "page" for f in out)


def test_guards_accept_name_via_form_control_or_field_id_bridge():
    """name=X is grounded when formControlName X or id field_X is allowed."""
    files = [
        E2EFile(
            path="AItest/E2ETest/M/pages/x.page.ts",
            content=(
                "export class P {\n"
                "  constructor(public page: any) {}\n"
                "  async pick() { await this.page.locator('[name=\"caseRecords\"]').click(); }\n"
                "}\n"
            ),
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/M/specs/x.spec.ts",
            content="import { test } from '@playwright/test';\ntest('x', async () => {});",
            kind="spec",
        ),
    ]
    contract = (
        "formControlName: caseRecords\n"
        "id: field_caseRecords\n"
        "name: (none)\n"
        "data-cy: (none)\n"
    )
    out = apply_e2e_codegen_guards(
        files, locator_contract=contract, enforce_journey=False, enforce_stubs=False
    )
    assert any(f.kind == "page" for f in out)


def test_guards_accept_compound_css_under_allowed_id():
    """Descendant under allow-listed id remains grounded (#id .child)."""
    files = [
        E2EFile(
            path="AItest/E2ETest/Vật-chứng/TC/specs/create.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "test('x', async ({ page }) => {\n"
                "  await page.locator('#field_caseRecords .stitch-select-tag').click();\n"
                "  await page.locator('#field_caseRecords .stitch-select-tag-more').click();\n"
                "});\n"
            ),
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Vật-chứng/TC/pages/create.page.ts",
            content=(
                "export class P {\n"
                "  constructor(public page: any) {}\n"
                "  async pick() { await this.page.locator('#field_caseRecords').click(); }\n"
                "}\n"
            ),
            kind="page",
        ),
    ]
    contract = "\n".join(
        [
            "data-cy: entityCreateButton",
            "data-testid: (none)",
            "id: field_caseRecords, jh-create-entity",
            "name: (none)",
            "formControlName: caseRecords",
            "routes: /admin/evidence",
        ]
    )
    out = apply_e2e_codegen_guards(
        files, locator_contract=contract, enforce_journey=False, enforce_stubs=False
    )
    assert any("/specs/" in (f.path or "").replace("\\", "/") for f in out)


def test_guards_reject_unknown_root_id_even_if_compound():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/specs/x.spec.ts",
            content=(
                "test('x', async ({ page }) => {\n"
                "  await page.locator('#field_unknown .stitch-select-tag').click();\n"
                "});\n"
            ),
            kind="spec",
        ),
    ]
    contract = "id: field_caseRecords\ndata-cy: (none)\n"
    try:
        apply_e2e_codegen_guards(
            files, locator_contract=contract, enforce_journey=False, enforce_stubs=False
        )
        assert False, "expected violation"
    except ValueError as e:
        assert "field_unknown" in str(e) or "E2E_GROUNDING" in str(e)


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


def test_infer_and_bake_feature_path_from_spec_comment():
    from app.services.e2e_codegen_guard import (
        apply_e2e_codegen_guards,
        bake_feature_path_into_content,
        infer_feature_path_for_pair,
        infer_feature_path_from_files,
        infer_feature_path_from_text,
    )

    assert (
        infer_feature_path_from_text(
            "// Feature entry: /admin/evidence (FE admin.routes)\nawait pom.gotoFeature();",
            tokens=["evidence", "vat", "chung"],
        )
        == "/admin/evidence"
    )
    # Spec evidence must beat other /admin/* noise in the same blob
    assert (
        infer_feature_path_from_text(
            "const baked = \"/admin/case-record\";\n"
            "// Feature entry — /admin/evidence (E2E_FEATURE_PATH)\n"
            "await pom.gotoFeature();",
            tokens=["evidence", "chung"],
        )
        == "/admin/evidence"
    )
    page = """\
export class P {
  async gotoFeature(..._args: unknown[]): Promise<void> {
    const baked = "/admin/digital-file";
    const featurePath = (baked || process.env.E2E_FEATURE_PATH || '').trim();
    if (!featurePath) throw new Error('Feature entry: set E2E_FEATURE_PATH');
  }
}
"""
    baked = bake_feature_path_into_content(page, "/admin/evidence", force=True)
    assert 'const baked = "/admin/evidence"' in baked

    files = [
        E2EFile(
            path="AItest/E2ETest/M/TC/specs/a.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "import { P } from '../pages/a.page';\n"
                "/** Vật chứng evidence */\n"
                "test('t', async ({ page }) => {\n"
                "  await test.step('0. Auth', async () => { await ensureAuthenticated(page); });\n"
                "  // Feature entry — /admin/evidence (E2E_FEATURE_PATH)\n"
                "  await test.step('1. Feature entry', async () => { await new P(page).gotoFeature(); });\n"
                "});\n"
            ),
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/M/TC/pages/a.page.ts",
            content=page,
            kind="page",
        ),
        # Noise from another TC in the same batch
        E2EFile(
            path="AItest/E2ETest/M/Other/specs/b.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "// Feature entry — /admin/case-record\n"
                "test('b', async ({ page }) => {});\n"
            ),
            kind="spec",
        ),
    ]
    pair = infer_feature_path_for_pair(
        spec_path=files[0].path,
        spec_content=files[0].content,
        page_content=page,
    )
    assert pair == "/admin/evidence"
    out = apply_e2e_codegen_guards(files, enforce_stubs=False, enforce_journey=False)
    pom = next(f for f in out if f.path.endswith("a.page.ts"))
    assert 'const baked = "/admin/evidence"' in (pom.content or "")
    spec_a = next(f for f in out if f.path.endswith("a.spec.ts"))
    assert "/admin/case-record" not in (spec_a.content or "") or 'baked = "/admin/evidence"' in (
        spec_a.content or ""
    )


def test_normalize_collapsed_imports_forensic_mash():
    mashed = (
        "/// <reference path=\"../../../_shared/types/playwright-shim.d.ts\" />\n"
        "import { expect, test } from '@playwright/test'"
        "import { ensureAuthenticated } from '../../../../_shared/auth/ensure-authenticated'"
        "import { EvidenceCreateBr4SkipOptionalPage } from '../../../_shared/pages/evidence-create-br4-skip-optional.page'"
        "/**\n * authRequired=true · authRole=default · auth_mode=ui_helper\n */\n"
        "test('x', async ({ page }) => {});\n"
    )
    fixed = normalize_collapsed_imports(mashed)
    assert "test'import" not in fixed
    assert fixed.count("\nimport ") >= 2
    canon = canonicalize_ensure_authenticated_imports(
        fixed,
        spec_path="AItest/E2ETest/Req/TC/specs/a.spec.ts",
        helper_path="AItest/E2ETest/_shared/fixtures/auth.helper.ts",
    )
    assert "_shared/fixtures/auth.helper" in canon
    assert "ensure-authenticated" not in canon
    assert canon.count("ensureAuthenticated") >= 1
    assert len(re.findall(r"import\s*\{\s*ensureAuthenticated\s*\}", canon)) == 1


def test_normalize_heals_orphan_multiline_page_import():
    broken = (
        "import { expect, test } from '@playwright/test';\n"
        "  EvidenceCreateStep2BackPreservePage,\n"
        "  type Step2RelatedDocRecord,\n"
        "} from '../../../_shared/pages/evidence-create-step2-back-preserve.page';\n"
        "test('t', async ({ page }) => {\n"
        "  const pom = new EvidenceCreateStep2BackPreservePage(page);\n"
        "  await ensureAuthenticated(page);\n"
        "  await pom.gotoFeature();\n"
        "});\n"
    )
    fixed = normalize_collapsed_imports(broken)
    assert "import {\n  EvidenceCreateStep2BackPreservePage" in fixed
    files = [
        E2EFile(
            path="AItest/E2ETest/Vat/TC/specs/step2-back.spec.ts",
            content=fixed,
            kind="spec",
        )
    ]
    out = apply_e2e_codegen_guards(files, enforce_stubs=False, enforce_journey=False)
    page = next(
        f
        for f in out
        if f.path.replace("\\", "/").endswith(
            "_shared/pages/evidence-create-step2-back-preserve.page.ts"
        )
    )
    assert "EvidenceCreateStep2BackPreservePage" in (page.content or "")


def test_guards_heal_mashed_auth_imports():
    mashed = (
        "import { test } from '@playwright/test'"
        "import { ensureAuthenticated } from '../../_shared/auth/ensure-authenticated'"
        "import { TodoPage } from '../pages/todo.page';\n"
        "test('t', async ({ page }) => { const p = new TodoPage(page); await p.goto(); });\n"
    )
    files = [
        E2EFile(
            path="AItest/E2ETest/M/TC/pages/todo.page.ts",
            content="export class TodoPage { constructor(public page: any) {} async goto() { await this.page.goto('/'); } }",
            kind="page",
        ),
        E2EFile(
            path="AItest/E2ETest/M/TC/specs/t.spec.ts",
            content=mashed,
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(files, enforce_stubs=False, enforce_journey=False)
    spec = next(f for f in out if f.kind == "spec")
    assert "from '@playwright/test'import" not in spec.content
    assert "_shared/fixtures/auth.helper" in spec.content
    assert "ensure-authenticated" not in spec.content
    assert len(re.findall(r"import\s*\{\s*ensureAuthenticated\s*\}", spec.content)) == 1


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
    out = apply_e2e_codegen_guards(files, enforce_journey=False)
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


def test_guards_create_missing_shared_page_from_spec_import():
    """Forensic regression: Specs import _shared/pages but AI omitted POM files."""
    spec = """\
import { test } from '@playwright/test';
import {
  EvidenceCreateFinishStep2Page,
  type Step2RelatedDocRecord,
} from '../../../_shared/pages/evidence-create-finish-step2.page';

test('x', async ({ page }) => {
  const pom = new EvidenceCreateFinishStep2Page(page);
  await ensureAuthenticated(page);
  await pom.gotoFeature();
  await pom.openCreateModal();
  await pom.finishCreate();
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Vat-chung/E2E-HappyPath-Finish/specs/evidence-create-finish-step2.spec.ts",
            content=spec,
            kind="spec",
        )
    ]
    out = apply_e2e_codegen_guards(files, enforce_stubs=False, enforce_journey=False)
    page = next(
        f
        for f in out
        if f.path.replace("\\", "/").endswith(
            "_shared/pages/evidence-create-finish-step2.page.ts"
        )
    )
    assert "export class EvidenceCreateFinishStep2Page" in (page.content or "")
    assert "async gotoFeature" in (page.content or "") or "gotoFeature" in (page.content or "")
    assert "async openCreateModal" in (page.content or "")
    assert "async finishCreate" in (page.content or "")
    spec_out = next(f for f in out if f.path.endswith(".spec.ts"))
    assert "auth.helper" in (spec_out.content or "")
    assert re.search(
        r"import\s*\{\s*ensureAuthenticated\s*\}\s*from",
        spec_out.content or "",
    )


def test_canonicalize_adds_ensure_auth_import_when_call_missing_import():
    text = (
        "import { test } from '@playwright/test';\n"
        "import { TodoPage } from '../../../_shared/pages/todo.page';\n"
        "test('t', async ({ page }) => { await ensureAuthenticated(page); });\n"
    )
    out = canonicalize_ensure_authenticated_imports(
        text,
        spec_path="AItest/E2ETest/M/TC/specs/t.spec.ts",
        helper_path="AItest/E2ETest/_shared/fixtures/auth.helper.ts",
    )
    assert "_shared/fixtures/auth.helper" in out
    assert len(re.findall(r"import\s*\{\s*ensureAuthenticated\s*\}", out)) == 1


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


def test_guards_rewrite_deep_cross_tc_page_import_to_shared_pages():
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
    out = apply_e2e_codegen_guards(files, enforce_stubs=False, enforce_journey=False)
    spec_out = next(f for f in out if f.kind == "spec")
    assert "/_shared/pages/login.page" in spec_out.content or "from '../pages/login.page'" in spec_out.content
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
    assert "main, [role=\"main\"], body" not in out_page
    assert "getByRole('button'" in out_page
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


def test_journey_failsafe_injects_auth_before_enforce():
    """Regression: even if earlier passes miss auth, journey preflight must self-heal."""
    feature_spec = """\
import { test } from '@playwright/test';
import { EvidencePage } from '../pages/evidence.page';

test('Hoàn tất tạo vật chứng', async ({ page }) => {
  const pom = new EvidencePage(page);
  await test.step('1. Feature entry', async () => {
    await pom.gotoFeature();
  });
  await test.step('2. Act', async () => {
    await pom.submitForm();
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Vat-chung/specs/e2e-businessrules-hoan-tat.spec.ts",
            content=feature_spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Vat-chung/pages/evidence.page.ts",
            content=(
                "export class EvidencePage {\n"
                "  constructor(public page: any) {}\n"
                "  async gotoFeature() { await this.page.goto('/admin/evidence'); }\n"
                "  async submitForm() {}\n"
                "}\n"
            ),
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        enforce_journey=True,
        enforce_stubs=False,
        test_case_title="Hoàn tất tạo vật chứng",
    )
    spec = next(f for f in out if f.kind == "spec")
    assert "ensureAuthenticated(page)" in (spec.content or "")
    assert "0. Đăng nhập / authenticate" in (spec.content or "")


def test_import_only_ensure_authenticated_still_injects_call():
    spec = """\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';

test('x', async ({ page }) => {
  const pom = new EvidencePage(page);
  await test.step('1. Feature entry', async () => {
    await pom.gotoFeature();
  });
  await test.step('2. Act', async () => {
    await pom.submitForm();
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Vat-chung/specs/import-only.spec.ts",
            content=spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Vat-chung/pages/evidence.page.ts",
            content=(
                "export class EvidencePage {\n"
                "  constructor(public page: any) {}\n"
                "  async gotoFeature() { await this.page.goto('/admin/evidence'); }\n"
                "  async submitForm() {}\n"
                "}\n"
            ),
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        enforce_journey=True,
        enforce_stubs=False,
        test_case_title="Hoàn tất tạo vật chứng",
    )
    spec_out = next(f for f in out if f.kind == "spec")
    assert "await ensureAuthenticated(page);" in (spec_out.content or "")


def test_reorder_feature_entry_before_act_when_misplaced():
    spec = """\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';

test('x', async ({ page }) => {
  const pom = new EvidencePage(page);
  await test.step('0. Đăng nhập / authenticate', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('2. Act', async () => {
    await pom.submitForm();
  });
  await test.step('1. Feature entry', async () => {
    await pom.gotoFeature();
  });
});
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/Vat-chung/specs/reorder-entry.spec.ts",
            content=spec,
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Vat-chung/pages/evidence.page.ts",
            content=(
                "export class EvidencePage {\n"
                "  constructor(public page: any) {}\n"
                "  async gotoFeature() { await this.page.goto('/admin/evidence'); }\n"
                "  async submitForm() {}\n"
                "}\n"
            ),
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        enforce_journey=True,
        enforce_stubs=False,
        test_case_title="Hoàn tất tạo vật chứng",
    )
    spec_out = next(f for f in out if f.kind == "spec")
    body = spec_out.content or ""
    pos_feature = body.find("Feature entry")
    pos_act = body.find("Act")
    assert pos_feature >= 0 and pos_act >= 0
    assert pos_feature < pos_act


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
    out = apply_e2e_codegen_guards(
        files, test_case_title="Validation form", headed=True, enforce_journey=False
    )
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


def test_sync_async_path_helpers_and_promise_coercion():
    from app.services.e2e_codegen_guard import (
        _fix_promise_coercion_crashes,
        _sync_async_path_helpers,
    )

    page = (
        "export class EvidencePage {\n"
        "  async ensureUploadFixture(name: string): Promise<string> {\n"
        "    return `fixtures/${name}`;\n"
        "  }\n"
        "}\n"
        "export async function buildDocPath(n: string): Promise<string> {\n"
        "  return n;\n"
        "}\n"
    )
    synced = _sync_async_path_helpers(page)
    assert "async ensureUploadFixture" not in synced
    assert "ensureUploadFixture(name: string): string" in synced
    assert "export function buildDocPath" in synced

    spec = (
        "await page.setInputFiles('input[type=file]', pom.ensureUploadFixture('a.bin'));\n"
        "await expect(page.getByText(pom.expectUploadOk())).toBeVisible();\n"
        "await page.goto(pom.featurePath());\n"
        "await expect(page.getByText(labelText())).toBeVisible();\n"
    )
    from app.services.e2e_codegen_guard import _fix_nested_expect_on_pom_asserts

    fixed = _fix_promise_coercion_crashes(spec)
    fixed = _fix_nested_expect_on_pom_asserts(fixed)
    assert "await pom.ensureUploadFixture" in fixed or "setInputFiles('input[type=file]', await pom.ensureUploadFixture" in fixed
    assert "await pom.expectUploadOk()" in fixed
    assert "goto(await pom.featurePath())" in fixed
    # path helper must NOT become getByText(generated.bin)
    assert "getByText(await pom.ensureUploadFixture" not in fixed or "skipped getByText(pathHelper)" in fixed
    assert "getByText(await labelText())" in fixed


def test_promise_coercion_does_not_corrupt_object_entries_destructure():
    """1-arg setInputFiles must not span into `[key, val]` and inject `await val`."""
    from app.services.e2e_codegen_guard import (
        _fix_promise_coercion_crashes,
        _render_form_action_stub,
    )

    stub = _render_form_action_stub("addRelatedDocument")
    page = (
        "export class EvidencePage {\n"
        "  readonly page: any;\n"
        "  constructor(page: any) { this.page = page; }\n"
        + stub
        + "}\n"
    )
    fixed = _fix_promise_coercion_crashes(page)
    assert "await val" not in fixed
    assert "for (const [key, val] of Object.entries(data))" in fixed
    # single-arg helper call still gets await
    one = "await fileInput.setInputFiles(pom.ensureUploadFixture('a.bin'));\n"
    assert "await pom.ensureUploadFixture" in _fix_promise_coercion_crashes(one)


def test_path_helper_stub_is_sync_string():
    from app.services.e2e_codegen_guard import _render_smart_method_stub

    stub = _render_smart_method_stub("ensureRelatedDocFixture")
    assert "Promise<string>" not in stub
    assert "): string {" in stub
    fill = _render_smart_method_stub("fillTitle")
    assert 'input:not([type="hidden"])' not in fill
    assert "input[type=\\\"text\\\"]" in fill or 'input[type="text"]' in fill


def test_expect_stub_unpacks_object_args_not_object_object():
    from app.services.e2e_codegen_guard import (
        _render_smart_method_stub,
        _rewrite_expect_object_string_stubs,
    )

    stub = _render_smart_method_stub("expectPendingDocument")
    assert "__aitestVisibleTexts" in stub
    assert "for (const q of texts)" in stub
    assert "getByText(q, { exact: false })" in stub
    # R6 — no shell landmark as business proof
    assert 'main, [role="main"]' not in stub
    assert "BusinessAssertionFailed" in stub
    # Must not coerce whole object for locator text
    assert "getByText(String(raw)" not in stub
    assert ": String(raw);" not in stub

    old = """\
export class P {
  async expectPendingDocument(..._args: unknown[]): Promise<void> {
    const raw = _args.length ? _args[0] : undefined;
    const asStr = raw == null ? '' : String(raw);
    if (/fixtures[/\\\\]|\\.(bin|pdf)$/i.test(asStr)) {
      return;
    }
    const loc = raw instanceof RegExp
      ? this.page.getByText(raw).first()
      : (() => {
          const q = typeof raw === 'string' ? raw.trim()
            : raw == null ? ''
            : String(raw);
          return q
            ? this.page.getByText(q, { exact: false }).first()
            : this.page.locator('body').first();
        })();
    await expect(loc).toBeVisible({ timeout: 15000 });
  }
}
"""
    healed = _rewrite_expect_object_string_stubs(old)
    assert "__aitestVisibleTexts" in healed
    assert ": String(raw);" not in healed
    assert "getByText(String(raw)" not in healed


def test_rewrite_expect_stubs_strips_pom_landmark_fake():
    from app.services.e2e_codegen_guard import _rewrite_expect_object_string_stubs

    old = """\
export class P {
  async expectExpectedState(..._args: unknown[]): Promise<void> {
    const raw = _args.length ? _args[0] : undefined;
    const __aitestVisibleTexts = (raw: unknown): string[] => {
      if (typeof raw === 'string') return [raw.trim()].filter(Boolean);
      return [];
    };
    const texts = __aitestVisibleTexts(raw);
    if (!texts.length) {
      // No string payload — landmark only
      await expect(
        this.page.locator('main, [role="main"], h1, h2, [data-cy], [data-testid]').first()
      ).toBeVisible({ timeout: 15000 });
      return;
    }
    for (const q of texts) {
      await expect(this.page.getByText(q, { exact: false }).first())
        .toBeVisible({ timeout: 15000 });
    }
  }
}
"""
    healed = _rewrite_expect_object_string_stubs(old)
    assert 'main, [role="main"]' not in healed
    assert "BusinessAssertionFailed" in healed
    assert "__aitestVisibleTexts" in healed


def test_feature_nav_stub_fills_seed_before_next():
    from app.services.e2e_codegen_guard import _render_feature_nav_stub

    stub = _render_feature_nav_stub(
        "gotoFeatureAndOpenStep2", feature_path="/admin/evidence"
    )
    assert "const seed" in stub
    assert "wantsStep2" in stub
    assert "box.fill(seed)" in stub
    assert "/admin/evidence" in stub


def test_menu_nav_stub_idempotent_not_phase3_throw():
    from app.services.e2e_codegen_guard import (
        _is_menu_nav_method,
        _render_menu_nav_stub,
        _rewrite_ungrounded_nav_stubs,
        _render_feature_nav_stub,
    )

    assert _is_menu_nav_method("selectEvidenceMenu")
    stub = _render_menu_nav_stub("selectEvidenceMenu", feature_path="/admin/evidence")
    assert "ungrounded" not in stub.lower()
    assert "shell" in stub
    assert "E2E_FEATURE_PATH" in stub
    plain = _render_feature_nav_stub("gotoFeature", feature_path="/admin/evidence")
    assert "wantsCreate" in plain
    assert "if (wantsCreate || wantsStep2)" in plain

    page = """\
export class P {
  async selectEvidenceMenu(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `selectEvidenceMenu` — no DOM');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page, feature_path="/admin/evidence")
    assert "ungrounded" not in out.lower()
    assert "shell" in out


def test_create_open_stub_from_ungrounded():
    from app.services.e2e_codegen_guard import (
        _is_create_open_method,
        _rewrite_ungrounded_nav_stubs,
    )

    assert _is_create_open_method("clickCreateNew")
    page = """\
export class P {
  async clickCreateNew(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `clickCreateNew` — no DOM');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page)
    assert "ungrounded" not in out.lower()
    assert "getByTestId('entityCreateButton')" in out or "getByRole('button'" in out

def test_arrange_and_select_field_not_phase3_throw():
    from app.services.e2e_codegen_guard import (
        _is_field_fill_method,
        _is_select_field_method,
        _rewrite_ungrounded_nav_stubs,
        _render_field_fill_stub,
        _render_select_field_stub,
    )

    assert _is_field_fill_method("arrangeRequiredName")
    assert _is_select_field_method("selectStatus")
    assert not _is_select_field_method("selectEvidenceMenu")

    fill = _render_field_fill_stub("arrangeRequiredName")
    assert "getByLabel" in fill
    assert "pass fill value" in fill.lower() or "fail-closed" in fill.lower()

    sel = _render_select_field_stub("selectStatus")
    assert "combobox" in sel
    assert "pass option label" in sel.lower() or "fail-closed" in sel.lower()

    page = """\
export class P {
  async arrangeRequiredName(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `arrangeRequiredName` — no DOM');
  }
  async selectStatus(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `selectStatus` — no DOM');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page, feature_path="/admin/evidence")
    assert "arrangeRequiredName" in out
    assert "selectStatus" in out
    assert "getByLabel" in out or "combobox" in out
    assert "_args" in out

def test_complete_step_wizard_not_phase3_throw():
    from app.services.e2e_codegen_guard import (
        _is_wizard_next_method,
        _render_smart_method_stub,
        _rewrite_ungrounded_nav_stubs,
    )

    assert _is_wizard_next_method("completeStep1ToReachStep2")
    stub = _render_smart_method_stub("completeStep1ToReachStep2")
    assert "getByRole" in stub
    assert "Tiếp theo" in stub or "Next" in stub
    assert "console.warn" not in stub

    page = """\
export class P {
  async completeStep1ToReachStep2(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `completeStep1ToReachStep2` — no DOM');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page)
    assert "completeStep1ToReachStep2" in out


def test_open_combobox_search_not_phase3_throw():
    from app.services.e2e_codegen_guard import (
        _is_select_field_method,
        _render_smart_method_stub,
        _rewrite_ungrounded_nav_stubs,
    )

    assert _is_select_field_method("openCaseRecordComboboxSearch")
    stub = _render_smart_method_stub("openCaseRecordComboboxSearch")
    assert "combobox" in stub
    assert "pass option label" in stub.lower() or "fail-closed" in stub.lower()

    page = """\
export class P {
  async openCaseRecordComboboxSearch(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `openCaseRecordComboboxSearch` — no DOM');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page)
    assert "openCaseRecordComboboxSearch" in out
    assert "combobox" in out


def test_parse_import_entries_handles_type_modifier_and_orphan():
    from app.services.e2e_codegen_guard import _parse_import_entries, _parse_import_names

    entries = _parse_import_entries("EvidencePage, type Step2DocumentData")
    assert entries == [("EvidencePage", False), ("Step2DocumentData", True)]
    assert _parse_import_names("EvidencePage, type") == ["EvidencePage"]
    assert _parse_import_names("type") == []
    assert _parse_import_names("type Foo as Bar") == ["Bar"]


def test_align_imports_does_not_emit_orphan_type_keyword():
    import re

    from app.services.e2e_codegen_guard import _align_spec_imports_to_page

    page = """\
export type Step2DocumentData = { fileName: string };
export class EvidenceBackStep2RetainPage {
  constructor(page: Page) {}
}
"""
    spec = """\
import { WrongPage, type } from '../pages/evidence-back-step2-retain.page';
test('x', async ({ page }) => {
  const pom = new WrongPage(page);
});
"""
    out_spec, out_page = _align_spec_imports_to_page(
        spec, page, leaf_hint="evidence-back-step2-retain.page"
    )
    assert "import { EvidenceBackStep2RetainPage }" in out_spec or (
        "EvidenceBackStep2RetainPage" in out_spec and ", type }" not in out_spec
    )
    assert re.search(r"import\s*\{\s*[^}]*\btype\s*\}", out_spec) is None
    assert "export function type(" not in out_page


def test_renumber_spec_test_steps_continuous():
    import re

    from app.services.e2e_codegen_guard import renumber_spec_test_steps

    spec = """\
test('flow', async ({ page }) => {
  await test.step('0. Auth', async () => {});
  await test.step('1. Feature entry', async () => {});
  await test.step('2. Arrange', async () => {});
  await test.step('1. Act again', async () => {});
  await test.step('2. Assert', async () => {});
});
"""
    out = renumber_spec_test_steps(spec)
    titles = re.findall(r"test\.step\('([^']+)'", out)
    assert titles == [
        "0. Auth",
        "1. Feature entry",
        "2. Arrange",
        "3. Act again",
        "4. Assert",
    ]


def test_apply_guards_renumbers_and_fixes_orphan_type_import():
    import re as _re

    page = """\
/// <reference path="../types/playwright-shim.d.ts" />
import { expect, type Locator, type Page } from '@playwright/test';

export type Step2DocumentData = { fileName: string };

export class EvidenceBackStep2RetainPage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
  async gotoFeature(): Promise<void> {
    await this.page.goto('/admin/evidence', { waitUntil: 'domcontentloaded' });
  }
  async clickNext(): Promise<void> {
    await this.page.getByRole('button', { name: /tiếp theo/i }).click();
  }
}
"""
    spec = """\
/// <reference path="../types/playwright-shim.d.ts" />
import { test, expect } from '@playwright/test';
import { EvidenceBackStep2RetainPage, type } from '../pages/evidence-back-step2-retain.page';
import { ensureAuthenticated } from '../fixtures/auth.helper';

test('Quay lại', async ({ page }) => {
  const pom = new EvidenceBackStep2RetainPage(page);
  await test.step('0. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Feature entry — evidence', async () => {
    await pom.gotoFeature();
  });
  await test.step('1. Act click next', async () => {
    await pom.clickNext();
  });
  await test.step('2. Assert visible', async () => {
    await expect(page.getByRole('button', { name: /tiếp theo/i })).toBeVisible();
  });
});
"""
    files = apply_e2e_codegen_guards(
        [
            E2EFile(path="AItest/E2ETest/X/TC/specs/x.spec.ts", content=spec, kind="spec"),
            E2EFile(
                path="AItest/E2ETest/X/TC/pages/evidence-back-step2-retain.page.ts",
                content=page,
                kind="page",
            ),
        ],
        auth_mode="ui_helper",
        feature_path="/admin/evidence",
        headed=True,
    )
    out_spec = next(f.content for f in files if f.kind == "spec")
    assert ", type }" not in out_spec
    assert _re.search(r"import\s*\{\s*[^}]*\btype\s*\}", out_spec) is None
    titles = _re.findall(r"test\.step\('([^']+)'", out_spec)
    nums = [int(t.split(".", 1)[0]) for t in titles]
    assert nums == list(range(len(nums))), titles


def test_validate_required_context_accepts_execution_context_role():
    from app.services.e2e_codegen_guard import (
        E2EStrictGateError,
        _validate_required_context,
    )

    _validate_required_context(
        feature_path="/admin/rooms",
        auth_hints="authRole=admin; authRequired=true\nexpectedOutcome: list visible",
        mode="storage",
        locator_contract="testid:room-list",
    )
    try:
        _validate_required_context(
            feature_path="/admin/rooms",
            auth_hints="expectedOutcome: list visible",
            mode="storage",
            locator_contract="testid:room-list",
        )
        raise AssertionError("expected ContextMissing for role")
    except E2EStrictGateError as e:
        assert e.category == "ContextMissing"
        assert "role/authRef" in str(e)
        assert "authRole" in str(e)


def test_fix_playwright_shim_reference_from_spec_depth():
    from app.services.e2e_codegen_guard import fix_playwright_shim_reference

    spec_path = (
        "AItest/E2ETest/Create-evidence/TC-slug/specs/evidence-create-br1.spec.ts"
    )
    content = (
        '/// <reference path="../types/playwright-shim.d.ts" />\n'
        "import { test } from '@playwright/test';\n"
    )
    fixed = fix_playwright_shim_reference(content, spec_path)
    assert "../../../_shared/types/playwright-shim.d.ts" in fixed
    assert "../types/playwright-shim.d.ts" not in fixed


def test_rewrite_nested_aitest_imports_shared_page_sibling():
    from app.services.e2e_codegen_guard import rewrite_nested_aitest_imports

    page_path = "AItest/E2ETest/_shared/pages/evidence-create-br1.page.ts"
    content = (
        "import { EvidenceCreateBr4Page } from "
        "'../AItest/E2ETest/_shared/pages/evidence-create-br4.page';\n"
    )
    fixed = rewrite_nested_aitest_imports(content, page_path)
    assert "./evidence-create-br4.page" in fixed
    assert "AItest/E2ETest" not in fixed


def test_shell_next_button_not_main_body():
    from app.services.e2e_codegen_guard import (
        _ensure_locator_fields_for_spec_expects,
        _rewrite_shell_action_locators,
        apply_e2e_codegen_guards,
    )
    from app.llm.base import E2EFile

    page = """\
import { type Locator, type Page } from '@playwright/test';
export class EvidencePage {
  readonly page: Page;
  readonly nextButton: Locator;
  constructor(page: Page) {
    this.page = page;
    this.nextButton = this.page.locator('main, [role="main"], body').first();
  }
}
"""
    healed = _rewrite_shell_action_locators(page)
    assert 'main, [role="main"], body' not in healed
    assert "Tiếp theo" in healed or "Next" in healed
    assert "getByRole" in healed

    spec = """\
import { test, expect } from '@playwright/test';
import { EvidencePage } from '../pages/evidence.page';
test('step1 incomplete blocks step2', async ({ page }) => {
  const pom = new EvidencePage(page);
  await expect(pom.nextButton).toBeDisabled();
});
"""
    bare = """\
import { type Locator, type Page } from '@playwright/test';
export class EvidencePage {
  readonly page: Page;
  constructor(page: Page) {
    this.page = page;
  }
}
"""
    _, out_page = _ensure_locator_fields_for_spec_expects(spec, bare)
    assert 'main, [role="main"], body' not in out_page
    assert "this.nextButton =" in out_page
    assert "getByRole" in out_page

    out = apply_e2e_codegen_guards(
        [
            E2EFile(path="AItest/E2ETest/M/T/specs/a.spec.ts", content=spec, kind="spec"),
            E2EFile(path="AItest/E2ETest/M/T/pages/evidence.page.ts", content=page, kind="page"),
        ],
        enforce_journey=False,
    )
    page_out = next(f.content for f in out if f.kind == "page")
    assert 'locator(\'main, [role="main"], body\')' not in page_out
    assert "nextButton" in page_out


def test_act_stubs_throw_not_warn_return():
    from app.services.e2e_codegen_guard import _render_smart_method_stub
    from app.services.e2e_stub_grounding import render_ungrounded_fail_stub

    mystery = render_ungrounded_fail_stub("doMysteriousThing")
    assert "throw new Error" in mystery
    assert "console.warn" not in mystery

    click = _render_smart_method_stub("clickSave", dom_snapshot="")
    assert "throw new Error" in click
    assert "console.warn" not in click

    leave = _render_smart_method_stub("leaveRequiredStep1FieldEmpty", dom_snapshot="")
    assert "#field_name" in leave
    assert "fill('')" in leave
    assert "console.warn" not in leave

    blocked = _render_smart_method_stub(
        "expectStep1IncompleteBlocksStep2", dom_snapshot=""
    )
    assert "toBeDisabled" in blocked
    assert "BusinessAssertionFailed" not in blocked
    assert "Tiếp theo" in blocked or "Next" in blocked

    allowed = _render_smart_method_stub("expectCompletionAllowed", dom_snapshot="")
    assert "BusinessAssertionFailed" in allowed
    assert "toBeDisabled" not in allowed

    wizard = _render_smart_method_stub("clickGoToStep2", dom_snapshot="")
    assert "getByRole" in wizard
    assert "console.warn" not in wizard
    assert "Tiếp theo" in wizard or "Next" in wizard

