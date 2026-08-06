/**
 * Phase 6 — unit failure taxonomy tests.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateUnitMetrics,
  buildUnitRepairContext,
  classifyUnitFailure,
} from "./unitFailureMetrics.js";

describe("classifyUnitFailure", () => {
  it("detects import / compile / assert", () => {
    assert.equal(
      classifyUnitFailure("Error: Cannot find module './foo'"),
      "ImportError"
    );
    assert.equal(classifyUnitFailure("error TS2304: Cannot find name"), "CompileError");
    assert.equal(
      classifyUnitFailure("AssertionError: expected 1 to equal 2"),
      "AssertionFailed"
    );
  });
});

describe("aggregateUnitMetrics", () => {
  it("aggregates pass rate and fail classes", () => {
    const m = aggregateUnitMetrics([
      { testCaseId: "1", status: "ok" },
      {
        testCaseId: "2",
        status: "fail",
        error: "Cannot find module 'x'",
      },
      {
        testCaseId: "3",
        status: "fail",
        error: "AssertionError: expected true",
      },
    ]);
    assert.equal(m.passed, 1);
    assert.equal(m.failed, 2);
    assert.equal(m.failByClass.ImportError, 1);
    assert.equal(m.failByClass.AssertionFailed, 1);
    assert.match(m.summaryLine, /Phase 6 unit metrics/);
  });
});

describe("buildUnitRepairContext", () => {
  it("embeds taxonomy", () => {
    const { repairContext, failClass } = buildUnitRepairContext({
      targetRel: "AItest/UnitTest/A/a.spec.ts",
      errorLog: "TypeError: x is not a function",
      attempt: 1,
      maxAttempts: 3,
    });
    assert.equal(failClass, "RuntimeError");
    assert.match(repairContext, /RuntimeError/);
    assert.match(repairContext, /Phase 6/);
  });
});
