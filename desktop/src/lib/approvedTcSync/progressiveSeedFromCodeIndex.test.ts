import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeIndexSnapshot } from "../codeIndex/types.js";
import { resolveSeedsFromCodeIndex } from "./progressiveSeedFromCodeIndex.js";
import type { TestCase } from "../../api/types";

function emptySnap(files: string[], symbols: Record<string, { name: string; kind: "class" }[]>): CodeIndexSnapshot {
  const now = new Date().toISOString();
  const fileRec: CodeIndexSnapshot["files"] = {};
  const symbolsByFile: CodeIndexSnapshot["symbolsByFile"] = {};
  const symbolIndex: CodeIndexSnapshot["symbolIndex"] = {};
  for (const p of files) {
    fileRec[p] = {
      pathRel: p,
      language: "ts",
      contentHash: "x",
      byteSize: 1,
      symbolCount: (symbols[p] || []).length,
      importCount: 0,
      indexedAt: now,
    };
    symbolsByFile[p] = (symbols[p] || []).map((s) => ({
      name: s.name,
      kind: s.kind,
      line: 1,
      exported: true,
    }));
    for (const s of symbols[p] || []) {
      const k = s.name.toLowerCase();
      symbolIndex[k] = [...(symbolIndex[k] || []), p];
    }
  }
  return {
    meta: {
      schema: "aitest-code-index-v1",
      createdAt: now,
      updatedAt: now,
      fileCount: files.length,
      symbolCount: Object.values(symbols).flat().length,
      edgeCount: 0,
      parser: "test",
    },
    files: fileRec,
    symbolsByFile,
    importsByFile: {},
    exportsByFile: {},
    symbolIndex,
    dependencyGraph: {},
  };
}

