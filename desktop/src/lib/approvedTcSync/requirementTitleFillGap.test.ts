/**
 * Bulk Approve requirement title stamp — fill-gap only.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mergeRequirementTitleFillGap } from "./requirementTitleFillGap.ts";

describe("mergeRequirementTitleFillGap", () => {
  it("keeps per-TC titles and only fills missing keys", () => {
    const cases = [
      { id: "a", testCaseId: "TC-1", sourceId: "s1" },
      { id: "b", testCaseId: "TC-2", sourceId: "s2" },
    ];
    const map = {
      a: "Req Widget",
      "TC-1": "Req Widget",
      s1: "Req Widget",
    };
    const out = mergeRequirementTitleFillGap(cases, map, "Workspace Title");
    assert.equal(out.a, "Req Widget");
    assert.equal(out["TC-1"], "Req Widget");
    assert.equal(out.b, "Workspace Title");
    assert.equal(out["TC-2"], "Workspace Title");
    assert.equal(out.s2, "Workspace Title");
  });

  it("no-op when fallback empty", () => {
    const out = mergeRequirementTitleFillGap(
      [{ id: "a", testCaseId: "TC-1" }],
      { a: "Keep" },
      "  "
    );
    assert.deepEqual(out, { a: "Keep" });
  });
});
