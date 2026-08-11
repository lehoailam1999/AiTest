import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enrichTcTestDataWithE2eMarkers,
  enrichApprovedCasesWithE2eMarkers,
  inferE2eRoutePath,
} from "./enrichE2eMarkersFromIndex";
import type { TestCase } from "../../api/types";

function sampleE2e(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "p1",
    testCaseId: "TC-E2E-01",
    title: "Tạo mới vật chứng trên hệ thống",
    module: "vat-chung",
    type: "E2E",
    priority: "High",
    severity: "Major",
    precondition: "Đã đăng nhập với quyền Admin",
    steps: "1. Mở màn hình /vats-chung\n2. Nhấn nút Tạo mới",
    expectedResult: "Tạo mới thành công",
    testData: "",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("enrichE2eMarkersFromIndex", () => {
  it("infers route path from steps / text", () => {
    const path = inferE2eRoutePath(sampleE2e());
    assert.equal(path, "/vats-chung");
  });

  it("enriches post-login E2E test case with path and authRole", () => {
    const res = enrichTcTestDataWithE2eMarkers(sampleE2e());
    assert.equal(res.enriched, true);
    assert.equal(res.path, "/vats-chung");
    assert.equal(res.authRole, "Admin");
    assert.equal(res.authRequired, true);
    assert.match(res.testData, /path: \/vats-chung/);
    assert.match(res.testData, /authRole: Admin/);
    assert.match(res.testData, /# auto-enriched \(E2E\)/);
  });

  it("skips non-E2E test case", () => {
    const res = enrichTcTestDataWithE2eMarkers(sampleE2e({ type: "Unit" }));
    assert.equal(res.enriched, false);
    assert.equal(res.writeBack, false);
  });

  it("preserves manual markers if explicitly set", () => {
    const res = enrichTcTestDataWithE2eMarkers(
      sampleE2e({ testData: "path: /custom/path\nauthRole: Manager" })
    );
    assert.equal(res.enriched, false);
    assert.equal(res.writeBack, false);
  });

  it("batch enriches approved E2E cases", async () => {
    const approved = [
      sampleE2e({ id: "tc-1", testCaseId: "TC-1" }),
      sampleE2e({ id: "tc-2", testCaseId: "TC-2", type: "Unit" }),
    ];
    const res = await enrichApprovedCasesWithE2eMarkers({ cases: approved });
    assert.equal(res.enrichedCount, 1);
    assert.match(res.cases[0].testData || "", /# auto-enriched \(E2E\)/);
  });
});
