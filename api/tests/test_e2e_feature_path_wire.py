"""Step 1 wire — feature_path from API body bakes into Feature entry."""

from __future__ import annotations

from app.llm.base import E2EFile, E2ERequest
from app.services.e2e_codegen_guard import (
    apply_e2e_codegen_guards,
    inject_feature_entry_step,
)


def test_inject_prefers_baked_over_env():
    spec = """\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../helpers/auth.helper';

test('x', async ({ page }) => {
  await ensureAuthenticated(page);
  await page.getByRole('button', { name: 'Save' }).click();
});
"""
    out = inject_feature_entry_step(spec, feature_path="/owners", require_auth_call=True)
    assert 'const baked = "/owners"' in out
    assert "baked || process.env.E2E_FEATURE_PATH" in out
    assert "process.env.E2E_FEATURE_PATH || baked" not in out
    assert "(process.env.E2E_FEATURE_PATH ||" not in out


def test_apply_guards_bakes_request_feature_path():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/specs/t.spec.ts",
            kind="spec",
            content="""\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../helpers/auth.helper';
import { OwnerPage } from '../pages/owner.page';

test('create owner', async ({ page }) => {
  await test.step('0. Auth', async () => {
    await ensureAuthenticated(page);
  });
  const pom = new OwnerPage(page);
  await pom.openForm();
});
""",
        ),
        E2EFile(
            path="AItest/E2ETest/M/pages/owner.page.ts",
            kind="page",
            content="""\
export class OwnerPage {
  constructor(private page: import('@playwright/test').Page) {}
  async openForm() {
    await this.page.getByRole('button', { name: /Thêm/i }).click();
  }
}
""",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        use_storage=False,
        test_case_title="create owner",
        feature_path="/asset-owners",
        enforce_journey=True,
        enforce_stubs=False,
    )
    spec = next(f for f in out if f.kind == "spec").content
    assert "Feature entry" in spec
    assert "/asset-owners" in spec
    assert "baked || process.env.E2E_FEATURE_PATH" in spec


def test_e2e_request_accepts_feature_path_field():
    req = E2ERequest(
        test_case_title="t",
        test_case_type="E2E",
        priority="Medium",
        steps="1. Open",
        expected_result="ok",
        feature_path="/evidence",
    )
    assert req.feature_path == "/evidence"
