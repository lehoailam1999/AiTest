import { runDotnetTest, runTestCommand, writeTextFile, readTextFile, deleteTextFile, type TestRunResult } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncVerifyReport } from "./auditSync";
import { syncCoverageAfterVerify } from "./coverageSync";
import { preserveStagedOverlays, stageOverlayToTargets } from "./staging";
import type {
  UnitWorkspaceManifest,
  VerifyReport,
  VerifyStageName,
  VerifyStageResult,
} from "./types";
import { workspaceRunDir } from "./paths";
import { pushTimeline } from "./unitJobEvents";
import { recordUnitJobMetric } from "../unitJobMetrics";
import {
  buildAitestJestCommand,
  ensureAitestJestTsconfigInWorkspace,
  isDefaultNpmJestCommand,
  looksLikeJestTsTest,
  manifestHasAitestTests,
} from "./ensureAitestJestTsconfig";
import {
  buildAitestDotnetTestCommand,
  ensureAitestDotnetInWorkspace,
  isDefaultDotnetTestCommand,
  manifestHasAitestCsharpTests,
  parseCsharpErrorFileRels,
} from "./ensureAitestDotnet";
import { rewriteSutImports } from "../testOutputLayout";

const LOG_MAX = 12_000;

function trimLog(log: string): string {
  if (log.length <= LOG_MAX) return log;
  return log.slice(-LOG_MAX);
}

/**
 * When batch AItest compile fails, remove only the failing generated .cs files and retry once
 * so healthy tests in the same host can still run (agnostic across .NET repos).
 */
async function quarantineCsharpCompileFailures(
  projectRoot: string,
  log: string
): Promise<{ removed: string[]; note: string }> {
  const rels = parseCsharpErrorFileRels(log, projectRoot);
  const removed: string[] = [];
  for (const rel of rels) {
    try {
      await deleteTextFile(projectRoot, rel);
      removed.push(rel);
    } catch {
      /* already gone */
    }
  }
  if (!removed.length) {
    return { removed, note: "" };
  }
  return {
    removed,
    note:
      `[AITest] Quarantined ${removed.length} compile-failing AItest file(s) and retrying:\n` +
      removed.map((r) => `  - ${r}`).join("\n") +
      "\n\n",
  };
}

async function runCsharpShellWithQuarantine(
  projectRoot: string,
  command: string,
  dotnetFilter: string | undefined,
  enabled: boolean
): Promise<TestRunResult> {
  let result = await runShellCommand(projectRoot, command, dotnetFilter);
  if (!enabled) return result;

  const notes: string[] = [];
  // Multi-pass: one bad file can hide others; keep removing until green or stuck.
  for (let pass = 0; pass < 8; pass++) {
    if (result.success) break;
    if (!/\berror\s+CS\d+/i.test(result.log || "")) break;
    const { removed, note } = await quarantineCsharpCompileFailures(projectRoot, result.log);
    if (!removed.length) break;
    if (note) notes.push(note.trimEnd());
    result = await runShellCommand(projectRoot, command, dotnetFilter);
  }

  if (!notes.length) return result;
  return {
    ...result,
    log: notes.join("\n\n") + "\n\n" + (result.log || ""),
    command: result.command || command,
  };
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
    const fromCmd =
      cmd.match(/dotnet\s+test\s+"([^"]+\.csproj)"/i)?.[1] ||
      cmd.match(/dotnet\s+test\s+(\S+\.csproj)/i)?.[1];
    return runDotnetTest(projectRoot, dotnetFilter || fromCmd);
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
  const verifyStarted = Date.now();
  let working: UnitWorkspaceManifest = {
    ...manifest,
    status: "verifying",
    timeline: pushTimeline(manifest.timeline || [], "job.verify.started"),
  };
  await saveManifest(projectRoot, working);

  const stages: VerifyStageResult[] = [];

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

    // C# / .NET: exclude AItest from production csproj + scaffold AItest.UnitTests.csproj
    if (manifestHasAitestCsharpTests(working)) {
      working = await ensureAitestDotnetInWorkspace({
        projectRoot,
        manifest: working,
      });
      await saveManifest(projectRoot, working);
    }

    await stageOverlayToTargets(projectRoot, working);

    const csharpHost = manifestHasAitestCsharpTests(working);

    const compileCmd = (input.compileCommand ?? "").trim();
    if (compileCmd) {
      const compileRun = await runCsharpShellWithQuarantine(
        projectRoot,
        compileCmd,
        undefined,
        csharpHost
      );
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
    let testCmd =
      manifestHasAitestTests(working) && isDefaultNpmJestCommand(rawTestCmd)
        ? buildAitestJestCommand(projectRoot, working.packagePrefix)
        : rawTestCmd;
    // Safety net: bare `dotnet test` would build whole solution / wrong host — use AItest.UnitTests.
    if (csharpHost && isDefaultDotnetTestCommand(testCmd)) {
      testCmd = buildAitestDotnetTestCommand(working.packagePrefix);
    }
    // Prefer explicit filter; else parse .csproj from command (do not override custom hosts).
    // When compile was skipped, quarantine on first failing `dotnet test` build as well.
    const testRun = await runCsharpShellWithQuarantine(
      projectRoot,
      testCmd,
      input.dotnetFilter,
      csharpHost && !compileCmd
    );
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

    const verifyTimeMs = Date.now() - verifyStarted;
    working = {
      ...working,
      timeline: pushTimeline(
        working.timeline || [],
        overallPass ? "job.verify.completed" : "job.verify.failed",
        `verifyTimeMs=${verifyTimeMs}`
      ),
    };
    await saveManifest(projectRoot, working);
    recordUnitJobMetric({
      projectId: working.projectId,
      contextSource: working.via === "ide-extension" ? "implementation-plan" : "local-fs",
      runnerUsed: working.via || "unknown",
      ideConnected: working.via === "ide-extension",
      jobId: working.jobId,
      via: working.via || null,
      verifyTimeMs,
      durationMs: verifyTimeMs,
      ok: overallPass,
      failReason: overallPass ? null : "verify_failed",
    });

    const logBody = stages.map((s) => `=== ${s.stage} (${s.success ? "PASS" : "FAIL"}) ===\n${s.logExcerpt}`).join("\n\n");
    await writeTextFile(
      projectRoot,
      `${workspaceRunDir(working.runId, working.packagePrefix)}/logs/verify.log`,
      logBody
    );

    return { manifest: working, report };
  } finally {
    // Keep staged AItest on disk until Apply / Discard.
    await preserveStagedOverlays(projectRoot, [working]);
  }
}
