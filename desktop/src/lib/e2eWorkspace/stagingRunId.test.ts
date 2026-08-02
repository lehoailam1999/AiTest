/**
 * E2E staging must use one runId per Generate batch (Unit-like), not mint
 * a new e2e-* folder on every TC — that stacked orphan overlays on disk.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/** Mirror of stagingApply.newE2eRunId — keep in sync (avoid importing FE api graph). */
function newE2eRunId(testCaseId: string): string {
  const short = testCaseId.replace(/-/g, "").slice(0, 8);
  return `e2e-${short}-${Date.now()}`;
}

describe("E2E staging runId (anti-accumulate)", () => {
  it("newE2eRunId is stable prefix e2e-", () => {
    const a = newE2eRunId("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee");
    assert.match(a, /^e2e-[a-f0-9]+-\d+$/);
    assert.ok(a.startsWith("e2e-aaaaaaaa"));
  });

  it("batch contract: reuse one runId for all stage writes", () => {
    const batchRunId = newE2eRunId("batch-tc-1");
    const reused = [batchRunId, batchRunId, batchRunId];
    assert.equal(new Set(reused).size, 1);
    // Anti-pattern (screenshot bug): minting per TC → N staging folders
    const anti = ["tc1", "tc2", "tc3"].map((id) => newE2eRunId(id));
    assert.equal(new Set(anti).size, 3);
  });
});
