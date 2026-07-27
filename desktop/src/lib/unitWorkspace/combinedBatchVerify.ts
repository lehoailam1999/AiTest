import { runTestCommand, runDotnetTest } from "../../tauri/bridge";
import {
  captureStagingBackups,
  rollbackStaging,
  stageOverlayToTargets,
} from "./staging";
import { saveManifest } from "./manager";
import type { UnitWorkspaceManifest, VerifyReport, VerifyStageResult } from "./types";

async function runShell(projectRoot: string, command: string) {
  const cmd = command.trim();
  if (!cmd) {
    return {
      success: true,
      exitCode: 0,
      durationMs: 0,
      log: "(skip)",
      command: "",
    };
  }
  if (/^dotnet\s+test\b/i.test(cmd)) {
    const r = await runDotnetTest(projectRoot);
    return {
      success: r.success,
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      log: r.log,
      command: r.command || cmd,
    };
  }
  const r = await runTestCommand(projectRoot, cmd);
  return {
    success: r.success,
    exitCode: r.exitCode,
    durationMs: r.durationMs,
    log: r.log,
    command: r.command || cmd,
  };
}

/**
 * Stage every batch job's overlay, run ONE test command for all AItest files, then rollback.
 */
export async function runCombinedBatchVerify(input: {
  projectRoot: string;
  manifests: UnitWorkspaceManifest[];
  compileCommand?: string;
  testCommand: string;
}): Promise<{
  success: boolean;
  stages: VerifyStageResult[];
  updatedManifests: UnitWorkspaceManifest[];
}> {
  const { projectRoot, manifests } = input;
  if (!manifests.length) {
    throw new Error("Không có staging để verify.");
  }
  if (!input.testCommand.trim()) {
    throw new Error("Cần lệnh test.");
  }

  const backupBags: Array<{
    manifest: UnitWorkspaceManifest;
    backups: Awaited<ReturnType<typeof captureStagingBackups>>;
  }> = [];

  const stages: VerifyStageResult[] = [];

  try {
    for (const m of manifests) {
      const backups = await captureStagingBackups(projectRoot, m);
      backupBags.push({ manifest: m, backups });
      await stageOverlayToTargets(projectRoot, m);
    }

    const compileCmd = (input.compileCommand ?? "").trim();
    if (compileCmd) {
      const compileRun = await runShell(projectRoot, compileCmd);
      stages.push({
        stage: "compile",
        success: compileRun.success,
        command: compileRun.command,
        exitCode: compileRun.exitCode,
        durationMs: compileRun.durationMs,
        // Keep more log for batch UI console (last ~80k)
        logExcerpt: compileRun.log.slice(-80_000),
      });
      if (!compileRun.success) {
        const report: VerifyReport = {
          ranAt: new Date().toISOString(),
          overallPass: false,
          stages: stages.map((s) => ({
            ...s,
            logExcerpt: s.logExcerpt.slice(-12_000),
          })),
        };
        const updated = await Promise.all(
          manifests.map(async (m) => {
            const next = { ...m, status: "fail" as const, verify: report };
            await saveManifest(projectRoot, next);
            return next;
          })
        );
        return { success: false, stages, updatedManifests: updated };
      }
    }

    const testRun = await runShell(projectRoot, input.testCommand);
    stages.push({
      stage: "test",
      success: testRun.success,
      command: testRun.command,
      exitCode: testRun.exitCode,
      durationMs: testRun.durationMs,
      logExcerpt: testRun.log.slice(-80_000),
    });

    const overallPass = testRun.success;
    const report: VerifyReport = {
      ranAt: new Date().toISOString(),
      overallPass,
      stages: stages.map((s) => ({
        ...s,
        logExcerpt: s.logExcerpt.slice(-12_000),
      })),
    };
    const updated = await Promise.all(
      manifests.map(async (m) => {
        const next: UnitWorkspaceManifest = {
          ...m,
          status: overallPass ? "pass" : "fail",
          verify: report,
        };
        await saveManifest(projectRoot, next);
        return next;
      })
    );
    return { success: overallPass, stages, updatedManifests: updated };
  } finally {
    for (const bag of backupBags) {
      try {
        await rollbackStaging(
          projectRoot,
          bag.manifest.runId,
          bag.backups,
          bag.manifest.packagePrefix
        );
      } catch {
        /* best-effort */
      }
    }
  }
}
