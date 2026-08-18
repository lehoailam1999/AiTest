/**
 * Persist Generate / Verify error logs under `.ai-test/…/logs/`.
 */
import { readTextFile, writeTextFile } from "../../tauri/bridge";
import { aiTestDir, workspaceRunDir } from "./paths";
import { readDraftText, writeDraftText } from "./draftStore";

function safeTcFileId(testCaseId: string): string {
  return (testCaseId || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 96) || "unknown";
}

/** Per-run Verify stage dump (same layout as single-unit verifyEngine). */
export function unitVerifyLogRel(runId: string, packagePrefix?: string | null): string {
  return `${workspaceRunDir(runId, packagePrefix)}/logs/verify.log`;
}

/** Per-run attributed failure excerpt for Chi tiết lỗi. */
export function unitErrorLogRel(runId: string, packagePrefix?: string | null): string {
  return `${workspaceRunDir(runId, packagePrefix)}/logs/error.log`;
}

/** Generate failure when no staging runId yet. */
export function generateErrorLogRel(
  testCaseId: string,
  packagePrefix?: string | null
): string {
  return `${aiTestDir(packagePrefix)}/logs/generate-errors/${safeTcFileId(testCaseId)}.log`;
}

export async function saveErrorLogFile(
  projectRoot: string,
  rel: string,
  body: string
): Promise<string> {
  const text = (body || "").trimEnd() + "\n";
  if (rel.replace(/\\/g, "/").startsWith("unit-runs/")) {
    await writeDraftText(projectRoot, rel, text);
  } else {
    await writeTextFile(projectRoot, rel, text);
  }
  return rel;
}

export async function readErrorLogFile(
  projectRoot: string,
  rel: string
): Promise<string> {
  if (rel.replace(/\\/g, "/").startsWith("unit-runs/")) {
    return readDraftText(projectRoot, rel);
  }
  return readTextFile(projectRoot, rel);
}

export function formatVerifyStagesLog(
  stages: Array<{ stage: string; success: boolean; logExcerpt?: string }>
): string {
  return stages
    .map(
      (s) =>
        `=== ${s.stage} (${s.success ? "PASS" : "FAIL"}) ===\n${s.logExcerpt || ""}`
    )
    .join("\n\n");
}
