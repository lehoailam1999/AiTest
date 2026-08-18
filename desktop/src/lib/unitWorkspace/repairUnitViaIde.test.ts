/**
 * Unit Repair via Extension — orchestration helper (no API UUTGS).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUnitProfile } from "../projectProfile/loadSaveProfile";

describe("unit flow declutter — Desktop profile + repair ownership", () => {
  it("normalizes Unit profile without a disk re-resolve escape hatch", () => {
    const u = normalizeUnitProfile({ runner: "", testFrameworks: [], mockHint: "" });
    assert.equal(u.scope, "backend");
    assert.equal(u.minAlignment, 50);
    assert.equal("allowDiskReresolve" in u, false);
  });
});
