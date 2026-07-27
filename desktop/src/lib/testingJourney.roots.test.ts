import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeJourneyStatus } from "./testingJourney.ts";

describe("computeJourneyStatus rootsAligned", () => {
  const base = {
    hasProject: true,
    aiReady: true,
    hasLocalPath: true,
    ideConnected: true,
    requirementCount: 1,
    testCaseTotal: 2,
    draftCount: 0,
    approvedCount: 1,
  };

  it("points next step to align roots when mismatched", () => {
    const s = computeJourneyStatus({ ...base, rootsAligned: false });
    assert.equal(s.rootsAligned, false);
    // CLI happy path: IDE mismatch không chặn — vẫn Sinh Unit
    assert.equal(s.nextLabel, "Sinh Unit");
    assert.equal(s.codeReady, true);
  });

  it("allows code when roots aligned", () => {
    const s = computeJourneyStatus({ ...base, rootsAligned: true });
    assert.equal(s.rootsAligned, true);
    assert.equal(s.nextLabel, "Sinh Unit");
    assert.equal(s.codeReady, true);
  });

  it("U0: Local FS root enough without IDE", () => {
    const s = computeJourneyStatus({
      ...base,
      ideConnected: false,
      hasLocalPath: true,
      rootsAligned: true,
    });
    assert.equal(s.codeReady, true);
    assert.equal(s.nextLabel, "Sinh Unit");
  });

  it("U0: prompts project root not Connect IDE", () => {
    const s = computeJourneyStatus({
      ...base,
      ideConnected: false,
      hasLocalPath: false,
    });
    assert.equal(s.nextLabel, "Gắn project root");
    assert.equal(s.codeReady, false);
  });
});