describe("progressiveSeedFromCodeIndex", () => {
  it("intent Upload/InitUpload prefers *Upload*Service; denies pipe/component", () => {
    const snap = emptySnap(
      [
        "src/app/account/activate/activate.service.ts",
        "src/Infrastructure/Services/UploadService.cs",
        "src/app/shared/pipes/file-size.pipe.ts",
        "src/app/admin/upload/upload-modal.component.ts",
      ],
      {
        "src/app/account/activate/activate.service.ts": [
          { name: "ActivateService", kind: "class" },
        ],
        "src/Infrastructure/Services/UploadService.cs": [
          { name: "UploadService", kind: "class" },
          { name: "InitUploadAsync", kind: "method" },
        ],
        "src/app/shared/pipes/file-size.pipe.ts": [
          { name: "FileSizePipe", kind: "class" },
        ],
        "src/app/admin/upload/upload-modal.component.ts": [
          { name: "UploadModalComponent", kind: "class" },
        ],
      }
    );
    const tc = {
      id: "1",
      projectId: "p",
      testCaseId: "TC-092",
      title: "Tải lên tệp - vượt dung lượng - Từ chối",
      module: "Tải lên tệp kỹ thuật số",
      type: "Unit",
      priority: "High",
      severity: "Major",
      steps: "FileSize > MaxFileSize",
      expectedResult: "ArgumentException",
      precondition: "maxConfig",
      testData: "trace: NFR",
      automationReady: true,
      isAiGenerated: true,
      reviewStatus: "Approved",
      executionStatus: "Pending",
      createdAt: nowIso(),
    } as TestCase;

    const hits = resolveSeedsFromCodeIndex(tc, snap, {
      requirementTitle: "Upload",
    });
    assert.ok(hits.length, JSON.stringify(hits));
    assert.ok(
      hits[0].pathRel.includes("UploadService"),
      JSON.stringify(hits.slice(0, 3))
    );
    assert.ok(hits[0].hits?.some((h) => String(h).startsWith("intent:")));
    assert.ok(!hits.some((h) => h.pathRel.includes(".component.")));
    assert.ok(!hits.some((h) => h.pathRel.includes(".pipe.")));
  });

  it("short token vat does not latch activate; Evidence alias scopes logic service", () => {
    const snap = emptySnap(
      [
        "src/app/account/activate/activate.service.ts",
        "src/Infrastructure/Services/EvidenceUploadService.ts",
        "src/app/shared/constant/co-c-action-type.constant.ts",
      ],
      {
        "src/app/account/activate/activate.service.ts": [
          { name: "ActivateService", kind: "class" },
        ],
        "src/Infrastructure/Services/EvidenceUploadService.ts": [
          { name: "EvidenceUploadService", kind: "class" },
        ],
        "src/app/shared/constant/co-c-action-type.constant.ts": [
          { name: "CoCActionType", kind: "class" },
        ],
      }
    );
    const tc = {
      id: "1",
      projectId: "p",
      testCaseId: "TC-092",
      title: "Tải lên tệp - vượt dung lượng - Từ chối",
      module: "Tải lên tệp kỹ thuật số của vật chứng",
      type: "Unit",
      priority: "High",
      severity: "Major",
      steps: "Assert reject when FileSize > MaxFileSize",
      expectedResult: "ArgumentException",
      precondition: "Mock max config",
      testData: "trace: NFR size limit",
      automationReady: true,
      isAiGenerated: true,
      reviewStatus: "Approved",
      executionStatus: "Pending",
      createdAt: nowIso(),
    } as TestCase;

    const hits = resolveSeedsFromCodeIndex(tc, snap, {
      requirementTitle: "Vật chứng",
      projectAliases: { "vat chung": ["Evidence"] },
    });
    assert.ok(hits.length, JSON.stringify(hits));
    assert.ok(
      hits[0].pathRel.includes("EvidenceUploadService"),
      JSON.stringify(hits.slice(0, 3))
    );
    assert.ok(!hits[0].pathRel.includes("activate"));
  });

  it("scopes Module → Function → Title via index.db", () => {
    const snap = emptySnap(
      [
        "src/account/AccountService.ts",
        "src/evidence/storage/StorageLocationService.ts",
        "src/evidence/upload/ResumableUploadClient.ts",
      ],
      {
        "src/evidence/storage/StorageLocationService.ts": [
          { name: "StorageLocationService", kind: "class" },
        ],
        "src/evidence/upload/ResumableUploadClient.ts": [
          { name: "ResumableUploadClient", kind: "class" },
        ],
        "src/account/AccountService.ts": [{ name: "AccountService", kind: "class" }],
      }
    );
    const tc = {
      id: "1",
      projectId: "p",
      testCaseId: "TC-002",
      title: "Lọc phòng đang hoạt động theo BR-11",
      module: "Chọn vị trí lưu trữ",
      type: "Unit",
      priority: "High",
      severity: "Major",
      steps: "Assert active rooms only",
      expectedResult: "only active",
      testData: "trace: BR-11",
      automationReady: true,
      isAiGenerated: true,
      reviewStatus: "Approved",
      executionStatus: "Pending",
      createdAt: nowIso(),
    } as TestCase;

    const hits = resolveSeedsFromCodeIndex(tc, snap, {
      requirementTitle: "Evidence",
      projectAliases: {
        "vi tri luu tru": ["Storage", "Location"],
        "vat chung": ["Evidence"],
      },
    });
    assert.ok(hits.length, JSON.stringify(hits));
    assert.ok(
      hits[0].pathRel.includes("StorageLocation") ||
        hits[0].pathRel.includes("storage"),
      JSON.stringify(hits[0])
    );
    assert.ok(!hits[0].pathRel.includes("Account"));
  });

  it("TC-018 style: module lưu trữ + code-aliases hits Storage/Compartment", () => {
    const snap = emptySnap(
      [
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        "src/App/Commands/StorageRoom/AssignEvidenceCommandHandler.cs",
        "src/Domain/Entities/CabinetCompartment.cs",
        "src/App/Commands/Account/AccountCreateCommandHandler.cs",
      ],
      {
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs": [
          { name: "EvidenceCreateCommandHandler", kind: "class" },
        ],
        "src/App/Commands/StorageRoom/AssignEvidenceCommandHandler.cs": [
          { name: "AssignEvidenceCommandHandler", kind: "class" },
        ],
        "src/Domain/Entities/CabinetCompartment.cs": [
          { name: "CabinetCompartment", kind: "class" },
          { name: "IsOccupied", kind: "method" },
        ],
        "src/App/Commands/Account/AccountCreateCommandHandler.cs": [
          { name: "AccountCreateCommandHandler", kind: "class" },
        ],
      }
    );
    const tc = {
      id: "1",
      projectId: "p",
      testCaseId: "TC-018",
      title: "Chọn vị trí lưu trữ - Ngăn đã chứa vật chứng - Disable; ngăn trống - Enable",
      module: "Chọn vị trí lưu trữ vật chứng",
      type: "Unit",
      priority: "High",
      severity: "Major",
      steps: "Assert ngăn trống enable; ngăn đã chứa disable",
      expectedResult: "chỉ ngăn trống enable theo BR-16",
      testData: "trace: BR-16",
      automationReady: true,
      isAiGenerated: true,
      reviewStatus: "Approved",
      executionStatus: "Pending",
      createdAt: nowIso(),
    } as TestCase;

    const hits = resolveSeedsFromCodeIndex(tc, snap, {
      requirementTitle: "Vật chứng",
      // Domain nouns live in project code-aliases — not protocol GENERIC maps
      projectAliases: {
        "luu tru": ["Storage", "StorageLocation", "StorageRoom"],
        "vi tri luu tru": ["StorageLocation", "StorageRoom", "Compartment"],
        "ngan": ["Compartment", "Cabinet"],
        "vat chung": ["Evidence"],
      },
    });
    assert.ok(hits.length, JSON.stringify(hits));
    assert.ok(
      /Storage|Compartment|AssignEvidence/i.test(hits[0].pathRel),
      `expected storage/compartment SUT, got ${hits[0].pathRel}`
    );
    assert.ok(!/AccountCreate/i.test(hits[0].pathRel));
  });
});

function nowIso() {
  return "2026-01-01T00:00:00Z";
}
