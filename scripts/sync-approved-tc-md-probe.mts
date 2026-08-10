/**
 * One-shot: sync sample Approved TC markdown into a project root (Node fs).
 * Usage:
 *   node .../tsx scripts/sync-approved-tc-md-probe.mts "D:/Xlab/Forensic/forensic"
 */
import { buildApprovedTcMarkdownFiles } from "../desktop/src/lib/approvedTcSync/approvedTcMarkdown.ts";
import { writeApprovedTcMdFilesToDisk } from "../desktop/src/lib/approvedTcSync/writeApprovedTcMdFilesToDisk.ts";
import type { TestCase } from "../desktop/src/api/types.ts";

const root = (process.argv[2] || "").trim();
if (!root) {
  console.error('Usage: tsx scripts/sync-approved-tc-md-probe.mts "<projectRoot>"');
  process.exit(1);
}

const tc: TestCase = {
  id: "00000000-0000-0000-0000-000000000001",
  projectId: "probe",
  testCaseId: "TC-PROBE-SYNC",
  title: "AITest Sync MD probe",
  module: "general",
  type: "E2E",
  priority: "Medium",
  severity: "Minor",
  precondition: "",
  steps: "1. Probe sync",
  expectedResult: "File exists under .ai-test/test-cases",
  automationReady: true,
  isAiGenerated: true,
  reviewStatus: "Approved",
  executionStatus: "NotRun",
  createdAt: new Date().toISOString(),
};

const files = buildApprovedTcMarkdownFiles([tc]);
const result = writeApprovedTcMdFilesToDisk(root, files);
console.log(JSON.stringify({ root, ...result }, null, 2));
if (!result.written.length) process.exit(2);
