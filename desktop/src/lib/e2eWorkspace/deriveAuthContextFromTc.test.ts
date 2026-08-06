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
    assert.equal(r.roleSource, "tc");
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

  it("falls back to analysis actors then project default", () => {
    const fromAnalysis = deriveAuthContextFromTestCase(
      { title: "X", testData: "" },
      { analysisActors: ["Investigator"], fallbackRole: "admin" }
    );
    assert.equal(fromAnalysis.role, "Investigator");
    assert.equal(fromAnalysis.roleSource, "analysis");
    assert.match(fromAnalysis.executionContext, /authRoleSource=analysis/);

    const fromDefault = deriveAuthContextFromTestCase(
      { title: "X", testData: "" },
      { fallbackRole: "admin" }
    );
    assert.equal(fromDefault.role, "admin");
    assert.equal(fromDefault.roleSource, "project-default");
    assert.match(fromDefault.executionContext, /authRole=admin/);
  });

  it("TC authRole wins over fallbacks", () => {
    const r = deriveAuthContextFromTestCase(
      { testData: "authRole: Staff" },
      { analysisActors: ["Investigator"], fallbackRole: "admin" }
    );
    assert.equal(r.role, "Staff");
    assert.equal(r.roleSource, "tc");
    assert.doesNotMatch(r.executionContext, /authRoleSource=/);
  });
});
