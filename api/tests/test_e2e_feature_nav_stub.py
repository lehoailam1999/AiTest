"""Feature entry conflicts — nav stubs must not stay Phase-3 ungrounded throws."""

from __future__ import annotations

from app.llm.base import E2EFile
from app.services.e2e_codegen_guard import (
    _rewrite_ungrounded_nav_stubs,
    apply_e2e_codegen_guards,
    inject_feature_entry_step,
)


def test_inject_feature_entry_despite_pom_goto_feature_name():
    """Naming pom.gotoFeature* must NOT block page.goto Feature entry inject."""
    spec = """\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';

test('x', async ({ page }) => {
  await ensureAuthenticated(page);
  const pom = new EvidencePage(page);
  await pom.gotoFeatureAndOpenStep2();
});
"""
    out = inject_feature_entry_step(spec, feature_path="/admin/evidence", require_auth_call=True)
    assert "Feature entry" in out
    assert "page.goto" in out
    assert "/admin/evidence" in out


def test_rewrite_ungrounded_goto_feature_stub():
    page = """\
export class EvidencePage {
  constructor(private page: import('@playwright/test').Page) {}
  async gotoFeatureAndOpenStep2(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `gotoFeatureAndOpenStep2` — no DOM selector_candidates; regenerate after Inspect');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page, feature_path="/admin/evidence")
    assert "ungrounded" not in out
    assert "E2E_FEATURE_PATH" in out
    assert "/admin/evidence" in out
    assert "this.page.goto" in out
    assert "this.this.page" not in out


def test_feature_nav_stub_requires_path_no_baked_sidebar():
    from app.services.e2e_codegen_guard import _render_feature_nav_stub

    stub = _render_feature_nav_stub("gotoFeature", feature_path="")
    assert "E2E_FEATURE_PATH" in stub
    assert "ensureAppNavOpen" not in stub
    assert "data-sidebar" not in stub
    assert "mở menu" not in stub
    with_path = _render_feature_nav_stub("gotoFeature", feature_path="/admin/evidence")
    assert "this.page.goto" in with_path
    assert "/admin/evidence" in with_path
    assert "ensureAppNavOpen" not in with_path
    assert "const seed" in with_path


def test_rewrite_ungrounded_add_related_document():
    page = """\
export class EvidencePage {
  constructor(private page: import('@playwright/test').Page) {}
  async addRelatedDocument(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `addRelatedDocument` — no DOM selector_candidates; regenerate after Inspect');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page, feature_path="/admin/evidence")
    assert "ungrounded" not in out
    assert "setInputFiles" in out
    assert "filePath" in out


def test_apply_guards_rewrites_nav_throw_on_verify_style():
    files = [
        E2EFile(
            path="AItest/E2ETest/M/specs/t.spec.ts",
            kind="spec",
            content="""\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';
test('x', async ({ page }) => {
  await test.step('0. Auth', async () => { await ensureAuthenticated(page); });
  const pom = new EvidencePage(page);
  await pom.gotoFeatureAndOpenStep2();
});
""",
        ),
        E2EFile(
            path="AItest/E2ETest/M/pages/evidence.page.ts",
            kind="page",
            content="""\
export class EvidencePage {
  constructor(private page: import('@playwright/test').Page) {}
  async gotoFeatureAndOpenStep2(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `gotoFeatureAndOpenStep2` — no DOM');
  }
}
""",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        feature_path="/admin/evidence",
        enforce_stubs=False,
        enforce_journey=False,
        use_storage=False,
        test_case_title="feature tc",
    )
    page = next(f for f in out if f.kind == "page").content
    assert "ungrounded" not in page
    assert "this.page.goto" in page
