import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestCase } from "../../api/types";
import { buildUnitApproveTcIr } from "./buildTcIr";

function sample(testData: string): TestCase {
  return {
    id: "tc-db-1",
    projectId: "project-1",
    sourceId: "req-1",
    testCaseId: "TC-U-1",
    title: "Từ chối mô tả rỗng",
    module: "Danh mục",
    type: "Unit",
    priority: "High",
    severity: "Major",
    precondition: "Có danh mục",
    steps: "1. Chuẩn bị command\n2. Gọi handler",
    expectedResult: "Ném validation error",
    testData,
    automationReady: false,
    isAiGenerated: true,
    reviewStatus: "Draft",
    executionStatus: "NotRun",
    createdAt: "2026-08-16T00:00:00Z",
  };
}

describe("buildUnitApproveTcIr", () => {
  it("parses structured Unit markers into READY_FOR_GROUNDING IR", () => {
    const ir = buildUnitApproveTcIr(
      sample(
        [
          "status: READY_FOR_GROUNDING",
          "primaryBucket: VALIDATION_DATA",
          "behaviorId: VAL-DESC",
          "scenario: EMPTY",
          "target.field: moTa; maMuc",
          "target.scope: multi",
          "target.constraint: required",
          'input: {"moTa":"","maMuc":"A"}',
        ].join("\n")
      ),
      { requirementTitle: "Quản lý danh mục" }
    );

    assert.equal(ir.readiness, "READY_FOR_GROUNDING");
    assert.equal(ir.primaryBucket, "VALIDATION_DATA");
    assert.equal(ir.scenario, "EMPTY");
    assert.deepEqual(ir.testData.target?.fields, ["moTa", "maMuc"]);
    assert.equal(ir.testData.target?.scope, "multi");
    assert.deepEqual(ir.testData.input, { moTa: "", maMuc: "A" });
    assert.equal(ir.requirement.title, "Quản lý danh mục");
  });

  it("fails closed when the TC never went through Unit analysis", () => {
    assert.throws(
      () => buildUnitApproveTcIr(sample("primaryBucket: VALIDATION_DATA")),
      /no status marker/
    );
  });

  it("stays re-resolvable after Approve stamped its own outcome", () => {
    for (const status of ["NOT_READY", "FEATURE_GAP", "READY_FOR_CODEGEN"]) {
      const ir = buildUnitApproveTcIr(sample(`status: ${status}`));
      assert.equal(ir.readiness, "READY_FOR_GROUNDING");
    }
  });
});
