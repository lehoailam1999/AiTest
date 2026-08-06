import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  checkE2eArtifactsSyntax,
  formatE2eSyntaxGateError,
  hasFakeBusinessAssert,
} from "./e2eSyntaxGate.js";

describe("e2eSyntaxGate R9", () => {
  it("accepts balanced Spec", () => {
    const issues = checkE2eArtifactsSyntax([
      {
        path: "AItest/E2ETest/M/specs/ok.spec.ts",
        kind: "spec",
        content: `test('x', async ({ page }) => {
  await test.step('1. Act', async () => {
    await expect(page.getByText('ok')).toBeVisible();
  });
});
`,
      },
    ]);
    assert.equal(issues.length, 0);
  });

  it("rejects brace imbalance", () => {
    const issues = checkE2eArtifactsSyntax([
      {
        path: "AItest/E2ETest/M/specs/bad.spec.ts",
        kind: "spec",
        content: `test('x', async ({ page }) => {
  await test.step('1. Act', async () => {
    await pom.click();
  );
});
`,
      },
    ]);
    assert.ok(issues.length >= 1);
    assert.match(formatE2eSyntaxGateError(issues), /R9|brace|paren/i);
  });

  it("rejects R6 fake heal markers", () => {
    assert.equal(
      hasFakeBusinessAssert(`
    // Business assertion (auto-healed — Rule 24)
    await expect(page.locator('main, [role="main"], nav, h1').first()).toBeVisible();
`),
      true
    );
    const issues = checkE2eArtifactsSyntax([
      {
        path: "specs/x.spec.ts",
        kind: "spec",
        content: `// Business assertion (auto-healed)
await expect(page.locator('main, [role="main"], nav, h1').first()).toBeVisible();
`,
      },
    ]);
    assert.ok(issues.some((i) => /fake assert|R6/i.test(i.detail)));
    assert.match(formatE2eSyntaxGateError(issues), /R6/);
    // Feature-entry waitFor(main) alone is NOT fake BR
    assert.equal(
      hasFakeBusinessAssert(
        `await page.locator('main, [role="main"], nav, h1').first().waitFor({ state: 'visible' });`
      ),
      false
    );
    // POM this.page expectExpectedState landmark is NOT Spec fake-heal (R6 gate on Specs only)
    assert.equal(
      hasFakeBusinessAssert(`
    if (!texts.length) {
      await expect(
        this.page.locator('main, [role="main"], h1, h2, [data-cy], [data-testid]').first()
      ).toBeVisible({ timeout: 15000 });
    }
`),
      false
    );
    const pageIssues = checkE2eArtifactsSyntax([
      {
        path: "_shared/pages/x.page.ts",
        kind: "page",
        content: `
  async expectExpectedState(..._args: unknown[]): Promise<void> {
    await expect(
      this.page.locator('main, [role="main"], h1, h2').first()
    ).toBeVisible({ timeout: 15000 });
  }
`,
      },
    ]);
    assert.equal(pageIssues.length, 0);
  });
});
