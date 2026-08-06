"""Phase 2 — Auth → Feature entry → Act enforce."""

from __future__ import annotations

import pytest

from app.llm.base import E2EFile
from app.services.e2e_codegen_guard import (
    E2ECodegenJourneyError,
    apply_e2e_codegen_guards,
    inject_feature_entry_step,
)
from app.services.e2e_journey_enforce import (
    spec_has_act_phase,
    spec_has_feature_entry,
    validate_feature_journey_order,
)


def test_heal_feature_before_auth_step_order():
    from app.services.e2e_journey_enforce import heal_feature_journey_order

    messed = """\
import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await test.step('0. Feature entry', async () => {
    await page.goto('/admin/case-record');
  });
  await test.step('1. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('2. Search', async () => {
    await pom.search();
  });
});
"""
    fixed = heal_feature_journey_order(messed)
    assert fixed.index("ensureAuthenticated") < fixed.lower().index("feature entry")
    assert validate_feature_journey_order(fixed, mode="ui_helper") == []


def test_heal_early_page_goto_before_auth():
    from app.services.e2e_journey_enforce import heal_feature_journey_order

    messed = """\
import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await page.goto('/admin/case-record');
  await ensureAuthenticated(page);
  await pom.search();
});
"""
    fixed = heal_feature_journey_order(messed)
    assert fixed.index("ensureAuthenticated") < fixed.index("page.goto")
    # page.goto still counts as feature entry after auth
    assert validate_feature_journey_order(fixed, mode="ui_helper") == []


def test_guards_heal_feature_before_auth_and_pass():
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/specs/search.spec.ts",
            content="""\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { CasePage } from '../pages/case.page';
test('search', async ({ page }) => {
  await test.step('0. Feature entry', async () => {
    await page.goto('/admin/case-record');
  });
  await test.step('1. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('2. Search', async () => {
    const pom = new CasePage(page);
    await pom.search();
    await pom.expectRowVisible();
  });
});
""",
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/pages/case.page.ts",
            content="export class CasePage { async search() {} async expectRowVisible() {} }",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        test_case_title="Tìm kiếm hồ sơ",
        feature_path="/admin/case-record",
        enforce_journey=True,
    )
    spec = next(f for f in out if f.kind == "spec")
    assert spec.content.index("ensureAuthenticated") < spec.content.lower().index(
        "feature entry"
    )


def test_auth_step_re_does_not_match_bare_zero_feature_entry():
    """Regression: ``0. Feature entry`` must not count as Auth phase position."""
    spec = """\
import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await test.step('0. Feature entry', async () => {
    await page.goto('/x');
  });
  await test.step('1. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('2. Upload file', async () => {
    await pom.selectFile();
  });
});
"""
    errs = validate_feature_journey_order(spec, mode="ui_helper")
    assert any("Auth must come before Feature entry" in e for e in errs)


def test_goto_feature_inside_named_step_is_not_act_before_entry():
    """gotoFeature inside a step must not make Act position before Feature entry."""
    spec = """\
import { test } from '@playwright/test';
test('t', async ({ page }) => {
  await test.step('0. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Mở luồng thêm tài liệu', async () => {
    await pom.gotoFeature();
    await pom.openCreateModal();
  });
  await test.step('2. Upload', async () => {
    await pom.selectFile();
  });
});
"""
    assert validate_feature_journey_order(spec, mode="ui_helper") == []


def test_reorder_feature_entry_after_auth():
    from app.services.e2e_codegen_guard import (
        inject_feature_entry_step,
        _reorder_feature_entry_after_auth,
    )

    messed = """\
test('t', async ({ page }) => {
  await test.step('0. Feature entry', async () => {
    const baked = "/x";
    await page.goto('/x');
  });
  await test.step('1. Auth — ensureAuthenticated', async () => {
    await ensureAuthenticated(page);
  });
  await pom.act();
});
"""
    fixed = _reorder_feature_entry_after_auth(messed)
    assert fixed.index("ensureAuthenticated") < fixed.index("Feature entry")
    assert validate_feature_journey_order(fixed, mode="ui_helper") == []
    # inject path also repairs
    again = inject_feature_entry_step(messed, feature_path="/x", require_auth_call=False)
    assert again.index("ensureAuthenticated") < again.lower().index("feature entry")


