/**
 * Unit Repair via Extension — orchestration helper (no API UUTGS).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { normalizeUnitProfile } from "../projectProfile/loadSaveProfile";

describe("unit flow declutter — Desktop profile + repair ownership", () => {
  it("normalizeUnitProfile defaults allowDiskReresolve=false", () => {
    const u = normalizeUnitProfile({ runner: "", testFrameworks: [], mockHint: "" });
    assert.equal(u.allowDiskReresolve, false);
    assert.equal(u.scope, "backend");
    assert.equal(u.minAlignment, 50);
  });

  it("normalizeUnitProfile can enable disk reresolve explicitly", () => {
    const u = normalizeUnitProfile({
      runner: "",
      testFrameworks: [],
      mockHint: "",
      allowDiskReresolve: true,
    });
    assert.equal(u.allowDiskReresolve, true);
  });
});
