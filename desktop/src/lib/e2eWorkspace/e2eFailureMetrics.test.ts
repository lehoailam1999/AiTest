import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  aggregateE2eMetrics,
  classifyE2eFailure,
  formatE2eMetricsReport,
} from "./e2eFailureMetrics.js";

describe("classifyE2eFailure", () => {
  it("detects auth", () => {
    assert.equal(
      classifyE2eFailure("Login did not leave the login wall (password still visible)"),
      "auth"
    );
  });
  it("detects feature entry", () => {
    assert.equal(
      classifyE2eFailure("Feature entry: E2E_FEATURE_PATH empty and still on login"),
      "feature_entry"
    );
  });
  it("detects stub/promise", () => {
    assert.equal(classifyE2eFailure("getByText('[object Promise]')"), "stub");
    assert.equal(
      classifyE2eFailure("Phase 3: ungrounded POM stub `clickX`"),
      "stub"
    );
  });
  it("detects locator", () => {
    assert.equal(
      classifyE2eFailure("Error: strict mode violation: getByRole('button') resolved to 2 elements"),
      "locator"
    );
  });
  it("detects crash", () => {
    assert.equal(classifyE2eFailure("Error: No tests found"), "crash");
  });
  it("detects codegen gate", () => {
    assert.equal(
      classifyE2eFailure("Phase 2 journey enforce failed (Auth → Feature entry → Act)"),
      "codegen"
    );
  });
});

describe("aggregateE2eMetrics", () => {
  it("computes pass rate and fail shares", () => {
    const m = aggregateE2eMetrics([
      { testCaseId: "1", title: "A", status: "ok" },
      { testCaseId: "2", title: "B", status: "fail", error: "login wall password" },
      {
        testCaseId: "3",
        title: "C",
        status: "fail",
        error: "Timeout 30000ms exceeded waiting for locator",
      },
      {
        testCaseId: "4",
        title: "D",
        status: "fail",
        error: "strict mode violation getByRole",
      },
    ]);
    assert.equal(m.total, 4);
    assert.equal(m.passed, 1);
    assert.equal(m.failed, 3);
    assert.equal(m.passRatePct, 25);
    assert.equal(m.failByCategory.auth, 1);
    assert.equal(m.failByCategory.timeout, 1);
    assert.equal(m.failByCategory.locator, 1);
    assert.equal(m.failSharePct.auth, 33.3);
    assert.match(formatE2eMetricsReport(m), /Phase 4 metrics/);
    assert.match(formatE2eMetricsReport(m), /Auth \/ login/);
  });
});