def test_inject_feature_entry_when_bare_page_goto_path():
    """Regression: page.goto(path) must not block Feature entry inject (Phase 2)."""
    spec = """\
import { test } from '@playwright/test';
import { RelatedPage } from '../pages/related.page';

test('add related', async ({ page }) => {
  const path = '/admin/evidence';
  await page.goto(path);
  const pom = new RelatedPage(page);
  await pom.openAddRelated();
});
"""
    out = inject_feature_entry_step(spec, feature_path="/admin/evidence", require_auth_call=False)
    assert "Feature entry" in out
    assert out.index("Feature entry") < out.index("openAddRelated")
    errs = validate_feature_journey_order(out, mode="storage")
    assert errs == []


def test_final_feature_entry_pass_without_ensure_auth():
    """Verify/storage leftovers: Feature entry injects even without ensureAuthenticated."""
    from app.llm.base import E2EFile
    from app.services.e2e_codegen_guard import apply_e2e_codegen_guards

    files = [
        E2EFile(
            path="AItest/E2ETest/Req/TC/specs/x.spec.ts",
            content="""\
import { test } from '@playwright/test';
import { DocPage } from '../../../_shared/pages/doc.page';
test('x', async ({ page }) => {
  const pom = new DocPage(page);
  await pom.openAdd();
});
""",
            kind="spec",
        )
    ]
    out = apply_e2e_codegen_guards(
        files,
        use_storage=False,
        enforce_journey=True,
        enforce_stubs=False,
        feature_path="/admin/evidence",
        test_case_title="[E2E-Auth/Permission] Phiên đã xác thực — mở luồng",
    )
    spec = next(f for f in out if f.path.endswith(".spec.ts"))
    assert "Feature entry" in (spec.content or "")


def test_inject_feature_entry_even_when_auth_already_present():
    spec = """\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';

test('upload', async ({ page }) => {
  await ensureAuthenticated(page);
  const pom = new EvidencePage(page);
  await pom.clickUpload();
});
"""
    out = inject_feature_entry_step(spec, feature_path="/evidence", require_auth_call=True)
    assert "Feature entry" in out
    assert "E2E_FEATURE_PATH" in out
    assert "/evidence" in out
    # Baked path wins over suite env (batch Verify)
    assert "const baked =" in out
    assert "baked || process.env.E2E_FEATURE_PATH" in out
    # Act still after entry
    assert out.index("Feature entry") < out.index("clickUpload")


def test_inject_feature_entry_storage_mode_without_ensure():
    spec = """\
import { test } from '@playwright/test';
import { EvidencePage } from '../pages/evidence.page';

test('list', async ({ page }) => {
  const pom = new EvidencePage(page);
  await pom.gotoList();
});
"""
    out = inject_feature_entry_step(spec, feature_path="/evidence", require_auth_call=False)
    assert "Feature entry" in out
    assert out.index("Feature entry") < out.index("gotoList")


def test_validate_missing_act_fails():
    spec = """\
test('x', async ({ page }) => {
  await test.step('0. Đăng nhập / authenticate', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Feature entry', async () => {
    await page.goto('/evidence');
  });
});
"""
    errs = validate_feature_journey_order(spec, mode="ui_helper")
    assert any("Act" in e for e in errs)


def test_validate_good_order_ok():
    spec = """\
test('x', async ({ page }) => {
  await test.step('0. Đăng nhập / authenticate', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Feature entry', async () => {
    await page.goto('/evidence');
  });
  await test.step('2. Upload', async () => {
    await page.getByRole('button', { name: 'Upload' }).click();
  });
});
"""
    assert validate_feature_journey_order(spec, mode="ui_helper") == []
    assert spec_has_feature_entry(spec)
    assert spec_has_act_phase(spec)


