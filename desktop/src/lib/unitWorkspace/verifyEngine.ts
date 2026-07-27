import { runDotnetTest, runTestCommand, writeTextFile, readTextFile, type TestRunResult } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncVerifyReport } from "./auditSync";
import { syncCoverageAfterVerify } from "./coverageSync";
import { captureStagingBackups, rollbackStaging, stageOverlayToTargets } from "./staging";
import type {
  UnitWorkspaceManifest,
  VerifyReport,
  VerifyStageName,
  VerifyStageResult,
} from "./types";
import { workspaceRunDir } from "./paths";
import {
  buildAitestJestCommand,
  ensureAitestJestTsconfigInWorkspace,
  isDefaultNpmJestCommand,
  looksLikeJestTsTest,
  manifestHasAitestTests,
} from "./ensureAitestJestTsconfig";
import { rewriteSutImports } from "../testOutputLayout";

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
  let backups: Awaited<ReturnType<typeof captureStagingBackups>> = [];

  try {
    // Refresh Jest scaffold + rewrite imports so verify works on any Nest/TS project.
    if (manifestHasAitestTests(working)) {
      const testEntry = working.files.find(
        (f) =>
          f.op !== "delete" &&
          /(?:^|\/)AItest\//i.test(f.targetRel.replace(/\\/g, "/")) &&
          /\.(test|spec)\.(ts|tsx|js|jsx)$/i.test(f.targetRel)
      );
      working = await ensureAitestJestTsconfigInWorkspace({
        projectRoot,
        manifest: working,
        targetRel: testEntry?.targetRel,
      });
      const srcName = (working.sourceFileName || "").trim();
      if (srcName) {
        for (const f of working.files) {
          if (f.op === "delete") continue;
          try {
            let body = await readTextFile(projectRoot, f.workspaceRel);
            if (!looksLikeJestTsTest(f.targetRel, body)) continue;
            body = rewriteSutImports(body, {
              testRel: f.targetRel,
              sourceRel: srcName,
            });
            await writeTextFile(projectRoot, f.workspaceRel, body);
            // Persist rewrite on target before backup so rollback keeps fixed imports.
            try {
              await writeTextFile(projectRoot, f.targetRel, body);
            } catch {
              /* stage will still write */
            }
          } catch {
            /* skip unreadable overlay */
          }
        }
      }
      await saveManifest(projectRoot, working);
    }

    backups = await captureStagingBackups(projectRoot, working);
    await stageOverlayToTargets(projectRoot, working);

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
        working = { ...working, status: "fail", verify: report };
        await saveManifest(projectRoot, working);
        syncVerifyReport(working, report);
        return { manifest: working, report };
      }
    }

    const rawTestCmd = input.testCommand.trim();
    if (!rawTestCmd) {
      throw new Error("Cần lệnh test để verify.");
    }
    // Safety net: Nest ``npm test`` only scans src/**/*.spec.ts — rewrite to AItest Jest.
    const testCmd =
      manifestHasAitestTests(working) && isDefaultNpmJestCommand(rawTestCmd)
        ? buildAitestJestCommand(projectRoot, working.packagePrefix)
        : rawTestCmd;
    const testRun = await runShellCommand(projectRoot, testCmd, input.dotnetFilter);
    stages.push(stageFromRun("test", testCmd, testRun));

    let overallPass = testRun.success;

    const covCmd = (input.coverageCommand ?? "").trim();
    if (covCmd && overallPass) {
      const covRun = await runShellCommand(projectRoot, covCmd);
      stages.push(stageFromRun("coverage", covCmd, covRun));
      overallPass = overallPass && covRun.success;
    }

    let report: VerifyReport = {
      ranAt: new Date().toISOString(),
      overallPass,
      stages,
    };
    working = {
      ...working,
      status: overallPass ? "pass" : "fail",
      verify: report,
    };

    // Step 4 — parse coverage/junit on disk → PostgreSQL (best-effort)
    const coverageSync = await syncCoverageAfterVerify(working, projectRoot, report);
    if (coverageSync) {
      report = { ...report, coverageSync };
      working = { ...working, verify: report };
    }

    await saveManifest(projectRoot, working);
    syncVerifyReport(working, report);

    const logBody = stages.map((s) => `=== ${s.stage} (${s.success ? "PASS" : "FAIL"}) ===\n${s.logExcerpt}`).join("\n\n");
    await writeTextFile(
      projectRoot,
      `${workspaceRunDir(working.runId, working.packagePrefix)}/logs/verify.log`,
      logBody
    );

    return { manifest: working, report };
  } finally {
    await rollbackStaging(projectRoot, working.runId, backups, working.packagePrefix);
  }
}
