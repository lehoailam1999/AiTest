import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  normalizeUnitTcStatus,
  parseAllUnitStatuses,
  pickCanonicalUnitStatus,
  stripUnitStatusLines,
} from "./normalizeUnitTcStatus.js";

describe("normalizeUnitTcStatus", () => {
  it("pickCanonicalUnitStatus prefers FEATURE_GAP then NOT_READY", () => {
    assert.equal(
      pickCanonicalUnitStatus(["READY_FOR_CODEGEN", "NOT_READY"]),
      "NOT_READY"
    );
    assert.equal(
      pickCanonicalUnitStatus(["READY_FOR_CODEGEN", "FEATURE_GAP"]),
      "FEATURE_GAP"
    );
    assert.equal(
      pickCanonicalUnitStatus(["READY_FOR_CODEGEN", "READY_FOR_GROUNDING"]),
      "READY_FOR_GROUNDING"
    );
  });

  it("strips dual status and writes one line", () => {
    const next = normalizeUnitTcStatus(
      "status: READY_FOR_CODEGEN\ntarget.field: Name\nstatus: NOT_READY",
      { status: "NOT_READY" }
    );
    assert.equal(parseAllUnitStatuses(next).length, 1);
    assert.match(next, /^status: NOT_READY$/m);
    assert.doesNotMatch(next, /READY_FOR_CODEGEN/);
  });

  it("downgrades READY when allowReady is false", () => {
    const next = normalizeUnitTcStatus("status: READY_FOR_CODEGEN\npath: a.cs", {
      allowReady: false,
    });
    assert.match(next, /status: NOT_READY/);
  });

  it("stripUnitStatusLines removes all status rows", () => {
    const stripped = stripUnitStatusLines("a\nstatus: READY_FOR_CODEGEN\nb");
    assert.doesNotMatch(stripped, /status:/i);
    assert.match(stripped, /^a$/m);
    assert.match(stripped, /^b$/m);
  });
});
