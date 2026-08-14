/**
 * Phase 1 — portable Unit intent extraction (no Forensic paths).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  extractUnitIntent,
  unitIntentBlob,
  UNIT_INTENT_DEFS,
} from "./unitIntentAliases.js";

describe("unitIntentAliases", () => {
  it("exposes portable intent defs without product path literals", () => {
    assert.ok(UNIT_INTENT_DEFS.length >= 4);
    const dump = JSON.stringify(UNIT_INTENT_DEFS);
    assert.ok(!/Forensic|resumable-upload|ClientApp/i.test(dump));
  });

  it("TC-092 style: upload + size limit + reject → MaxFileSize patterns", () => {
    const intent = extractUnitIntent(
      {
        title: "Tải lên tệp - vượt dung lượng - Từ chối",
        module: "Tải lên tệp kỹ thuật số của vật chứng",
        steps: "Assert reject when FileSize > MaxFileSize",
        expectedResult: "ArgumentException",
        precondition: "Mock maxConfig",
        testData: "trace: NFR size limit",
      },
      {
        requirementTitle: "Vật chứng",
        projectAliases: { "vat chung": ["Evidence"] },
      }
    );

    assert.ok(intent.classes.includes("upload"));
    assert.ok(intent.classes.includes("upload_size_limit"));
    assert.ok(intent.classes.includes("reject"));
    assert.ok(intent.classes.includes("upload_resource"));
    assert.equal(intent.requiresBodyRule, true);
    assert.ok(intent.codePatterns.includes("MaxFileSize"));
    assert.ok(intent.rulePatterns.includes("MaxFileSize"));
    assert.ok(intent.rulePatterns.includes("FileSize"));
    assert.ok(intent.rulePatterns.includes("ArgumentException"));
    assert.ok(!intent.rulePatterns.includes("Upload"));
    assert.ok(intent.featureTokens.includes("Upload"));
    assert.ok(intent.featureTokens.includes("InitUpload"));
    assert.ok(intent.classFeatureTokens.includes("Upload"));
    assert.ok(intent.classFeatureTokens.includes("InitUpload"));
    // Aliases expand into featureTokens, not classFeatureTokens (pool leader).
    assert.ok(
      intent.featureTokens.some((t) => /evidence/i.test(t)),
      JSON.stringify(intent.featureTokens)
    );
    assert.ok(
      !intent.classFeatureTokens.some((t) => /^evidence$/i.test(t)),
      JSON.stringify(intent.classFeatureTokens)
    );
  });

  it("EN too-large upload maps to size-limit intent", () => {
    const intent = extractUnitIntent({
      title: "Upload file too large — reject",
      module: "Upload",
      steps: "File exceeds size limit",
      expectedResult: "BadRequest",
    });
    assert.ok(intent.classes.includes("upload_size_limit"));
    assert.ok(intent.classes.includes("upload"));
    assert.ok(intent.requiresBodyRule);
    assert.ok(intent.codePatterns.includes("exceed"));
  });

  it("plain login TC does not invent upload size-limit", () => {
    const intent = extractUnitIntent({
      title: "Đăng nhập thành công",
      module: "Người dùng",
      steps: "Nhập email mật khẩu",
      expectedResult: "Vào trang chủ",
    });
    assert.ok(!intent.classes.includes("upload_size_limit"));
    assert.ok(!intent.classes.includes("upload"));
    assert.equal(intent.requiresBodyRule, false);
  });

  it("TC-066 style: master data UI → ui_master_create + uiOnly", () => {
    const intent = extractUnitIntent({
      title: "Tạo mới Loại thiết bị khi chưa có trong master data",
      module: "Tạo mới giá trị master data thiết bị",
      steps: "Chọn thêm mới trong form",
      expectedResult: "Hiển thị trên dropdown",
    });
    assert.ok(intent.classes.includes("ui_master_create"));
    assert.equal(intent.primaryClass, "ui_master_create");
    assert.equal(intent.uiOnly, true);
  });

  it("TC-026 style: BE create success is NOT ui_master (form in steps ignored)", () => {
    const intent = extractUnitIntent({
      title: "Tạo mới vật chứng thành công",
      module: "Tạo mới vật chứng",
      steps: "Điền form tạo mới vật chứng và bấm Lưu",
      expectedResult: "Lưu thành công",
    });
    assert.ok(!intent.classes.includes("ui_master_create"), JSON.stringify(intent.classes));
    assert.equal(intent.uiOnly, false);
    assert.ok(intent.classes.includes("persist_create"));
    assert.ok(!intent.classFeatureTokens.includes("Create"));
  });

  it("Module «tạo mới» alone does not stamp persist_create on assign Function", () => {
    const intent = extractUnitIntent(
      {
        title:
          "Gán vật chứng vào hồ sơ vụ án - lọc theo quyền - Chỉ trả vụ án được tham gia hoặc quản lý",
        module: "Gán vật chứng vào hồ sơ vụ án",
        steps: "Mock repo; filter by participation",
        expectedResult: "Only joined or managed cases",
      },
      { requirementTitle: "Tạo mới vật chứng" }
    );
    assert.ok(
      !intent.classes.includes("persist_create"),
      JSON.stringify(intent.classes)
    );
    assert.ok(
      !intent.classes.includes("state_enable"),
      JSON.stringify(intent.classes)
    );
  });

  it("Steps «ngăn lưu trữ» must not flip create-success TC to state_enable", () => {
    const intent = extractUnitIntent(
      {
        title:
          "Tạo mới vật chứng - Tạo thành công với dữ liệu hợp lệ - Trả về vật chứng mới",
        module: "Tạo mới vật chứng",
        steps:
          "Chuẩn bị input hợp lệ (tủ/ngăn lưu trữ) và mock cổng lưu trữ trả về thành công",
        expectedResult: "Trả về vật chứng mới được tạo",
        testData: "input=tủ và ngăn hợp lệ",
      },
      { requirementTitle: "Tạo mới vật chứng" }
    );
    assert.ok(
      !intent.classes.includes("state_enable"),
      JSON.stringify(intent.classes)
    );
    assert.equal(intent.primaryClass, "persist_create");
    assert.ok(!intent.rulePatterns.some((p) => /IsOccupied/i.test(p)));
  });

  it("Title occupancy cues still select state_enable (real TC)", () => {
    const intent = extractUnitIntent({
      title: "Tao moi vat chung - Loc ngan luu tru - Chi enable ngan trong",
      module: "Tao moi vat chung",
      steps: "ignored ngan luu tru noise",
    });
    assert.equal(intent.primaryClass, "state_enable");
  });

  it("unitIntentBlob strips diacritics for cue match", () => {
    const blob = unitIntentBlob({
      title: "Vượt dung lượng",
      module: "Tải lên",
    });
    assert.match(blob, /vuot dung luong/);
    assert.match(blob, /tai len/);
  });

  it("VALIDATION trace alone does not force validate_reject", () => {
    const intent = extractUnitIntent({
      title: "Create widget - filter empty slots - enable only",
      module: "Create widget",
      steps: "Assert empty slots enabled",
      expectedResult: "Occupied slots disabled",
      testData: "trace: BR/BR-15; VALIDATION/Slot filter",
    });
    assert.ok(!intent.classes.includes("validate_reject"), JSON.stringify(intent.classes));
  });

  it("TC-042 style: loc ngan / enable trong → state_enable + IsOccupied", () => {
    const intent = extractUnitIntent({
      title: "Tao moi vat chung - Loc ngan luu tru - Chi enable ngan trong",
      module: "Tao moi vat chung",
      steps: "Goi don vi tinh enable/disable ngan",
      expectedResult: "Ngan trong enable; ngan da chua disable",
      testData: "trace: VALIDATION/Ngan",
    });
    assert.ok(intent.classes.includes("state_enable"), JSON.stringify(intent.classes));
    assert.equal(intent.primaryClass, "state_enable");
    assert.ok(intent.rulePatterns.some((p) => /IsOccupied/i.test(p)));
    assert.ok(!intent.classes.includes("validate_reject"));
  });

  it("TC-018 style: empty code + tu sinh → auto_generate_code (not reject)", () => {
    const intent = extractUnitIntent({
      title: "Tạo mới vật chứng - Để trống mã vật chứng - Hệ thống tự sinh mã",
      module: "Tạo mới vật chứng",
      steps: "Để trống mã và lưu",
      expectedResult: "Hệ thống tự sinh mã",
    });
    assert.ok(intent.classes.includes("auto_generate_code"), JSON.stringify(intent.classes));
    assert.equal(intent.primaryClass, "auto_generate_code");
    assert.equal(intent.requiresBodyRule, true);
    assert.ok(intent.rulePatterns.some((p) => /IsNullOrWhiteSpace/i.test(p)));
    assert.ok(!intent.classes.includes("validate_reject"));
  });

  it("duplicate / empty-code cues → validate_reject without product *Code nouns", () => {
    const intent = extractUnitIntent({
      title: "Create widget - kiem tra ma trung - tu choi",
      module: "Create widget",
      steps: "Input duplicate code; assert reject",
      expectedResult: "BadRequest when code exists",
    });
    assert.ok(intent.classes.includes("validate_reject"), JSON.stringify(intent.classes));
    assert.ok(intent.rulePatterns.some((p) => /BadRequest|CheckCode|Duplicate|AlreadyExists/i.test(p)));
    assert.ok(!intent.featureTokens.some((t) => /EvidenceCode/i.test(t)));
  });

  it("TC-043 style: tim kiem / case-insensitive → search_lookup + SearchTerm", () => {
    const intent = extractUnitIntent({
      title:
        "Tao moi widget - Tim nguoi lien quan gan dung - Khong phan biet hoa thuong va cho tao moi",
      module: "Tao moi widget",
      steps: "Goi tim kiem theo ten; assert ToLower Contains; cho tao moi neu khong ton tai",
      expectedResult: "Danh sach gan dung; cho phep tao moi",
    });
    assert.ok(intent.classes.includes("search_lookup"), JSON.stringify(intent.classes));
    assert.equal(intent.primaryClass, "search_lookup");
    assert.ok(intent.rulePatterns.some((p) => /SearchTerm|Contains|ToLower/i.test(p)));
  });
});
