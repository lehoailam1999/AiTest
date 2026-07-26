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
    assert.equal(s.nextLabel, "Khớp thư mục IDE · Root");
    assert.equal(s.codeReady, false);
  });

  it("allows code when roots aligned", () => {
    const s = computeJourneyStatus({ ...base, rootsAligned: true });
    assert.equal(s.rootsAligned, true);
    assert.equal(s.nextLabel, "Unit test");
    assert.equal(s.codeReady, true);
  });
});
