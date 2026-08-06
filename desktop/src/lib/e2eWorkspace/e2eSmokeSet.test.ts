import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { TestCase } from "../../api/types";
import {
  buildSmokeJobReport,
  buildSmokeTaxonomy,
  evaluateSmokeGates,
  pickE2eSmokeSet,
} from "./e2eSmokeSet.js";

function tc(
  partial: Partial<TestCase> & { id: string; title: string }
): TestCase {
  return {
    projectId: "p",
    testCaseId: partial.id,
    type: "E2E",
    priority: "Medium",
    severity: "Major",
    steps: partial.steps || "1. Nhấn nút Tạo mới",
    expectedResult: "OK",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: "2026-01-01",
    ...partial,
  } as TestCase;
}

describe("pickE2eSmokeSet", () => {
  it("caps at size and diversifies buckets", () => {
    const pool = [
      tc({ id: "1", title: "Đăng nhập admin", steps: "login" }),
      tc({ id: "2", title: "Validation empty name", steps: "leave empty" }),
      tc({ id: "3", title: "Tạo phòng kho", module: "Rooms" }),
      tc({ id: "4", title: "Create evidence", module: "Evidence" }),
      tc({ id: "5", title: "Invalid upload", steps: "upload bad file" }),
      tc({ id: "6", title: "List rooms", module: "Rooms" }),
      tc({ id: "7", title: "Auth permission deny", steps: "auth check" }),
      tc({ id: "8", title: "Add related", module: "Related" }),
      tc({ id: "9", title: "Boundary length", steps: "boundary" }),
      tc({ id: "10", title: "Save draft", module: "Draft" }),
      tc({ id: "11", title: "Extra one", module: "X" }),
    ];
    const smoke = pickE2eSmokeSet(pool, 10);
    assert.equal(smoke.length, 10);
    assert.ok(smoke.some((t) => /đăng nhập|auth|login/i.test(t.title)));
    assert.ok(smoke.some((t) => /validat|invalid|boundary|empty/i.test(t.title)));
  });

  it("returns all when pool smaller than size", () => {
    const pool = [tc({ id: "a", title: "A" }), tc({ id: "b", title: "B" })];
    assert.equal(pickE2eSmokeSet(pool, 10).length, 2);
  });
});

describe("evaluateSmokeGates", () => {
  it("passes G5 when gen ≥80% and G2 with clean primaries", () => {
    const outcomes = [
      {
        testCaseId: "1",
        title: "Tạo phòng",
        module: "Rooms",
        genOk: true,
        featurePath: "/admin/rooms",
        sourceFileName: "src/app/features/rooms/create.component.html",
      },
      {
        testCaseId: "2",
        title: "List phòng",
        module: "Rooms",
        genOk: true,
        featurePath: "/admin/rooms",
        sourceFileName: "src/app/features/rooms/list.component.ts",
      },
      {
        testCaseId: "3",
        title: "Fail one",
        module: "Rooms",
        genOk: false,
        error: "LocatorNotFound: getByRole",
        failCategory: "locator" as const,
        standardTaxonomy: "LocatorNotFound" as const,
      },
    ];
    const taxonomy = buildSmokeTaxonomy(outcomes);
    assert.equal(taxonomy.genOk, 2);
    assert.ok(taxonomy.genPassRatePct >= 66);
    const gates = evaluateSmokeGates({
      outcomes,
      taxonomy,
      authAvailable: true,
      journeySyntheticOk: true,
    });
    const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
    assert.equal(byId.G2.pass, true);
    assert.equal(byId.G3.pass, true);
    assert.equal(byId.G6.pass, true);
    assert.equal(byId.G4.pass, true);
  });

  it("fails G2 on fixture primary noise", () => {
    const outcomes = [
      {
        testCaseId: "1",
        title: "X",
        module: "Evidence",
        genOk: true,
        featurePath: "/admin/evidence",
        sourceFileName: "Forensic.E2E/support/fixtures/auth.fixture.ts",
      },
    ];
    const taxonomy = buildSmokeTaxonomy(outcomes);
    const gates = evaluateSmokeGates({ outcomes, taxonomy });
    assert.equal(gates.find((g) => g.id === "G2")?.pass, false);
  });

  it("buildSmokeJobReport formats text", () => {
    const report = buildSmokeJobReport(
      [
        {
          testCaseId: "1",
          title: "Tạo",
          module: "Rooms",
          genOk: true,
          featurePath: "/admin/rooms",
          sourceFileName: "src/features/rooms/form.component.html",
          verified: true,
          verifyOk: true,
        },
      ],
      { authAvailable: true }
    );
    assert.match(report.reportText, /E2E Smoke S5/);
    assert.match(report.reportText, /G5/);
    assert.equal(report.taxonomy.genOk, 1);
  });
});
