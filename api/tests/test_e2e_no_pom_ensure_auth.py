"""ensureAuthenticated must not be stubbed onto POM — auth.helper only."""

from __future__ import annotations

from app.services.e2e_codegen_guard import fix_page_method_contract


def test_rewrites_pom_ensure_authenticated_to_helper():
    spec = """\
import { test } from '@playwright/test';
import { EvidencePage } from '../pages/evidence.page';

test('x', async ({ page }) => {
  const pom = new EvidencePage(page);
  await pom.ensureAuthenticated();
  await pom.goNextFromStep1();
});
"""
    page = """\
export class EvidencePage {
  constructor(private page: import('@playwright/test').Page) {}
  async goNextFromStep1() {
    await this.page.getByRole('button', { name: /Tiếp/i }).click();
  }
}
"""
    out_spec, out_page = fix_page_method_contract(spec, page, dom_snapshot="")
    assert "pom.ensureAuthenticated" not in out_spec
    assert "ensureAuthenticated(page)" in out_spec
    assert "auth.helper" in out_spec
    assert "async ensureAuthenticated" not in out_page
