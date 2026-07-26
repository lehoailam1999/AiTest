import { runDotnetTest, runTestCommand, writeTextFile, type TestRunResult } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncVerifyReport } from "./auditSync";
import { captureStagingBackups, rollbackStaging, stageOverlayToTargets } from "./staging";
import type {
  UnitWorkspaceManifest,
  VerifyReport,
  VerifyStageName,
  VerifyStageResult,
} from "./types";
import { workspaceRunDir } from "./paths";

const LOG_MAX = 12_000;

function trimLog(log: string): string {
  if (log.length <= LOG_MAX) return log;
  return log.slice(-LOG_MAX);
}

function stageFromRun(
  stage: VerifyStageName,
  command: string,
  result: TestRunResult
): VerifyStageResult {
  return {
    stage,
    success: result.success,
    command,
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    logExcerpt: trimLog(result.log),
  };
}

async function runShellCommand(
  projectRoot: string,
  command: string,
  dotnetFilter?: string
): Promise<TestRunResult> {
  const cmd = command.trim();
  if (!cmd) {
    return {
      exitCode: 0,
      success: true,
      passed: 0,
      failed: 0,
      skipped: 0,
      total: 0,
      durationMs: 0,
      log: "(bỏ qua — không có lệnh)",
      command: "",
      startedAt: "",
      finishedAt: "",
    };
  }
  if (/^dotnet\s+test\b/i.test(cmd)) {
    return runDotnetTest(projectRoot, dotnetFilter);
  }
  return runTestCommand(projectRoot, cmd);
}

export type RunVerifyInput = {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
  compileCommand?: string;
  testCommand: string;
  coverageCommand?: string;
  dotnetFilter?: string;
};

export async function runWorkspaceVerify(input: RunVerifyInput): Promise<{
  manifest: UnitWorkspaceManifest;
  report: VerifyReport;
}> {
  const { projectRoot, manifest } = input;
  if (!manifest.files.length) {
    throw new Error("Workspace không có file để verify.");
  }

  let working: UnitWorkspaceManifest = { ...manifest, status: "verifying" };
  await saveManifest(projectRoot, working);

  const stages: VerifyStageResult[] = [];
  let backups = await captureStagingBackups(projectRoot, manifest);

  try {
    await stageOverlayToTargets(projectRoot, manifest);

    const compileCmd = (input.compileCommand ?? "").trim();
    if (compileCmd) {
      const compileRun = await runShellCommand(projectRoot, compileCmd);
      stages.push(stageFromRun("compile", compileCmd, compileRun));
      if (!compileRun.success) {
        const report: VerifyReport = {
          ranAt: new Date().toISOString(),
          overallPass: false,
          stages,
        };
        working = { ...manifest, status: "fail", verify: report };
        await saveManifest(projectRoot, working);
        syncVerifyReport(working, report);
        return { manifest: working, report };
      }
    }

    const testCmd = input.testCommand.trim();
    if (!testCmd) {
      throw new Error("Cần lệnh test để verify.");
    }
    const testRun = await runShellCommand(projectRoot, testCmd, input.dotnetFilter);
    stages.push(stageFromRun("test", testCmd, testRun));

    let overallPass = testRun.success;

    const covCmd = (input.coverageCommand ?? "").trim();
    if (covCmd && overallPass) {
      const covRun = await runShellCommand(projectRoot, covCmd);
      stages.push(stageFromRun("coverage", covCmd, covRun));
      overallPass = overallPass && covRun.success;
    }

    const report: VerifyReport = {
      ranAt: new Date().toISOString(),
      overallPass,
      stages,
    };
    working = {
      ...manifest,
      status: overallPass ? "pass" : "fail",
      verify: report,
    };
    await saveManifest(projectRoot, working);

    syncVerifyReport(working, report);

    const logBody = stages.map((s) => `=== ${s.stage} (${s.success ? "PASS" : "FAIL"}) ===\n${s.logExcerpt}`).join("\n\n");
    await writeTextFile(
      projectRoot,
      `${workspaceRunDir(manifest.runId, manifest.packagePrefix)}/logs/verify.log`,
      logBody
    );

    return { manifest: working, report };
  } finally {
    await rollbackStaging(projectRoot, manifest.runId, backups, manifest.packagePrefix);
  }
}