def test_guards_fail_codegen_when_only_auth():
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/specs/empty.spec.ts",
            content="""\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
test('noop', async ({ page }) => {
  await ensureAuthenticated(page);
});
""",
            kind="spec",
        )
    ]
    with pytest.raises(E2ECodegenJourneyError, match="Phase 2"):
        apply_e2e_codegen_guards(
            files,
            test_case_title="Upload evidence",
            enforce_journey=True,
        )


def test_guards_inject_entry_and_pass_with_act():
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/specs/upload.spec.ts",
            content="""\
import { test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';
test('upload', async ({ page }) => {
  await ensureAuthenticated(page);
  const pom = new EvidencePage(page);
  await pom.clickUpload();
  await pom.expectRowVisible();
});
""",
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/pages/evidence.page.ts",
            content="export class EvidencePage { async clickUpload() {} async expectRowVisible() {} }",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        test_case_title="Upload evidence",
        feature_path="/evidence",
        enforce_journey=True,
    )
    spec = next(f for f in out if f.kind == "spec")
    assert "Feature entry" in spec.content
    assert spec.content.index("Feature entry") < spec.content.index("clickUpload")


def test_pom_expect_counts_as_business_assertion():
    from app.services.e2e_journey_enforce import validate_feature_journey_order

    spec = """\
test('x', async ({ page }) => {
  await test.step('0. Đăng nhập / authenticate', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Feature entry', async () => {
    await page.goto('/evidence');
  });
  await test.step('2. Upload', async () => {
    await pom.selectFile();
    await pom.expectRowVisible();
  });
});
"""
    assert (
        validate_feature_journey_order(
            spec, mode="ui_helper", enforce_business_assertions=True
        )
        == []
    )


def test_heal_injects_assert_into_act_without_expect():
    from app.services.e2e_journey_enforce import (
        heal_missing_business_assertions,
        validate_feature_journey_order,
    )

    spec = """\
import { expect, test } from '@playwright/test';
test('x', async ({ page }) => {
  await test.step('0. Đăng nhập / authenticate', async () => {
    await ensureAuthenticated(page);
  });
  await test.step('1. Feature entry', async () => {
    await page.goto('/evidence');
  });
  await test.step('2. Upload', async () => {
    await page.getByRole('button', { name: 'Upload' }).click();
  });
});
"""
    healed = heal_missing_business_assertions(
        spec, expected_hint="expected: file uploaded successfully"
    )
    assert "Business assertion (auto-healed" in healed
    assert "toBeVisible" in healed
    assert "file uploaded successfully" in healed or "file uploaded" in healed.lower() or "RegExp" in healed
    assert (
        validate_feature_journey_order(
            healed, mode="ui_helper", enforce_business_assertions=True
        )
        == []
    )


def test_strict_gate_heals_before_business_assert_enforce():
    files = [
        E2EFile(
            path="AItest/E2ETest/Mod/specs/upload.spec.ts",
            content="""\
import { expect, test } from '@playwright/test';
import { ensureAuthenticated } from '../fixtures/auth.helper';
import { EvidencePage } from '../pages/evidence.page';
test('upload', async ({ page }) => {
  await ensureAuthenticated(page);
  const pom = new EvidencePage(page);
  await test.step('2. Upload', async () => {
    await pom.clickUpload();
  });
});
""",
            kind="spec",
        ),
        E2EFile(
            path="AItest/E2ETest/Mod/pages/evidence.page.ts",
            content="export class EvidencePage { async clickUpload() {} }",
            kind="page",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        test_case_title="Upload evidence",
        feature_path="/evidence",
        auth_hints="role: Investigator\nlandmark: evidence page\nexpected: upload done",
        strict_gate=True,
        enforce_journey=True,
    )
    spec = next(f for f in out if f.kind == "spec").content
    assert "Business assertion (auto-healed" in spec
    assert "toBeVisible" in spec