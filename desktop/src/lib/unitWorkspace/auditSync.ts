/** Best-effort sync workspace audit metadata to PostgreSQL (no file content). */

import { audit } from "../../api";
import type { UnitWorkspaceManifest, VerifyReport } from "./types";

function testType(manifest: UnitWorkspaceManifest): string {
  return manifest.artifactKind === "api" ? "api" : "unit";
}

export function syncWorkspaceRun(
  manifest: UnitWorkspaceManifest,
  opts: {
    module?: string | null;
    status?: string;
    contextSource?: string;
    agentConfidence?: number;
    agentOverride?: boolean;
  }
): void {
  void audit
    .upsertWorkspaceRun({
      projectId: manifest.projectId,
      localRunId: manifest.runId,
      testType: testType(manifest),
      testCaseId: manifest.testCaseId,
      module: opts.module ?? undefined,
      status: opts.status ?? manifest.status,
      provider: manifest.provider,
      contextSource: opts.contextSource,
      agentConfidence: opts.agentConfidence,
      agentOverride: opts.agentOverride,
    })
    .catch(() => undefined);
}

export function syncVerifyReport(manifest: UnitWorkspaceManifest, report: VerifyReport): void {
  void audit
    .postVerifyReport({
      projectId: manifest.projectId,
      localRunId: manifest.runId,
      testType: testType(manifest),
      testCaseId: manifest.testCaseId,
      overallPass: report.overallPass,
      stages: report.stages.map((s) => ({
        stage: s.stage,
        success: s.success,
        command: s.command,
        exitCode: s.exitCode,
      })),
      coverageSync: report.coverageSync ?? undefined,
    })
    .catch(() => undefined);
}

export function syncApplyAudit(
  manifest: UnitWorkspaceManifest,
  filesApplied: string[],
  success: boolean
): void {
  void audit
    .postApplyAudit({
      projectId: manifest.projectId,
      localRunId: manifest.runId,
      testType: testType(manifest),
      testCaseId: manifest.testCaseId,
      filesApplied,
      success,
    })
    .catch(() => undefined);
}
