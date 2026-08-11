/**
 * Phase 1 — Unit Implementation Planner + Context Cache tests.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { CodeIndexIo } from "../codeIndex/types.js";
import { syncProjectIndex } from "../codeIndex/incrementalSync.js";
import { planFromTestCase } from "./planFromTestCase.js";
import {
  buildUnitImplementationPlan,
  isWeakClientAppAdmin,
} from "./buildUnitImplementationPlan.js";
import {
  clearUnitPlanCache,
  getOrBuildUnitImplementationPlan,
  unitPlanCacheSize,
} from "./contextCache.js";

function memoryIo(files: Record<string, string>): CodeIndexIo {
  return {
    listFiles: async () =>
      Object.keys(files).filter((p) => !p.includes(".ai-test/")),
    readFile: async (_r, p) => {
      if (!(p in files)) throw new Error(`missing ${p}`);
      return files[p];
    },
    writeFile: async (_r, p, c) => {
      files[p] = c;
    },
    readFileOptional: async (_r, p) => (p in files ? files[p] : null),
  };
}

describe("buildUnitImplementationPlan", () => {
  beforeEach(() => clearUnitPlanCache());

  it("detects weak ClientApp admin paths and thin upload clients", () => {
    assert.equal(
      isWeakClientAppAdmin(
        "src/Forensic/ClientApp/src/app/admin/audit-log/audit-log.service.ts"
      ),
      true
    );
    assert.equal(isWeakClientAppAdmin("src/app/resumable-upload.service.ts"), true);
    assert.equal(isWeakClientAppAdmin("src/order/order.service.ts"), false);
  });

  it("resolves entry from path:/code: markers", async () => {
    const files: Record<string, string> = {
      "src/evidence/EvidenceImageUploadService.ts": `
import { IMalwareScanner } from "./IMalwareScanner";
export class EvidenceImageUploadService {
  constructor(private scanner: IMalwareScanner) {}
  upload(file: Buffer) { return this.scanner.scan(file); }
}
`,
      "src/evidence/IMalwareScanner.ts": `
export interface IMalwareScanner { scan(file: Buffer): boolean }
`,
      "src/Forensic/ClientApp/src/app/admin/audit-log/audit-log.service.ts": `
export class AuditLogService { list() {} }
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-marker", io);
    const intent = planFromTestCase(
      {
        title: "Upload evidence image malware reject",
        module: "Evidence",
        type: "Unit",
        testData:
          "path: src/evidence/EvidenceImageUploadService.ts\ncode: EvidenceImageUploadService",
      },
      { forceTestType: "Unit" }
    );
    const plan = await buildUnitImplementationPlan({
      tc: {
        title: "Upload evidence image malware reject",
        module: "Evidence",
        type: "Unit",
        testCaseId: "TC-034",
        testData:
          "path: src/evidence/EvidenceImageUploadService.ts\ncode: EvidenceImageUploadService",
        steps: "Mock scanner; call upload; assert reject",
      },
      intent,
      snapshot,
      readFile: (p) => io.readFile("/proj-marker", p),
    });
    assert.equal(plan.status, "ready");
    assert.ok(plan.entry?.pathRel.includes("EvidenceImageUploadService"));
    assert.equal(plan.entry?.symbol, "EvidenceImageUploadService");
    assert.ok(
      plan.layers.some((l) => l.pathRel.includes("IMalwareScanner")),
      JSON.stringify(plan.layers)
    );
    assert.ok(plan.mocks.includes("IMalwareScanner") || plan.layers.length >= 2);
  });

  it("P0: C# markers → ready plan with related interface from type graph", async () => {
    const files: Record<string, string> = {
      "src/App/Handlers/CreateItemHandler.cs": `
using System.Threading;
using System.Threading.Tasks;
namespace App.Handlers;
public class CreateItemHandler
{
    private readonly IItemRepository _repo;
    public CreateItemHandler(IItemRepository repo) { _repo = repo; }
    public Task Handle(CreateItemCommand cmd, CancellationToken ct) => Task.CompletedTask;
}
`,
      "src/App/Contracts/IItemRepository.cs": `
namespace App.Contracts;
public interface IItemRepository { }
`,
      "src/App/Commands/CreateItemCommand.cs": `
namespace App.Commands;
public class CreateItemCommand { public string Name { get; set; } }
`,
      "tests/App/Handlers/CreateItemHandlerTests.cs": `
using Xunit;
namespace App.Handlers.Tests;
public class CreateItemHandlerTests
{
    [Fact]
    public void Handle_ok() { }
}
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-cs-plan", io);
    const intent = planFromTestCase(
      {
        title: "Create item success",
        module: "Item",
        type: "Unit",
        testData:
          "path: src/App/Handlers/CreateItemHandler.cs\ncode: CreateItemHandler",
      },
      { forceTestType: "Unit" }
    );
    const plan = await buildUnitImplementationPlan({
      tc: {
        title: "Create item success",
        module: "Item",
        type: "Unit",
        testCaseId: "TC-CS-1",
        testData:
          "path: src/App/Handlers/CreateItemHandler.cs\ncode: CreateItemHandler",
      },
      intent,
      snapshot,
      readFile: (p) => io.readFile("/proj-cs-plan", p),
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.entry?.pathRel, "src/App/Handlers/CreateItemHandler.cs");
    assert.ok(
      plan.layers.some((l) => l.pathRel.includes("IItemRepository")),
      "related includes IItemRepository from C# type graph"
    );
    assert.ok(
      plan.existingTests.some((p) => /CreateItemHandlerTests\.cs$/i.test(p)),
      JSON.stringify(plan.existingTests)
    );
  });

  it("needs_marker for evidence TC when only audit-log exists", async () => {
    const files: Record<string, string> = {
      "src/Forensic/ClientApp/src/app/admin/audit-log/audit-log.service.ts": `
export class AuditLogService { getAuditLogs() {} }
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-audit", io);
    const intent = planFromTestCase(
      {
        title:
          "Tải lên hình ảnh vật chứng - File mã độc hoặc định dạng không hợp lệ",
        module: "Tải lên và xóa hình ảnh vật chứng",
        type: "Unit",
        testData:
          "trace: FEATURES/Tải lên và xóa hình ảnh vật chứng; malwareOrInvalid=true",
      },
      { forceTestType: "Unit" }
    );
    const plan = await buildUnitImplementationPlan({
      tc: {
        title: intent.keywords.join(" ") || "upload evidence",
        module: "Tải lên và xóa hình ảnh vật chứng",
        type: "Unit",
        testCaseId: "TC-034",
        testData:
          "trace: FEATURES/Tải lên và xóa hình ảnh vật chứng; malwareOrInvalid=true",
        steps: "Gọi đơn vị upload hình ảnh vật chứng; Assert từ chối",
      },
      intent,
      snapshot,
      readFile: (p) => io.readFile("/proj-audit", p),
    });
    assert.notEqual(plan.status, "ready");
    assert.equal(plan.entry, null);
  });

  it("P0: marker UploadService does not latch IUploadService; promotes impl", async () => {
    const files: Record<string, string> = {
      "src/Services/IUploadService.ts": `
export interface IUploadService { init(): void }
`,
      "src/Services/UploadService.ts": `
export class UploadService {
  init() {
    if (false) throw new Error("MaxFileSize");
  }
}
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-iface", io);
    // Corrupt: if endsWith latch existed, IUploadService would match UploadService.ts suffix — ensure we pick impl
    assert.ok(snapshot.files["src/Services/IUploadService.ts"]);
    assert.ok(snapshot.files["src/Services/UploadService.ts"]);

    const intent = planFromTestCase(
      {
        title: "Upload file too large reject",
        module: "Upload",
        type: "Unit",
        testData:
          "path: src/Services/UploadService.ts\ncode: UploadService",
      },
      { forceTestType: "Unit" }
    );
    const plan = await buildUnitImplementationPlan({
      tc: {
        title: "Upload file too large reject",
        module: "Upload",
        type: "Unit",
        testCaseId: "TC-070",
        testData:
          "path: src/Services/UploadService.ts\ncode: UploadService\nrelated: src/Services/IUploadService.ts",
      },
      intent,
      snapshot,
      readFile: (p) => io.readFile("/proj-iface", p),
    });
    assert.equal(plan.status, "ready");
    assert.equal(plan.entry?.pathRel, "src/Services/UploadService.ts");
    assert.ok(!/IUploadService/.test(plan.entry?.pathRel || ""));
  });

  it("caches implementation plan by root+index+tcId", async () => {
    const files: Record<string, string> = {
      "src/order/OrderService.ts": `
export class OrderService {
  create() { return 1; }
}
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-cache", io);
    const intent = planFromTestCase(
      {
        title: "OrderService create",
        module: "Order",
        type: "Unit",
        testData: "path: src/order/OrderService.ts\ncode: OrderService",
      },
      { forceTestType: "Unit" }
    );
    const input = {
      projectRoot: "/proj-cache",
      testCaseId: "TC-CACHE",
      tc: {
        title: "OrderService create",
        module: "Order",
        testData: "path: src/order/OrderService.ts\ncode: OrderService",
      },
      intent,
      snapshot,
      readFile: async (p: string) => io.readFile("/proj-cache", p),
    };
    const a = await getOrBuildUnitImplementationPlan(input);
    assert.equal(a.cacheHit, false);
    assert.equal(a.plan.status, "ready");
    const b = await getOrBuildUnitImplementationPlan(input);
    assert.equal(b.cacheHit, true);
    assert.ok(unitPlanCacheSize() >= 1);
  });
});
