import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { renderUnitConventionsMd, UNIT_CONVENTIONS_CORE } from "./unitConventionsCore.ts";
import { createEmptyProfile } from "./loadSaveProfile.ts";

describe("unitConventionsCore", () => {
  it("core rules cover Approve MD, layout jail, SUT grounding, ownership", () => {
    assert.match(UNIT_CONVENTIONS_CORE, /\.ai-test\/test-cases/);
    assert.match(UNIT_CONVENTIONS_CORE, /AItest\/UnitTest/);
    assert.match(UNIT_CONVENTIONS_CORE, /source under test|SUT/i);
    assert.match(UNIT_CONVENTIONS_CORE, /fail/i);
    assert.match(UNIT_CONVENTIONS_CORE, /Ownership/i);
    assert.match(UNIT_CONVENTIONS_CORE, /allowDiskReresolve/);
  });

  it("renderUnitConventionsMd includes core + framework hint", () => {
    const p = createEmptyProfile();
    p.unit = { testFrameworks: ["jest"], mockHint: "Prefer vi.mock for I/O" };
    const md = renderUnitConventionsMd(p);
    assert.match(md, /AItest\/UnitTest/);
    assert.match(md, /jest/);
    assert.match(md, /vi\.mock/);
  });
});
