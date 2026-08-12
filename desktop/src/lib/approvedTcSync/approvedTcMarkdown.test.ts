import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  approvedTcMarkdownRelPath,
  buildApprovedTcMarkdownFiles,
  parseApprovedTcGrounding,
  renderApprovedTestCaseMarkdown,
} from "./approvedTcMarkdown.js";
import type { TestCase } from "../../api/types";

function sample(overrides: Partial<TestCase> = {}): TestCase {
  return {
    id: "11111111-1111-1111-1111-111111111111",
    projectId: "p1",
    testCaseId: "TC-LOGIN-01",
    title: "Login happy path",
    module: "account",
    type: "E2E",
    priority: "High",
    severity: "Major",
    precondition: "User exists",
    steps: "1. Open /login\n2. Submit",
    expectedResult: "Dashboard visible",
    testData: "admin/admin",
    automationReady: true,
    isAiGenerated: true,
    reviewStatus: "Approved",
    executionStatus: "NotRun",
    createdAt: "2026-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("approvedTcMarkdown", () => {
  it("builds E2E path under .ai-test/test-cases/E2ETest", () => {
    const p = approvedTcMarkdownRelPath(sample());
    assert.equal(p, ".ai-test/test-cases/E2ETest/account/TC-LOGIN-01.md");
  });

  it("builds Unit path under .ai-test/test-cases/UnitTest", () => {
    const p = approvedTcMarkdownRelPath(sample({ type: "Unit", testCaseId: "TC-U-01" }));
    assert.equal(p, ".ai-test/test-cases/UnitTest/account/TC-U-01.md");
  });

  it("skips non-Approved", () => {
    const files = buildApprovedTcMarkdownFiles([
      sample({ reviewStatus: "Draft" }),
      sample({ reviewStatus: "Approved", testCaseId: "TC-2" }),
    ]);
    assert.equal(files.length, 1);
    assert.match(files[0].content, /Login happy path/);
    assert.match(files[0].content, /## Steps/);
  });

  it("render includes frontmatter", () => {
    const md = renderApprovedTestCaseMarkdown(sample());
    assert.match(md, /^---\n/);
    assert.match(md, /testCaseId: TC-LOGIN-01/);
    assert.match(md, /reviewStatus: Approved/);
  });

  it("includes Module + Function Grounding progressive resolve block for Unit", () => {
    const md = renderApprovedTestCaseMarkdown(sample({ type: "Unit", module: "Phân loại VTKT" }), {
      requirementTitle: "Vật chứng",
    });
    assert.match(md, /requirement: Vật chứng/);
    assert.match(md, /## Grounding \(Unit Gen\)/);
    assert.match(md, /requirement: Vật chứng/);
    assert.match(md, /function: Phân loại VTKT/);
    assert.match(md, /module: Phân loại VTKT/);
    assert.match(md, /\| Module \| Vật chứng \|/);
    assert.match(md, /\| Function \| Phân loại VTKT \|/);
    assert.match(md, /Primary SUT below is authoritative for Gen/);
    assert.match(md, /### Resolved SUT/);
    assert.match(md, /Module → Function → Title/);
    const g = parseApprovedTcGrounding(md);
    assert.equal(g.requirement, "Vật chứng");
    assert.equal(g.module, "Phân loại VTKT");
  });

  it("includes E2E Grounding block for E2E TC", () => {
    const md = renderApprovedTestCaseMarkdown(
      sample({
        type: "E2E",
        module: "vật chứng",
        testData: "path: /admin/evidence\nauthRole: Admin\nlandmark: Danh sách vật chứng",
      }),
      { requirementTitle: "Quản lý vật chứng" }
    );
    assert.match(md, /## Grounding \(E2E Gen\)/);
    assert.match(md, /path: \/admin\/evidence/);
    assert.match(md, /authRole: Admin/);
    assert.match(md, /landmark: Danh sách vật chứng/);
    const g = parseApprovedTcGrounding(md);
    assert.equal(g.requirement, "Quản lý vật chứng");
    assert.equal(g.module, "vật chứng");
    assert.equal(g.path, "/admin/evidence");
    assert.equal(g.authRole, "Admin");
    assert.equal(g.landmark, "Danh sách vật chứng");
  });

  it("does not fall back Module (requirement) to Function", () => {
    const md = renderApprovedTestCaseMarkdown(
      sample({ type: "Unit", module: "Chọn vị trí lưu trữ vật chứng" })
    );
    assert.match(md, /\| Module \| — \|/);
    assert.match(md, /requirement: —/);
    assert.match(md, /function: Chọn vị trí lưu trữ vật chứng/);
    assert.match(md, /module: Chọn vị trí lưu trữ vật chứng/);
  });

  it("parses function alias from grounding", () => {
    const g = parseApprovedTcGrounding(`## Grounding (Unit Gen)

requirement: Tạo mới vật chứng
function: Gán vật chứng vào hồ sơ vụ án
title: validate bắt buộc
`);
    assert.equal(g.requirement, "Tạo mới vật chứng");
    assert.equal(g.module, "Gán vật chứng vào hồ sơ vụ án");
  });
});

