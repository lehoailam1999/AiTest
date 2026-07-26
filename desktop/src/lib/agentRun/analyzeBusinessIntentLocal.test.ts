import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { analyzeBusinessIntentLocal } from "./analyzeBusinessIntentLocal.ts";
import type { TestCase } from "../../api/types";

function tc(partial: Partial<TestCase> & Pick<TestCase, "title">): TestCase {
  return {
    id: "1",
    projectId: "p",
    testCaseId: "TC-1",
    title: partial.title,
    type: "Functional",
    priority: "P1",
    severity: "Major",
    steps: partial.steps ?? "",
    expectedResult: partial.expectedResult ?? "",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: new Date().toISOString(),
    module: partial.module,
    ...partial,
  };
}

describe("analyzeBusinessIntentLocal", () => {
  it("extracts Create + Evidence from VN title", () => {
    const intent = analyzeBusinessIntentLocal(
      tc({
        title: "Tạo vật chứng thành công",
        expectedResult: "Lưu thành công\nSinh mã vật chứng",
      })
    );
    assert.equal(intent.action, "Create");
    assert.ok(intent.searchHints.some((h) => /Evidence|chứng|Service/i.test(h)));
    assert.ok(intent.expectedResults.length >= 1);
  });
});
