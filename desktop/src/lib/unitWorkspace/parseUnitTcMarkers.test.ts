/**
 * parseUnitTcMarkers — Gen fail-closed for NOT_READY / incomplete VALIDATION IR.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isUnitTcBlockedForGen,
  parseUnitTcMarkers,
  parseUnitTcStatus,
} from "./parseUnitTcMarkers.ts";
import { decideUnitGenGate } from "./unitGenGates.ts";

describe("parseUnitTcMarkers", () => {
  it("parses status and validation fields", () => {
    const m = parseUnitTcMarkers(
      "status: NOT_READY\nprimaryBucket: VALIDATION_DATA\ntarget.field: Name"
    );
    assert.equal(m.status, "NOT_READY");
    assert.equal(m.primaryBucket, "VALIDATION_DATA");
    assert.equal(m.targetField, "Name");
  });

  it("blocks NOT_READY TC for Gen", () => {
    const r = isUnitTcBlockedForGen("status: NOT_READY\nbehaviorId: X");
    assert.equal(r.blocked, true);
  });

  it("blocks VALIDATION with placeholder field", () => {
    const r = isUnitTcBlockedForGen(
      "primaryBucket: VALIDATION_DATA\n" +
        "target.field: [Chưa xác định trong Knowledge]\n" +
        "target.constraint: required"
    );
    assert.equal(r.blocked, true);
    assert.match(r.reason || "", /PLACEHOLDER/);
  });

  it("blocks VI field without property bind", () => {
    const r = isUnitTcBlockedForGen(
      "primaryBucket: VALIDATION_DATA\n" +
        "target.field: Địa điểm thu giữ\n" +
        "target.constraint: required\n" +
        'input: {"diaDiemThuGiu":""}'
    );
    assert.equal(r.blocked, true);
    assert.match(r.reason || "", /UNBOUND|FIELD/);
  });

  it("allows complete VALIDATION with property", () => {
    const r = isUnitTcBlockedForGen(
      "primaryBucket: VALIDATION_DATA\n" +
        "target.field: SeizureLocation\n" +
        "target.property: SeizureLocation\n" +
        "target.constraint: required\n" +
        'input: {"SeizureLocation":""}\n' +
        "status: READY_FOR_CODEGEN"
    );
    assert.equal(r.blocked, false);
  });
});

describe("decideUnitGenGate not_ready", () => {
  it("fails when markerBlob is NOT_READY", () => {
    const r = decideUnitGenGate({
      isTauri: true,
      projectRoot: "D:/x",
      ideReady: true,
      mdPath: "tc.md",
      tcLabel: "TC-097",
      hasSourceMarkers: true,
      markerBlob: "status: NOT_READY\npath: x\ncode: Y",
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "not_ready");
  });
});

describe("parseUnitTcStatus", () => {
  it("reads READY from blob", () => {
    assert.equal(
      parseUnitTcStatus("status: READY_FOR_CODEGEN"),
      "READY_FOR_CODEGEN"
    );
  });
});
