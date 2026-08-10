import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { resolveRelatedSourcesFromDisk } from "../../../../ide-plugins/vscode/src/unitGenRelatedSources.ts";

describe("resolveRelatedSourcesFromDisk", () => {
  it("ranks files matching TC title tokens", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-"));
    try {
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(
        join(root, "src", "services", "EvidenceService.ts"),
        "export class EvidenceService { create() {} }",
        "utf8"
      );
      writeFileSync(join(root, "src", "util.ts"), "export const x = 1;", "utf8");
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title: "Evidence service create",
        module: "Evidence",
        tcMd: "# Evidence\npath: src/services/EvidenceService.ts\ncode: EvidenceService",
      });
      assert.ok(hit.primaryPath?.includes("EvidenceService"), JSON.stringify(hit));
      assert.match(hit.source || "", /EvidenceService/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("rejects unrelated primary when alignment too low", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-bad-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "AccountActivateCommandHandler.cs"),
        "public class AccountActivateCommandHandler {}",
        "utf8"
      );
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title: "Thời gian thu giữ mặc định khi tạo mới",
        module: "Evidence",
        tcMd: "## Expected\nSeizureTime default DD/MM/YYYY on new evidence form",
      });
      assert.equal(hit.primaryPath, undefined);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves VI title via codeAliases to EvidenceService", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-alias-"));
    try {
      mkdirSync(join(root, "src", "Evidence"), { recursive: true });
      mkdirSync(join(root, "src", "Account"), { recursive: true });
      writeFileSync(
        join(root, "src", "Evidence", "CreateEvidenceCommandHandler.cs"),
        "public class CreateEvidenceCommandHandler { public void Handle() {} }",
        "utf8"
      );
      writeFileSync(
        join(root, "src", "Account", "AccountCreateCommandHandler.cs"),
        "public class AccountCreateCommandHandler {}",
        "utf8"
      );
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title: "Tạo mới vật chứng - Nhập mã vật chứng trùng - Từ chối lưu",
        module: "Vật chứng",
        testCaseId: "TC-065",
        codeAliases: { "vat chung": ["Evidence"] },
      });
      assert.ok(
        hit.primaryPath?.includes("CreateEvidence") ||
          hit.primaryPath?.includes("Evidence"),
        JSON.stringify(hit)
      );
      assert.ok(
        !hit.primaryPath?.includes("Account"),
        `must not pick Account, got ${hit.primaryPath}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("finds SUT beyond first 120 walked files", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-deep-"));
    try {
      mkdirSync(join(root, "src", "pad"), { recursive: true });
      for (let i = 0; i < 150; i++) {
        writeFileSync(
          join(root, "src", "pad", `Pad${i}.ts`),
          `export const pad${i} = ${i};`,
          "utf8"
        );
      }
      mkdirSync(join(root, "src", "services"), { recursive: true });
      writeFileSync(
        join(root, "src", "services", "EvidenceService.ts"),
        "export class EvidenceService { create() {} }",
        "utf8"
      );
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title: "Evidence service create",
        module: "Evidence",
        codeAliases: { evidence: ["Evidence"] },
      });
      assert.ok(
        hit.primaryPath?.includes("EvidenceService"),
        JSON.stringify(hit)
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("does not latch digital-file form for evidence image upload TC", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-df-"));
    try {
      mkdirSync(join(root, "src", "app", "admin", "digital-file", "update"), {
        recursive: true,
      });
      writeFileSync(
        join(
          root,
          "src",
          "app",
          "admin",
          "digital-file",
          "update",
          "digital-file-form.service.ts"
        ),
        "export class DigitalFileFormService { update() {} }",
        "utf8"
      );
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title:
          "Tải lên hình ảnh vật chứng - File mã độc hoặc định dạng không hợp lệ - Từ chối",
        module: "Tải lên và xóa hình ảnh vật chứng",
        testCaseId: "TC-034",
        tcMd: [
          "# TC-034",
          "Mock bộ quét mã độc/validator",
          "Gọi đơn vị upload hình ảnh vật chứng",
          "trace: FEATURES/Tải lên và xóa hình ảnh vật chứng; malwareOrInvalid=true",
        ].join("\n"),
      });
      assert.equal(
        hit.primaryPath,
        undefined,
        `should fail-closed, got ${hit.primaryPath} score=${hit.alignmentScore}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("scopes by requirement then module over unrelated Create handlers (TC-032 style)", async () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-rel-ground-"));
    try {
      mkdirSync(join(root, "src", "Evidence", "Classification"), { recursive: true });
      mkdirSync(join(root, "src", "Account"), { recursive: true });
      writeFileSync(
        join(
          root,
          "src",
          "Evidence",
          "Classification",
          "DigitalEvidenceClassificationForm.ts"
        ),
        "export class DigitalEvidenceClassificationForm { isDigitalChecked = true; }",
        "utf8"
      );
      writeFileSync(
        join(root, "src", "Account", "AccountCreateCommandHandler.cs"),
        "public class AccountCreateCommandHandler {}",
        "utf8"
      );
      writeFileSync(
        join(root, "src", "Evidence", "CreateEvidenceCommandHandler.cs"),
        "public class CreateEvidenceCommandHandler {}",
        "utf8"
      );
      const md = [
        "---",
        "requirement: Phân loại vật chứng kỹ thuật số",
        "module: Phân loại vật chứng kỹ thuật số",
        "title: Giá trị mặc định Checked - Hiển thị trường mô tả thiết bị kỹ thuật số",
        "---",
        "## Grounding (Unit Gen)",
        "requirement: Phân loại vật chứng kỹ thuật số",
        "module: Phân loại vật chứng kỹ thuật số",
        "title: Giá trị mặc định Checked - Hiển thị trường mô tả thiết bị kỹ thuật số",
      ].join("\n");
      const hit = await resolveRelatedSourcesFromDisk(root, {
        title: "Giá trị mặc định Checked - Hiển thị trường mô tả thiết bị kỹ thuật số",
        module: "Phân loại vật chứng kỹ thuật số",
        testCaseId: "TC-032",
        tcMd: md,
        codeAliases: {
          "vat chung ky thuat so": ["DigitalEvidence", "Classification"],
          "thiet bi ky thuat so": ["DigitalEvidence", "Classification"],
          "phan loai": ["Classification"],
        },
      });
      assert.ok(
        hit.primaryPath?.includes("DigitalEvidenceClassification") ||
          hit.primaryPath?.includes("Classification"),
        JSON.stringify(hit)
      );
      assert.ok(
        !hit.primaryPath?.includes("Account"),
        `must not pick Account, got ${hit.primaryPath}`
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
