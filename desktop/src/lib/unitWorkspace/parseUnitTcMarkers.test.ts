import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseUnitTcMarkers,
  parseUnitTcStatus,
} from "./parseUnitTcMarkers.ts";

describe("parseUnitTcMarkers", () => {
  it("parses status and validation fields", () => {
    const m = parseUnitTcMarkers(
      "status: NOT_READY\nprimaryBucket: VALIDATION_DATA\ntarget.field: Name"
    );
    assert.equal(m.status, "NOT_READY");
    assert.equal(m.primaryBucket, "VALIDATION_DATA");
    assert.equal(m.targetField, "Name");
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
