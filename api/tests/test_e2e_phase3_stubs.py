"""Phase 3 — DOM-grounded POM stubs; empty fake-pass forbidden."""

from __future__ import annotations

import json

from app.llm.base import E2EFile
from app.services.e2e_codegen_guard import (
    _render_smart_method_stub,
    apply_e2e_codegen_guards,
)
from app.services.e2e_stub_grounding import (
    assert_no_empty_pass_stubs,
    best_element_for_method,
    find_empty_pass_methods,
    locator_expr_from_element,
    parse_dom_elements,
)


DOM = json.dumps(
    {
        "elements": [
            {
                "tag": "button",
                "role": "button",
                "name": "Upload",
                "testId": "upload-btn",
                "selector_candidates": [
                    'getByTestId("upload-btn")',
                    'getByRole("button", { name: "Upload" })',
                ],
            },
            {
                "tag": "input",
                "role": "textbox",
                "name": "Title",
                "placeholder": "Title",
                "type": "text",
                "selector_candidates": [
                    'getByPlaceholder("Title")',
                    'getByRole("textbox", { name: "Title" })',
                ],
            },
            {
                "tag": "table",
                "testId": "evidence-table",
                "name": "Evidence",
                "selector_candidates": ['getByTestId("evidence-table")'],
            },
        ]
    }
)


def test_match_click_upload_to_dom():
    els = parse_dom_elements(DOM)
    el = best_element_for_method("clickUpload", els)
    assert el is not None
    assert el.get("testId") == "upload-btn"
    loc = locator_expr_from_element(el)
    assert loc and "getByTestId" in loc


def test_render_stub_uses_selector_candidates():
    stub = _render_smart_method_stub("clickUpload", dom_snapshot=DOM)
    assert "Phase 3" in stub
    assert "getByTestId" in stub or "upload-btn" in stub
    assert "throw new Error" not in stub
    fill = _render_smart_method_stub("fillTitle", dom_snapshot=DOM)
    assert "getByPlaceholder" in fill or "Title" in fill


def test_empty_stub_fail_closed_when_no_dom():
    """Unknown Act verbs without DOM/Spec → Phase-3 ungrounded (E2E_GROUNDING fail-closed)."""
    stub = _render_smart_method_stub("doMysteriousThing", dom_snapshot="")
    assert "Promise<void>" in stub
    assert "ungrounded" in stub.lower()
    assert "throw new Error" in stub
    assert "button').first()" not in stub.replace(" ", "")
    assert "locator('button" not in stub


def test_complete_step_wizard_not_ungrounded():
    from app.services.e2e_codegen_guard import (
        _is_wizard_next_method,
        _rewrite_ungrounded_nav_stubs,
    )

    assert _is_wizard_next_method("completeStep1ToReachStep2")
    stub = _render_smart_method_stub("completeStep1ToReachStep2", dom_snapshot="")
    # P1: requires Spec label — stub gates on _args (not invent Next regex)
    assert "_args" in stub
    assert "getByRole" in stub

    page = """\
export class P {
  async completeStep1ToReachStep2(..._args: unknown[]): Promise<void> {
    throw new Error('Phase 3: ungrounded POM stub `completeStep1ToReachStep2` — no DOM selector_candidates; regenerate after Inspect');
  }
}
"""
    out = _rewrite_ungrounded_nav_stubs(page, feature_path="/admin/evidence")
    assert "completeStep1ToReachStep2" in out
    assert "_args" in out
    assert "getByRole" in out


def test_apply_guards_reheals_ungrounded_after_empty_enforce():
    """assert_no_empty_pass injects throws; apply_guards must soft-rewrite afterward."""
    page = """\
import { Page } from '@playwright/test';
export class EvidencePage {
  constructor(public page: Page) {}
  async completeStep1ToReachStep2(): Promise<void> {
  }
}
"""
    files = [
        E2EFile(
            path="AItest/E2ETest/M/pages/evidence.page.ts",
            content=page,
            kind="page",
        )
    ]
    out = apply_e2e_codegen_guards(
        files,
        dom_snapshot="",
        enforce_stubs=True,
        enforce_journey=False,
        feature_path="/admin/evidence",
    )
    content = out[0].content
    assert "completeStep1ToReachStep2" in content
    # Rewritten to arg-gated stub (or DOM) — not empty pass
    assert "Promise<void>" in content
    assert "_args" in content or "getByRole" in content or "getByTestId" in content


def test_rewrite_empty_methods_from_dom():
    page = """\
export class EvidencePage {
  constructor(public page: import('@playwright/test').Page) {}
  async clickUpload(): Promise<void> {
  }
  async expectEvidenceTable(): Promise<void> {
    // TODO
  }
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/M/pages/evidence.page.ts", content=page, kind="page")
    ]
    assert_no_empty_pass_stubs(files, dom_snapshot=DOM)
    out = files[0].content
    assert "getByTestId" in out or "upload-btn" in out
    assert find_empty_pass_methods(out) == []


def test_guards_fail_closed_empty_when_no_dom():
    """Empty body → ungrounded throw when no DOM (E2E_GROUNDING); not invent button.first()."""
    page = """\
export class XPage {
  constructor(public page: any) {}
  async weirdAction(): Promise<void> {}
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/M/pages/x.page.ts", content=page, kind="page"),
        E2EFile(
            path="AItest/E2ETest/M/specs/x.spec.ts",
            content=(
                "import { test } from '@playwright/test';\n"
                "import { XPage } from '../pages/x.page';\n"
                "test('t', async ({ page }) => {\n"
                "  const pom = new XPage(page);\n"
                "  await pom.weirdAction();\n"
                "});\n"
            ),
            kind="spec",
        ),
    ]
    out = apply_e2e_codegen_guards(
        files,
        test_case_title="Feature weird",
        enforce_journey=False,
        enforce_stubs=True,
    )
    page_out = next(f for f in out if f.kind == "page")
    assert "ungrounded" in page_out.content.lower()
    assert find_empty_pass_methods(page_out.content) == []
    assert "weirdAction" in page_out.content
    assert "locator('button" not in page_out.content


def test_guards_ground_missing_method_from_dom():
    spec = """\
import { test } from '@playwright/test';
import { EvidencePage } from '../pages/evidence.page';
test('up', async ({ page }) => {
  const pom = new EvidencePage(page);
  await pom.clickUpload();
});
"""
    page = """\
export class EvidencePage {
  constructor(public page: import('@playwright/test').Page) {}
}
"""
    files = [
        E2EFile(path="AItest/E2ETest/M/pages/evidence.page.ts", content=page, kind="page"),
        E2EFile(path="AItest/E2ETest/M/specs/up.spec.ts", content=spec, kind="spec"),
    ]
    out = apply_e2e_codegen_guards(
        files,
        dom_snapshot=DOM,
        test_case_title="Upload evidence",
        feature_path="/evidence",
        enforce_journey=True,
        enforce_stubs=True,
    )
    page_out = next(f for f in out if f.kind == "page")
    assert "clickUpload" in page_out.content
    assert "Phase 3" in page_out.content
    assert "upload-btn" in page_out.content or "getByTestId" in page_out.content
