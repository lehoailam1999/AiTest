import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { deriveAuthContextFromTestCase } from "./deriveAuthContextFromTc";

describe("deriveAuthContextFromTestCase", () => {
  it("extracts authRole and authRequired", () => {
    const r = deriveAuthContextFromTestCase({
      title: "Upload",
      precondition: "đã đăng nhập",
      testData: "authRole: Staff\nauthRequired: true\ntrace: FEATURES/1",
    });
    assert.equal(r.role, "Staff");
    assert.deepEqual(r.roles, ["Staff"]);
    assert.match(r.executionContext, /authRole=Staff/);
    assert.match(r.executionContext, /authRequired=true/);
  });

  it("collects multi roles list", () => {
    const r = deriveAuthContextFromTestCase({
      testData: "authRole: investigator\nroles: admin, investigator, director\n",
    });
    assert.equal(r.role, "investigator");
    assert.deepEqual(r.roles, ["investigator", "admin", "director"]);
  });

  it("returns empty when no signals", () => {
    const r = deriveAuthContextFromTestCase({
      title: "X",
      precondition: "Mở màn hình",
      testData: "trace: FEATURES/1",
    });
    assert.equal(r.role, undefined);
    assert.deepEqual(r.roles, []);
    assert.equal(r.executionContext, "");
  });
});
