/**
 * Unit Gen quality guards — stack, SUT alignment, invented rules.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  assertStackMatchesPath,
  assertUnitGenQuality,
  detectCodeStack,
  detectCsharpPackagesFromTestCode,
  extractTcSourceMarkers,
  findInventedRuleSmells,
  findNonPortableTestHarnessSmells,
  hasUnitSourceMarkers,
  isPacketSutAcceptable,
  isSutAlignedEnough,
  isUnitSutResolveSkipped,
  sutDomainConflict,
  sutTcAlignmentScore,
  UNIT_SUT_ALIGN_MIN,
} from "./unitGenGuards.js";

describe("unitGenGuards", () => {
  it("detects csharp vs typescript stacks", () => {
    assert.equal(detectCodeStack("using Xunit;\n[Fact] public void A() {}"), "csharp");
    assert.equal(
      detectCodeStack("import { describe, it } from 'vitest';\ndescribe('x', () => {});"),
      "typescript"
    );
  });

  it("rejects TS content in .cs path", () => {
    assert.throws(() =>
      assertStackMatchesPath(
        "AItest/UnitTest/M/x.cs",
        "import { describe } from 'vitest';\ndescribe('a', () => {});"
      )
    );
  });

  it("extracts path/code markers", () => {
    const m = extractTcSourceMarkers("path: src/Evidence/CreateModal.ts\ncode: SeizureTimeForm");
    assert.ok(m.paths.some((p) => p.includes("CreateModal")));
    assert.ok(m.codes.includes("SeizureTimeForm"));
  });

  it("P0: code UploadService does not align IUploadService path via substring", () => {
    const tc =
      "path: src/Services/UploadService.cs\ncode: UploadService\nFileSize MaxFileSize";
    const bad = sutTcAlignmentScore({
      tcText: tc,
      primaryPath: "src/Services/IUploadService.cs",
      sourceExcerpt: "public interface IUploadService { Task InitUploadAsync(); }",
    });
    const good = sutTcAlignmentScore({
      tcText: tc,
      primaryPath: "src/Services/UploadService.cs",
      sourceExcerpt:
        "class UploadService { if (FileSize > MaxFileSize) throw new ArgumentException(); }",
    });
    assert.ok(
      good.markersHit > bad.markersHit,
      `good=${good.markersHit} bad=${bad.markersHit}`
    );
    assert.ok(good.score > bad.score, `good=${good.score} bad=${bad.score}`);
  });

  it("Phase 5 hasUnitSourceMarkers requires both path and code", () => {
    assert.equal(hasUnitSourceMarkers("path: src/A.cs\ncode: A"), true);
    assert.equal(hasUnitSourceMarkers("path: src/A.cs"), false);
    assert.equal(hasUnitSourceMarkers("code: A"), false);
    assert.equal(
      isUnitSutResolveSkipped("# sut-resolve: skipped — no confident match"),
      true
    );
  });

  it("does not treat MD frontmatter type: Unit as SUT marker", () => {
    const md = [
      "---",
      "type: Unit",
      "priority: Cao",
      "---",
      "Tạo mới Loại thiết bị master data",
      "requirement: Vật chứng",
    ].join("\n");
    const m = extractTcSourceMarkers(md);
    assert.equal(m.codes.length, 0, `unexpected codes=${m.codes.join(",")}`);
  });

  it("rejects OrganizationUnit for unmarked master-data device TC (false-friend unit)", () => {
    const tc = [
      "---",
      "type: Unit",
      "requirement: Vật chứng",
      "module: Tạo mới giá trị master data thiết bị",
      "---",
      "Tạo mới Loại thiết bị khi chưa có trong master data - Giá trị được thêm thành công",
      "### Resolved SUT",
      "_(unresolved)_",
      "# sut-resolve: skipped — no confident match",
    ].join("\n");
    const bad = sutTcAlignmentScore({
      tcText: tc,
      primaryPath:
        "src/App/Commands/OrganizationUnit/OrganizationUnitCreateCommandHandler.cs",
      sourceExcerpt: `
        public class OrganizationUnitCreateCommandHandler {
          public async Task<OrganizationUnit> Handle(OrganizationUnitCreateCommand command) {
            var entity = await _repo.CreateOrUpdateAsync(mapped);
            return entity;
          }
        }`,
    });
    assert.ok(
      !isSutAlignedEnough(bad) || bad.score < 8,
      `expected weak OrgUnit alignment, got score=${bad.score} markers=${bad.markersHit} shared=${bad.shared.join(",")}`
    );
    assert.equal(bad.markersHit, 0);
  });

  it("scores SUT alignment — matching evidence vs account mismatch", () => {
    const tc =
      "Thời gian thu giữ mặc định khi tạo mới evidence seizureTime path: EvidenceCreateModal";
    const good = sutTcAlignmentScore({
      tcText: tc,
      primaryPath: "frontend/src/evidence/EvidenceCreateModal.ts",
      sourceExcerpt: "export class EvidenceCreateModal { seizureTime = ''; }",
    });
    const bad = sutTcAlignmentScore({
      tcText: tc,
      primaryPath: "backend/AccountActivateCommandHandler.cs",
      sourceExcerpt: "public class AccountActivateCommandHandler { }",
    });
    assert.ok(good.score >= UNIT_SUT_ALIGN_MIN);
    assert.ok(bad.score < good.score);
  });

  it("rejects digital-file form for evidence-image upload TC without markers", () => {
    const tc = [
      "TC-034 Tải lên hình ảnh vật chứng - File mã độc hoặc định dạng không hợp lệ",
      "Module: Tải lên và xóa hình ảnh vật chứng",
      "Mock bộ quét mã độc/validator nội dung file trả về không hợp lệ",
      "Gọi đơn vị upload hình ảnh vật chứng; Assert từ chối và không lưu",
      "trace: FEATURES/Tải lên và xóa hình ảnh vật chứng; malwareOrInvalid=true",
    ].join("\n");
    const wrong = sutTcAlignmentScore({
      tcText: tc,
      primaryPath:
        "src/Forensic/ClientApp/src/app/admin/digital-file/update/digital-file-form.service.ts",
      sourceExcerpt:
        "export class DigitalFileFormService { updateDigitalFile() {} saveForm() {} }",
    });
    assert.ok(
      !isSutAlignedEnough(wrong),
      `expected reject digital-file for evidence TC, got score=${wrong.score} shared=${wrong.shared.join(",")}`
    );
  });

  it("accepts marked evidence upload SUT for TC-034-like text", () => {
    const tc = [
      "TC-034 Tải lên hình ảnh vật chứng - File mã độc",
      "path: src/Evidence/EvidenceImageUploadService.cs",
      "code: EvidenceImageUploadService",
      "malwareOrInvalid=true",
    ].join("\n");
    const good = sutTcAlignmentScore({
      tcText: tc,
      primaryPath: "src/Evidence/EvidenceImageUploadService.cs",
      sourceExcerpt:
        "public class EvidenceImageUploadService { public Result Upload(Stream file, bool malwareScan) {} }",
    });
    assert.ok(isSutAlignedEnough(good));
  });

  it("flags invented BR / AllowedExtensions smells", () => {
    const smells = findInventedRuleSmells(
      "class Br28AllowedExtensions { static AllowedExtensions = new[] { \".pdf\" }; }",
      "public class UploadService { }"
    );
    assert.ok(smells.length >= 1);
  });

  it("flags non-portable test harness imports/traits", () => {
    const smells = findNonPortableTestHarnessSmells(
      "using Acme.Test.Common;\n[Trait(TestTrait.Category, TestTrait.Unit)]\npublic class X {}"
    );
    assert.ok(smells.length >= 2, smells.join(" | "));
  });

  it("assertUnitGenQuality passes grounded csharp", () => {
    assertUnitGenQuality({
      relPath: "AItest/UnitTest/M/Foo_84af.cs",
      code: "using Xunit;\npublic class Foo_84af { [Fact] public void Ok() { var x = new EvidenceCreateModal(); } }",
      tcText: "Evidence create modal seizure time",
      primaryPath: "src/EvidenceCreateModal.cs",
      sutExcerpt: "public class EvidenceCreateModal { public string SeizureTime { get; set; } }",
    });
  });

  it("assertUnitGenQuality rejects non-portable test harness usage", () => {
    assert.throws(() =>
      assertUnitGenQuality({
        relPath: "AItest/UnitTest/M/Foo_84af.cs",
        code: "using Xunit;\nusing Acme.Test.Common;\n[Trait(TestTrait.Category, TestTrait.Unit)]\npublic class Foo_84af { [Fact] public void Ok() {} }",
        tcText: "Evidence create modal seizure time",
        primaryPath: "src/EvidenceCreateModal.cs",
        sutExcerpt: "public class EvidenceCreateModal { public string SeizureTime { get; set; } }",
      })
    );
  });

  it("detects FluentAssertions package from usings", () => {
    const pkgs = detectCsharpPackagesFromTestCode(
      "using FluentAssertions;\nusing Xunit;\nx.Should().BeTrue();"
    );
    assert.ok(pkgs.includes("FluentAssertions"));
  });

  it("detects Account vs Evidence domain conflict via aliases", () => {
    const tc =
      "Tạo mới vật chứng - Kiểm tra mã vật chứng trùng\nModule: Tạo mới vật chứng";
    const aliases = { "vat chung": ["Evidence"] };
    const bad = sutDomainConflict({
      tcText: tc,
      primaryPath:
        "src/App/Commands/Account/AccountCreateCommandHandler.cs",
      codeAliases: aliases,
    });
    assert.equal(bad.conflict, true);
    assert.ok(bad.expected.includes("evidence"));
    assert.ok(bad.pathDomains.includes("account"));
    assert.equal(
      isPacketSutAcceptable({
        tcText: tc,
        primaryPath:
          "src/App/Commands/Account/AccountCreateCommandHandler.cs",
        sourceExcerpt: "public class AccountCreateCommandHandler {}",
        codeAliases: aliases,
      }),
      false
    );
    const good = sutDomainConflict({
      tcText: tc,
      primaryPath:
        "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      codeAliases: aliases,
    });
    assert.equal(good.conflict, false);
  });

  it("domain conflict from path:/code: markers without project aliases", () => {
    const tc = [
      "Tạo mới vật chứng - mã trùng",
      "path: src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      "code: EvidenceCreateCommandHandler",
    ].join("\n");
    const bad = sutDomainConflict({
      tcText: tc,
      primaryPath: "src/App/Commands/Account/AccountCreateCommandHandler.cs",
    });
    assert.equal(bad.conflict, true);
    assert.ok(bad.expected.includes("evidence"));
    const good = sutDomainConflict({
      tcText: tc,
      primaryPath: "src/App/Commands/Evidence/EvidenceCreateCommandHandler.cs",
    });
    assert.equal(good.conflict, false);
  });
});
