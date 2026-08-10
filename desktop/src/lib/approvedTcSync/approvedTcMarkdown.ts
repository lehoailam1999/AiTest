/**
 * Phase C — serialize Approved TestCase → Markdown under `.ai-test/test-cases/`.
 * Artifact for Agent local / audit — Gen API Phase A vẫn lấy TC từ DB.
 */
import { AI_TEST_CASES_DIR, assertSafeAiTestCasesRel } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { TEST_CASES_DIR } from "../projectProfile/constants";

function slugSeg(raw: string, fallback: string): string {
  const s = (raw || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return s || fallback;
}

/** Relative path: `.ai-test/test-cases/{module}/{testCaseId}.md` */
export function approvedTcMarkdownRelPath(tc: Pick<TestCase, "testCaseId" | "module" | "id">): string {
  const moduleSeg = slugSeg(tc.module || "general", "general");
  const codeSeg = slugSeg(tc.testCaseId || tc.id, tc.id.slice(0, 8));
  const rel = `${TEST_CASES_DIR}/${moduleSeg}/${codeSeg}.md`;
  return assertSafeAiTestCasesRel(rel);
}

function yamlEscape(v: string): string {
  if (/[:#\n"'\\]/.test(v) || v.trim() !== v) {
    return JSON.stringify(v);
  }
  return v;
}

export function renderApprovedTestCaseMarkdown(tc: TestCase): string {
  const lines: string[] = [
    "---",
    `id: ${yamlEscape(tc.id)}`,
    `testCaseId: ${yamlEscape(tc.testCaseId)}`,
    `title: ${yamlEscape(tc.title)}`,
    `module: ${yamlEscape(tc.module || "")}`,
    `type: ${yamlEscape(tc.type)}`,
    `priority: ${yamlEscape(tc.priority)}`,
    `severity: ${yamlEscape(tc.severity)}`,
    `reviewStatus: ${yamlEscape(tc.reviewStatus)}`,
    `projectId: ${yamlEscape(tc.projectId)}`,
    "---",
    "",
    `# ${tc.title}`,
    "",
    "## Meta",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Code | \`${tc.testCaseId}\` |`,
    `| Module | ${tc.module || "—"} |`,
    `| Type | ${tc.type} |`,
    `| Priority | ${tc.priority} |`,
    `| Severity | ${tc.severity} |`,
    `| Review | ${tc.reviewStatus} |`,
    "",
    "## Precondition",
    "",
    (tc.precondition || "").trim() || "_(none)_",
    "",
    "## Steps",
    "",
    (tc.steps || "").trim() || "_(none)_",
    "",
    "## Expected Result",
    "",
    (tc.expectedResult || "").trim() || "_(none)_",
    "",
  ];
  if ((tc.testData || "").trim()) {
    lines.push("## Test Data", "", (tc.testData || "").trim(), "");
  }
  lines.push(
    "<!-- aitest:approved-tc-artifact — SoT Gen vẫn là DB Approved; file này đồng bộ cho Agent/IDE -->",
    ""
  );
  return lines.join("\n");
}

export type ApprovedTcMdFile = { path: string; content: string; testCaseId: string };

/** Only Approved (case-insensitive) — empty list if none. */
export function buildApprovedTcMarkdownFiles(cases: TestCase[]): ApprovedTcMdFile[] {
  const out: ApprovedTcMdFile[] = [];
  for (const tc of cases) {
    if (String(tc.reviewStatus || "").toLowerCase() !== "approved") continue;
    const path = approvedTcMarkdownRelPath(tc);
    out.push({
      path,
      content: renderApprovedTestCaseMarkdown(tc),
      testCaseId: tc.testCaseId,
    });
  }
  return out;
}

export { AI_TEST_CASES_DIR, TEST_CASES_DIR };
