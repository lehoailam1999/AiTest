import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  draftEntryCounts,
  emptiedDraftRowCount,
  rowsWithPendingDraft,
  runnableDraftCounts,
} from "./draftInventory.ts";
import type { UnitWorkspaceManifest } from "./types.ts";

function manifest(
  ops: Array<"new" | "modify" | "delete">
): Pick<UnitWorkspaceManifest, "files"> {
  return {
    files: ops.map((op, index) => ({
      op,
      targetRel: `AItest/UnitTest/File${index}.cs`,
      workspaceRel: `unit-runs/run/File${index}.cs`,
    })),
  };
}

const rows = [
  { key: "tc-1", status: "ok" as const, workspaceRunId: "run-1" },
  { key: "tc-2", status: "ok" as const, workspaceRunId: "run-2" },
  { key: "tc-3", status: "fail" as const },
];

describe("draft inventory", () => {
  it("drops a Gen-OK row whose last generated file was deleted", () => {
    const counts = draftEntryCounts([
      { key: "tc-1", manifest: manifest(["new"]) },
      { key: "tc-2", manifest: manifest([]) },
    ]);
    assert.deepEqual(
      rowsWithPendingDraft(rows, counts).map((row) => row.key),
      ["tc-1"]
    );
    assert.equal(emptiedDraftRowCount(rows, counts), 1);
  });

  it("keeps a delete-only draft as work so Update can remove the file", () => {
    const counts = draftEntryCounts([
      { key: "tc-1", manifest: manifest(["delete"]) },
      { key: "tc-2", manifest: manifest(["new"]) },
    ]);
    assert.equal(rowsWithPendingDraft(rows, counts).length, 2);
    assert.equal(runnableDraftCounts([
      { key: "tc-1", manifest: manifest(["delete"]) },
    ])["tc-1"], 0);
  });

  it("treats an unloaded manifest as pending instead of hiding the row", () => {
    assert.equal(rowsWithPendingDraft(rows, {}).length, 2);
    assert.equal(rowsWithPendingDraft(rows).length, 2);
    assert.equal(emptiedDraftRowCount(rows, {}), 0);
  });
});
