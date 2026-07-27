/**
 * Step 4 — after Verify, sync coverage/junit artifacts to PostgreSQL.
 */
import { reporting } from "../../api";
import type { CoverageSyncSnapshot, UnitWorkspaceManifest, VerifyReport } from "./types";

export async function syncCoverageAfterVerify(
  manifest: UnitWorkspaceManifest,
  projectRoot: string,
  report?: VerifyReport
): Promise<CoverageSyncSnapshot | null> {
  const coverageStage = report?.stages.find((s) => s.stage === "coverage");
  // Skip when verify failed and no coverage stage ran (unlikely to have fresh reports).
  if (report && !report.overallPass && !coverageStage) {
    return null;
  }

  try {
    const res = await reporting.syncCoverageFromDisk(manifest.projectId, {
      projectRoot,
      packagePrefix: manifest.packagePrefix ?? "",
      packageName: manifest.packageName,
      localRunId: manifest.runId,
      testCaseId: manifest.testCaseId,
      createReport: true,
    });
    if (!res.uploaded) {
      return { uploaded: 0 };
    }
    return {
      uploaded: res.uploaded ?? 0,
      linePct: res.coverage?.linePct ?? res.uploads?.[0]?.linePct ?? null,
      format: res.coverage?.format ?? res.uploads?.[0]?.format ?? null,
      reportId: res.reportId ?? null,
      junit: res.junit
        ? {
            tests: res.junit.tests,
            passed: res.junit.passed,
            failed: res.junit.failed,
          }
        : null,
    };
  } catch {
    return null;
  }
}
