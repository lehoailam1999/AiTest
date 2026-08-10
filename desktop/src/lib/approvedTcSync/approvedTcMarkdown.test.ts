import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvedTcMarkdownRelPath,
  buildApprovedTcMarkdownFiles,
  renderApprovedTestCaseMarkdown,
} from "./approvedTcMarkdown.js";
import type { TestCase } from "../../api/types";

function sample(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "p1",
    testCaseId: "TC-LOGIN-01",
    title: "Login happy path",
    module: "account",
    type: "E2E",
    priority: "High",
    severity: "Major",
    precondition: "User exists",
    steps: "1. Open /login\n2. Submit",
    expectedResult: "Dashboard visible",
    testData: "admin/admin",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("approvedTcMarkdown", () => {
  it("builds path under .ai-test/test-cases", () => {
    const p = approvedTcMarkdownRelPath(sample());
    assert.equal(p, ".ai-test/test-cases/account/TC-LOGIN-01.md");
  });

  it("skips non-Approved", () => {
    const files = buildApprovedTcMarkdownFiles([
      sample({ reviewStatus: "Draft" }),
      sample({ reviewStatus: "Approved", testCaseId: "TC-2" }),
    ]);
    assert.equal(files.length, 1);
    assert.match(files[0].content, /Login happy path/);
    assert.match(files[0].content, /## Steps/);
  });

  it("render includes frontmatter", () => {
    const md = renderApprovedTestCaseMarkdown(sample());
    assert.match(md, /^---\n/);
    assert.match(md, /testCaseId: TC-LOGIN-01/);
    assert.match(md, /reviewStatus: Approved/);
  });
});
