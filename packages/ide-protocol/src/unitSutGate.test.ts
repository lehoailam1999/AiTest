/**
 * Unit Gen P0 / P0.1 gate — block wrong SUT before AI CLI.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  decideUnitSutGate,
  applyProfileDomainGuards,
  detectFeatureGap,
  weakCommonPathTokenPenalty,
  UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT,
} from "./unitSutGate.js";

describe("decideUnitSutGate", () => {
  it("blocks unresolved primary", () => {
    const g = decideUnitSutGate({
      tcText: "Tạo mới vật chứng - mã trùng",
      primaryPath: "",
      sourceExcerpt: "",
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_NEEDS_MARKER");
    assert.equal(g.resolvedSut, "unresolved");
  });

  it("blocks OrganizationUnit for Evidence TC via aliases", () => {
    const tc =
      "Tạo mới vật chứng - Kiểm tra mã vật chứng trùng\nModule: Tạo mới vật chứng";
    const aliases = { "vat chung": ["Evidence"] };
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath:
        "src/App/Commands/OrganizationUnit/OrganizationUnitCreateCommandHandler.cs",
      sourceExcerpt:
        "public class OrganizationUnitCreateCommandHandler { public void Handle() {} }",
      codeAliases: aliases,
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_DOMAIN_GUARD");
    assert.equal(g.domainGuard, "fail");
  });

  it("blocks OrganizationUnit when markers point at Evidence", () => {
    const tc = [
      "Tạo mới vật chứng - mã trùng",
      "path: src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code: EvidenceCreateCommandHandler",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath:
        "src/App/Commands/OrganizationUnit/OrganizationUnitCreateCommandHandler.cs",
      sourceExcerpt: "public class OrganizationUnitCreateCommandHandler {}",
    });
    assert.equal(g.decision, "block");
    assert.ok(
      g.code === "FAIL_DOMAIN_GUARD" || g.code === "FAIL_SUT_MISMATCH",
      g.code
    );
  });

  it("allows matching Evidence handler with markers", () => {
    const tc = [
      "Tạo mới vật chứng",
      "path: src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code: EvidenceCreateCommandHandler",
    ].join("\n");
    const path =
      "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs";
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath: path,
      sourceExcerpt:
        "public class EvidenceCreateCommandHandler { public void Handle(string code) { /* unique */ AnyAsync duplicate exists } }",
    });
    assert.equal(g.decision, "gen", g.reason);
    assert.equal(g.domainGuard, "pass");
  });

  it("requireMarkers blocks unmarked TC even with excerpt", () => {
    const g = decideUnitSutGate({
      tcText: "Tạo mới vật chứng - mã trùng",
      primaryPath: "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      sourceExcerpt:
        "public class EvidenceCreateCommandHandler { unique duplicate exists }",
      requireMarkers: true,
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_NEEDS_MARKER");
  });

  it("unmarked weak alignment uses FAIL_NEEDS_MARKER strict floor", () => {
    const g = decideUnitSutGate({
      tcText: "Something vague about files",
      primaryPath: "src/App/Commands/Foo/FooCreateCommandHandler.cs",
      sourceExcerpt: "public class FooCreateCommandHandler { }",
      alignmentScore: UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT - 1,
    });
    assert.equal(g.decision, "block");
    assert.ok(
      g.code === "FAIL_NEEDS_MARKER" || g.code === "FAIL_SUT_MISMATCH",
      g.code
    );
  });

  it("blocks I* interface when markers point at implementation", () => {
    const tc = [
      "Tải lên hình ảnh vật chứng - định dạng không hỗ trợ",
      "path: src/Forensic.Infrastructure/Services/UploadService.cs",
      "code: UploadService",
      "related: src/Forensic.Infrastructure/Services/IUploadService.cs",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath: "src/Forensic.Infrastructure/Services/IUploadService.cs",
      sourceExcerpt:
        "public interface IUploadService { Task<UploadInitResponse> InitUploadAsync(...); }",
      alignmentScore: 28,
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_SUT_MISMATCH");
    assert.match(g.reason, /does not match Test Data/i);
  });

  it("blocks entity POCO primary for reject/enable TC", () => {
    const g = decideUnitSutGate({
      tcText:
        "Chọn vị trí lưu trữ - Ngăn đã chứa - Disable; gán ngăn đã chứa - Từ chối\npath: src/Domain/Entities/CabinetCompartment.cs\ncode: CabinetCompartment",
      primaryPath: "src/Domain/Entities/CabinetCompartment.cs",
      sourceExcerpt:
        "public class CabinetCompartment { public bool IsOccupied { get; set; } public long? EvidenceId { get; set; } }",
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_SUT_MISMATCH");
    assert.match(g.reason, /entity\/POCO|Handler/i);
  });

  it("blocks alignment below hard floor 50 without markers", () => {
    const g = decideUnitSutGate({
      tcText: "Something about files",
      primaryPath: "src/App/Models/FooModel.cs",
      sourceExcerpt: "public class FooModel { public string Name { get; set; } }",
      requireMarkers: false,
    });
    assert.equal(g.decision, "block");
    assert.ok(
      g.code === "FAIL_SUT_MISMATCH" || g.code === "FAIL_NEEDS_MARKER",
      g.code
    );
    assert.ok((g.alignmentScore ?? 0) < (g.minAlignment ?? 50) || g.code === "FAIL_NEEDS_MARKER");
  });

  it("FAIL_FEATURE_GAP when malware intent missing from excerpt", () => {
    const g = decideUnitSutGate({
      tcText: [
        "Upload file - quét mã độc malware antivirus",
        "path: src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        "code: EvidenceCreateCommandHandler",
      ].join("\n"),
      primaryPath: "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      sourceExcerpt:
        "public class EvidenceCreateCommandHandler { public void Handle() { Save(); } }",
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_FEATURE_GAP");
    assert.equal(g.featureGap, "malware/antivirus");
  });

  it("does not FEATURE_GAP from unit-conventions malware example wording", () => {
    const tc = [
      "Tải lên tệp - vượt dung lượng - Từ chối",
      "path: src/Services/UploadService.cs",
      "code: UploadService",
      "# Unit test conventions (AITest)",
      "- when the TC is about BR / malware / validation / domain rules",
      "e.g. antivirus when only format allow-list exists",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath: "src/Services/UploadService.cs",
      sourceExcerpt:
        "public class UploadService { void Init(long FileSize, long MaxFileSize) { if (FileSize > MaxFileSize) throw new ArgumentException(); } }",
    });
    assert.equal(g.decision, "gen", g.reason);
  });

  it("TC-066 style: UI master + scope backend → FAIL_FEATURE_GAP before Gen", () => {
    const tc = [
      "---",
      "type: Unit",
      "module: Tạo mới giá trị master data thiết bị",
      "title: Tạo mới Loại thiết bị khi chưa có trong master data",
      "---",
      "path: src/App/Commands/DeviceType/DeviceTypeCreateCommandHandler.cs",
      "code: DeviceTypeCreateCommandHandler",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath:
        "src/App/Commands/DeviceType/DeviceTypeCreateCommandHandler.cs",
      sourceExcerpt:
        "public class DeviceTypeCreateCommandHandler { public void Handle() { Create(); } }",
      unitScope: "backend",
      requireMarkers: true,
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_FEATURE_GAP");
    assert.equal(g.featureGap, "ui-master-create");
    assert.equal(g.intentClass, "ui_master_create");
  });

  it("blocks OrganizationUnit for unmarked master-data TC despite type: Unit frontmatter", () => {
    const tc = [
      "---",
      "type: Unit",
      "requirement: Vật chứng",
      "module: Tạo mới giá trị master data thiết bị",
      "title: Tạo mới Loại thiết bị khi chưa có trong master data",
      "---",
      "_(unresolved)_ no confident match",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath:
        "src/Forensic.Application/Commands/OrganizationUnit/OrganizationUnitCreateCommandHandler.cs",
      sourceExcerpt:
        "public class OrganizationUnitCreateCommandHandler { public void Handle() { Create(); } }",
      // stale disk score must not force gen
      alignmentScore: 20,
      unitScope: "backend",
    });
    assert.equal(g.decision, "block", g.reason);
    assert.ok(
      g.code === "FAIL_FEATURE_GAP" ||
        g.code === "FAIL_NEEDS_MARKER" ||
        g.code === "FAIL_SUT_MISMATCH" ||
        g.code === "FAIL_DOMAIN_GUARD",
      g.code
    );
  });

  it("TC-026 style BE create is not FEATURE_GAP ui under scope=backend", () => {
    const tc = [
      "Tạo mới vật chứng thành công",
      "Module: Tạo mới vật chứng",
      "Steps: Điền form tạo mới và Lưu",
      "path: src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code: EvidenceCreateCommandHandler",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath:
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      sourceExcerpt:
        "public class EvidenceCreateCommandHandler { public void Handle() { Save(); } }",
      unitScope: "backend",
      moduleText: "Tạo mới vật chứng\nTạo mới vật chứng thành công",
      requireMarkers: true,
    });
    assert.notEqual(g.code, "FAIL_FEATURE_GAP", g.reason);
    assert.ok(g.intentClass !== "ui_master_create", String(g.intentClass));
  });

  it("applies profile domainGuards deny", () => {
    const r = applyProfileDomainGuards({
      moduleText: "Tạo mới vật chứng",
      primaryPath: "src/Commands/OrganizationUnit/X.cs",
      rules: [
        {
          whenModuleMatches: "(?i)vật chứng|evidence",
          allowPathContains: ["Evidence"],
          denyPathContains: ["OrganizationUnit"],
        },
      ],
    });
    assert.equal(r.pass, false);
  });
});

describe("detectFeatureGap", () => {
  it("flags duplicate intent without excerpt signals", () => {
    const r = detectFeatureGap(
      "Kiểm tra mã trùng duplicate unique",
      "public class Handler { Save(); }"
    );
    assert.equal(r.gap, true);
    assert.equal(r.label, "uniqueness/duplicate");
  });

  it("passes when excerpt has duplicate signals", () => {
    const r = detectFeatureGap(
      "Kiểm tra mã trùng duplicate",
      "if (await AnyAsync()) throw new ConflictException();"
    );
    assert.equal(r.gap, false);
  });
});

describe("weakCommonPathTokenPenalty", () => {
  it("penalizes Create/Unit dominated basenames without markers", () => {
    const p = weakCommonPathTokenPenalty(
      "src/Commands/OrganizationUnit/OrganizationUnitCreateCommandHandler.cs",
      { hasMarkers: false, strongTokenHit: false }
    );
    assert.ok(p < 0, String(p));
  });

  it("skips penalty when markers or strong token hit", () => {
    assert.equal(
      weakCommonPathTokenPenalty("src/FooCreateCommandHandler.cs", {
        hasMarkers: true,
      }),
      0
    );
    assert.equal(
      weakCommonPathTokenPenalty("src/FooCreateCommandHandler.cs", {
        strongTokenHit: true,
      }),
      0
    );
  });
});

describe("decideUnitSutGate VALIDATION + related excerpt", () => {
  const handlerPath = "src/App/Handlers/EvidenceUpdateCommandHandler.cs";
  const handlerExcerpt =
    "public class EvidenceUpdateCommandHandler { public async Task Handle(EvidenceUpdateCommand cmd) { if (string.IsNullOrWhiteSpace(cmd.EvidenceCode)) throw new BadRequestException(); } }";

  it("blocks VALIDATION required when excerpts lack field constraint", () => {
    const tc = [
      "SeizureLocation bắt buộc khi cập nhật",
      "primaryBucket: VALIDATION_DATA",
      "target.constraint: required",
      "target.field: SeizureLocation",
      `path: ${handlerPath}`,
      "code: EvidenceUpdateCommandHandler.Handle",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath: handlerPath,
      sourceExcerpt: handlerExcerpt,
      relatedExcerpt: "",
    });
    assert.equal(g.decision, "block");
    assert.equal(g.code, "FAIL_FEATURE_GAP");
  });

  it("allows VALIDATION when related DTO has [Required] property", () => {
    const tc = [
      "EvidenceUpdate SeizureLocation bắt buộc khi cập nhật",
      "primaryBucket: VALIDATION_DATA",
      "target.constraint: required",
      "target.property: SeizureLocation",
      `path: ${handlerPath}`,
      "code: EvidenceUpdateCommandHandler.Handle",
      "Module: EvidenceUpdate",
    ].join("\n");
    const g = decideUnitSutGate({
      tcText: tc,
      primaryPath: handlerPath,
      sourceExcerpt:
        "public class EvidenceUpdateCommandHandler { public async Task Handle(EvidenceUpdateCommand cmd) { await _repo.UpdateAsync(cmd); } }",
      relatedExcerpt:
        "public class EvidenceDto { [Required] public string SeizureLocation { get; set; } }",
      minAlignment: 30,
    });
    assert.equal(g.decision, "gen", g.reason);
  });
});

describe("detectFeatureGap constraint-first", () => {
  it("does not invent uniqueness gap when constraint is required", () => {
    const tc = [
      "Cập nhật tên vật chứng để trống - Từ chối",
      "primaryBucket: VALIDATION_DATA",
      "target.constraint: Không được để trống (bắt buộc)",
      "target.field: tenVatChung",
      "# auto-enriched from index.db (ruleHits=throw+BadRequest+Duplicate confidence=LOW)",
    ].join("\n");
    const ex = "public class EvidenceDto { [Required] public string Name { get; set; } }";
    const g = detectFeatureGap(tc, ex);
    assert.equal(g.gap, false, g.label);
  });

  it("reports uniqueness only when constraint says duplicate", () => {
    const tc = [
      "primaryBucket: VALIDATION_DATA",
      "target.constraint: Không được trùng mã vật chứng đã tồn tại",
      "target.field: EvidenceCode",
    ].join("\n");
    const g = detectFeatureGap(tc, "public class EvidenceDto { public string EvidenceCode { get; set; } }");
    assert.equal(g.gap, true);
    assert.equal(g.label, "uniqueness/duplicate");
  });
});
