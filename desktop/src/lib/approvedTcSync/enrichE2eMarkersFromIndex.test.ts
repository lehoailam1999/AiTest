import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  enrichTcTestDataWithE2eMarkers,
  enrichApprovedCasesWithE2eMarkers,
  inferE2eRoutePath,
} from "./enrichE2eMarkersFromIndex";
import { normalizeFeaturePath, isUsableFeaturePath } from "../e2eWorkspace/assertTcReadyForE2eGen";
import { resolveFeaturePathSeed } from "../e2eWorkspace/generateGrounding";
import { renderE2eGroundingBlock } from "./approvedTcMarkdown";
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

  it("rejects localhost baseURL and VN slug invent", () => {
    assert.equal(normalizeFeaturePath("http://localhost:4200"), "");
    assert.equal(isUsableFeaturePath("/tạo-mới-vật-chứng"), false);
    assert.equal(
      inferE2eRoutePath(
        sampleE2e({
          module: "Tạo mới vật chứng",
          steps: "1. Upload file",
          testData: "baseURL: http://localhost:4200\npath: /tạo-mới-vật-chứng",
        })
      ),
      null
    );
  });

  it("fills path from moduleMap when TC has no usable route", () => {
    const res = enrichTcTestDataWithE2eMarkers(
      sampleE2e({
        module: "Tạo mới vật chứng",
        steps: "1. Nhấn nút Tạo mới",
        testData: "baseURL: http://localhost:4200",
      }),
      {
        moduleMap: { "Tạo mới vật chứng": "/admin/evidence/new" },
      }
    );
    assert.equal(res.path, "/admin/evidence/new");
    assert.match(res.testData, /path: \/admin\/evidence\/new/);
    assert.doesNotMatch(res.testData, /path: http:\/\/localhost/);
    assert.doesNotMatch(res.testData, /tạo-mới/);
    assert.equal(res.authRequired, true);
  });

  it("fills path from route catalog (source) when moduleMap empty", () => {
    const res = enrichTcTestDataWithE2eMarkers(
      sampleE2e({
        module: "Evidence",
        title: "Create new evidence",
        steps: "1. Open evidence screen\n2. Click create",
        testData: "baseURL: http://localhost:4200",
      }),
      {
        routeCatalog: {
          routes: ["/admin/evidence", "/admin/rooms", "/admin/users"],
          sources: ["src/app/app-routing.module.ts"],
        },
      }
    );
    assert.equal(res.path, "/admin/evidence");
    assert.match(res.testData, /path: \/admin\/evidence/);
    assert.doesNotMatch(res.testData, /path: http:\/\/localhost/);
  });

  it("prefers /admin/evidence over /upload-activity when requirement is Create evidence", () => {
    const path = inferE2eRoutePath(
      sampleE2e({
        module: "Tạo mới vật chứng",
        title:
          "[E2E-Error] Tạo mới vật chứng - Upload hình ảnh vật chứng vượt dung lượng",
        steps: "1. Upload file oversized\n2. Assert error",
        testData: "baseURL: http://localhost:4200",
        precondition: "Đã chuyển sang bước Tài liệu liên quan",
      }),
      {
        requirementTitle: "Create evidence",
        routeCatalog: {
          routes: ["/admin/evidence", "/upload-activity"],
          sources: ["src/app/admin/evidence/evidence.routes.ts"],
        },
      }
    );
    assert.equal(path, "/admin/evidence");
  });

  it("bridges a Vietnamese business label to a source route through learned aliases", () => {
    const path = inferE2eRoutePath(
      sampleE2e({
        module: "Sinh mã vật chứng tự động",
        title:
          "Sinh mã vật chứng tự động - Nhập mã vật chứng trùng với mã đã tồn tại",
        steps: "1. Nhập mã vật chứng\n2. Hoàn tất tạo mới",
        testData: "trace: BR-22\nauthRequired: true",
        precondition: "Popup Tạo mới vật chứng đang mở",
      }),
      {
        requirementTitle: "Tạo mới vật chứng",
        routeCatalog: {
          routes: [
            "/admin/evidence",
            "/admin/digital-device",
            "/admin/storage-room",
            "/upload-activity",
          ],
          sources: ["src/app/admin/evidence/evidence.routes.ts"],
        },
        semanticAliases: {
          maVatChung: "EvidenceCode",
        },
      }
    );
    assert.equal(path, "/admin/evidence");
  });

  it("enriches post-login E2E test case with path, auth, scenario and normalized steps", () => {
    const res = enrichTcTestDataWithE2eMarkers(sampleE2e());
    assert.equal(res.enriched, true);
    assert.equal(res.path, "/vats-chung");
    assert.equal(res.authRole, "Admin");
    assert.equal(res.authRequired, true);
    assert.match(res.testData, /path: \/vats-chung/);
    assert.match(res.testData, /authRole: Admin/);
    assert.match(res.testData, /scenarioType: Positive/);
    assert.match(res.testData, /postcondition:/);
    assert.match(res.testData, /# auto-enriched \(E2E approve\)/);
    assert.ok(res.steps?.includes("NAVIGATE Target:"));
  });

  it("skips non-E2E test case", () => {
    const res = enrichTcTestDataWithE2eMarkers(sampleE2e({ type: "Unit" }));
    assert.equal(res.enriched, false);
    assert.equal(res.writeBack, false);
  });

  it("preserves manual path but may enrich other soft fields", () => {
    const res = enrichTcTestDataWithE2eMarkers(
      sampleE2e({ testData: "path: /custom/path\nauthRole: Manager" })
    );
    assert.match(res.testData, /path: \/custom\/path/);
    assert.match(res.testData, /authRole: Manager/);
    assert.doesNotMatch(res.testData, /path: \/vats-chung/);
  });

  it("batch enriches approved E2E cases", async () => {
    const approved = [
      sampleE2e({ id: "tc-1", testCaseId: "TC-1" }),
      sampleE2e({ id: "tc-2", testCaseId: "TC-2", type: "Unit" }),
    ];
    const res = await enrichApprovedCasesWithE2eMarkers({ cases: approved });
    assert.equal(res.enrichedCount, 1);
    assert.match(res.cases[0].testData || "", /# auto-enriched \(E2E approve\)/);
  });

  it("MD grounding never emits authRequired false for feature TC", () => {
    const md = renderE2eGroundingBlock(
      sampleE2e({
        testData: "path: /admin/evidence/new",
        precondition: "Đã đăng nhập",
      }),
      "Create evidence"
    );
    assert.match(md, /authRequired: true/);
    assert.doesNotMatch(md, /authRequired: false/);
    assert.match(md, /path: \/admin\/evidence\/new/);
  });

  it("drops a trace-id path (/BR-4) and re-infers from harvested labels", () => {
    const res = enrichTcTestDataWithE2eMarkers(
      sampleE2e({
        module: "Tạo mới vật chứng theo quy trình 2 bước",
        title:
          "[E2E-Boundary] Tạo mới vật chứng theo quy trình 2 bước - bỏ qua trường",
        steps: "1. Hoàn tất quy trình tạo vật chứng",
        testData:
          "baseURL: http://localhost:4200; trace: BR/BR-4\npath: /BR-4\nruleRef: BR-4",
        precondition: "Người dùng đã đăng nhập; popup Tạo mới vật chứng đang mở",
      }),
      {
        routeCatalog: {
          routes: ["/admin/evidence", "/admin/storage-room", "/admin/person"],
          sources: ["src/app/admin/evidence/evidence.routes.ts"],
          labels: {
            "/admin/evidence": { vat: 8, chung: 10, buoc: 4, quy: 2, trinh: 2 },
            "/admin/storage-room": { kho: 6, phong: 5 },
            "/admin/person": { nhan: 4, su: 4 },
          },
          featureSources: {
            "/admin/evidence": [
              "src/app/admin/evidence/list/evidence.component.html",
              "src/app/admin/evidence/create/evidence-create-modal.component.html",
            ],
          },
        },
      }
    );
    assert.equal(res.path, "/admin/evidence");
    assert.match(res.testData, /path: \/admin\/evidence/);
    assert.doesNotMatch(res.testData, /path: \/BR-4/);
    assert.match(res.testData, /ruleRef: BR-4/);
    assert.match(
      res.testData,
      /featureSources: src\/app\/admin\/evidence\/list\/evidence\.component\.html/
    );
    const md = renderE2eGroundingBlock(
      { ...sampleE2e(), testData: res.testData },
      "Tạo mới vật chứng"
    );
    assert.match(md, /path: \/admin\/evidence/);
    assert.match(md, /featureSources:/);
  });

  it("Gen seed drops unusable TC marker then uses moduleMap", () => {
    const picked = resolveFeaturePathSeed({
      testCase: {
        module: "Tạo mới vật chứng",
        testData: "path: /tạo-mới-vật-chứng\nbaseURL: http://localhost:4200",
        title: "Upload invalid",
      },
      moduleMap: { "Tạo mới vật chứng": "/admin/evidence/new" },
    });
    assert.equal(picked, "/admin/evidence/new");
  });
});
