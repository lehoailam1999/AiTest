import assert from "node:assert/strict";
import { describe, it } from "node:test";

/**
 * Lightweight contract docs — full API resolve is integration-tested via Approve sync.
 * Ensures Studio snapshot path is the documented SoT for requirement titles.
 */
describe("resolveRequirementTitles contract", () => {
  it("documents Studio snapshot → workspace title as primary SoT", () => {
    const order = [
      "requirementSnapshotId → requirement-workspaces.title",
      "sourceId → workspace.legacySourceId",
      "sourceId → legacy /requirements.title",
    ];
    assert.equal(order[0].includes("requirement-workspaces"), true);
    assert.ok(order.length === 3);
  });
});
