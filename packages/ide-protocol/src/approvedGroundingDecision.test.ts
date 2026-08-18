import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APPROVED_GROUNDING_SCHEMA,
  REQUIRED_GROUNDING_CHECKS,
  sameContentHash,
  validateApprovedGroundingDecision,
  type ApprovedGroundingDecision,
} from "./approvedGroundingDecision.js";

function readyDecision(): ApprovedGroundingDecision {
  return {
    schema: APPROVED_GROUNDING_SCHEMA,
    emittedAt: "2026-01-01T00:00:00.000Z",
    outcome: "READY",
    authoritative: true,
    primary: {
      pathRel: "src/FooHandler.cs",
      code: "FooHandler.Handle",
      typeName: "FooHandler",
      methodName: "Handle",
      contentHash: "abc",
    },
    related: [],
    deps: [],
    confidence: "HIGH",
    freshness: "fresh",
    validateChecks: [...REQUIRED_GROUNDING_CHECKS],
  };
}

describe("ApprovedGroundingDecision", () => {
  it("matches a re-hashed digest against the prefixed one Approve emitted", () => {
    assert.equal(sameContentHash("sha256:AB12", "ab12"), true);
    assert.equal(sameContentHash("ab12", "sha256:ab12"), true);
    assert.equal(sameContentHash("ab12", "ab13"), false);
    assert.equal(sameContentHash("", "sha256:"), false);
  });

  it("accepts one authoritative decision in Desktop and Extension", () => {
    const decision = readyDecision();
    assert.deepEqual(
      validateApprovedGroundingDecision(decision, {
        paths: ["src/FooHandler.cs"],
        codes: ["FooHandler"],
      }),
      { ok: true }
    );
  });

  it("rejects marker mismatch and incomplete field bindings", () => {
    const decision = readyDecision();
    assert.equal(
      validateApprovedGroundingDecision(decision, {
        paths: ["src/Other.cs"],
      }).ok,
      false
    );
    decision.targetScope = "field";
    assert.deepEqual(validateApprovedGroundingDecision(decision), {
      ok: false,
      code: "INCOMPLETE_BINDINGS",
    });
  });
});
