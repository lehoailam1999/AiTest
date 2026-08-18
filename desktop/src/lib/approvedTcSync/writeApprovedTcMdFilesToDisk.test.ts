/**
 * Sync MD disk writer + markdown path — no Tauri needed.
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it } from "node:test";
import type { TestCase } from "../../api/types";
import { buildApprovedTcMarkdownFiles } from "./approvedTcMarkdown.js";
import { writeApprovedTcMdFilesToDisk } from "./writeApprovedTcMdFilesToDisk.js";

function sample(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "22222222-2222-2222-2222-222222222222",
    projectId: "p1",
    testCaseId: "TC-SYNC-01",
    title: "Sync MD probe",
    module: "account",
    type: "E2E",
    priority: "High",
    severity: "Major",
    precondition: "ready",
    steps: "1. Go\n2. Click",
    expectedResult: "ok",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("writeApprovedTcMdFilesToDisk", () => {
  it("writes E2E under AItest/test-cases/E2ETest/{module}/{code}.md", () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-tc-sync-"));
    try {
      const files = buildApprovedTcMarkdownFiles([sample()]);
      assert.equal(files.length, 1);
      assert.equal(files[0].path, "AItest/test-cases/E2ETest/account/TC-SYNC-01.md");

      const result = writeApprovedTcMdFilesToDisk(root, files);
      assert.equal(result.errors.length, 0, result.errors.join("; "));
      assert.equal(result.written.length, 1);

      const abs = join(root, "AItest", "test-cases", "E2ETest", "account", "TC-SYNC-01.md");
      assert.equal(existsSync(abs), true);
      const body = readFileSync(abs, "utf8");
      assert.match(body, /Sync MD probe/);
      assert.match(body, /reviewStatus: Approved/);
      assert.match(body, /## Steps/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("writes Unit under AItest/test-cases/UnitTest/{module}/{code}.md", () => {
    const root = mkdtempSync(join(tmpdir(), "aitest-tc-sync-unit-"));
    try {
      const files = buildApprovedTcMarkdownFiles([sample({ type: "Unit", testCaseId: "TC-U-SYNC" })]);
      assert.equal(files[0].path, "AItest/test-cases/UnitTest/account/TC-U-SYNC.md");
      const result = writeApprovedTcMdFilesToDisk(root, files);
      assert.equal(result.errors.length, 0, result.errors.join("; "));
      const abs = join(root, "AItest", "test-cases", "UnitTest", "account", "TC-U-SYNC.md");
      assert.equal(existsSync(abs), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("skips Draft so empty files means nothing to write", () => {
    const files = buildApprovedTcMarkdownFiles([sample({ reviewStatus: "Draft" })]);
    assert.equal(files.length, 0);
  });
});
