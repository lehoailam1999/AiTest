import { runTestCommand, runDotnetTest, deleteTextFile } from "../../tauri/bridge";
import {
  captureStagingBackups,
  restoreSourceAfterVerify,
  stageOverlayToTargets,
} from "./staging";
import { saveManifest } from "./manager";
import type { UnitWorkspaceManifest, VerifyReport, VerifyStageResult } from "./types";
import {
  ensureAitestDotnetInWorkspace,
  resolveAitestCsharpVerifyCommands,
  manifestHasAitestCsharpTests,
  parseCsharpErrorFileRels,
} from "./ensureAitestDotnet";

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
    const fromCmd =
      cmd.match(/dotnet\s+test\s+"([^"]+\.csproj)"/i)?.[1] ||
      cmd.match(/dotnet\s+test\s+(\S+\.csproj)/i)?.[1];
    const r = await runDotnetTest(projectRoot, fromCmd);
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

async function runShellWithCsharpQuarantine(
  projectRoot: string,
  command: string,
  enabled: boolean
) {
  let result = await runShell(projectRoot, command);
  if (!enabled) return result;

  const notes: string[] = [];
  for (let pass = 0; pass < 8; pass++) {
    if (result.success) break;
    if (!/\berror\s+CS\d+/i.test(result.log || "")) break;
    const rels = parseCsharpErrorFileRels(result.log, projectRoot);
    const removed: string[] = [];
    for (const rel of rels) {
      try {
        await deleteTextFile(projectRoot, rel);
        removed.push(rel);
      } catch {
        /* ignore */
      }
    }
    if (!removed.length) break;
    notes.push(
      `[AITest] Quarantined ${removed.length} compile-failing AItest file(s) and retrying:\n` +
        removed.map((r) => `  - ${r}`).join("\n")
    );
    result = await runShell(projectRoot, command);
  }
  if (!notes.length) return result;
  return {
    ...result,
    log: notes.join("\n\n") + "\n\n" + (result.log || ""),
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
  const { projectRoot } = input;
  if (!input.manifests.length) {
    throw new Error("Không có staging để verify.");
  }
  if (!input.testCommand.trim()) {
    throw new Error("Cần lệnh test.");
  }

  let manifests = [...input.manifests];
  const anyCsharp = manifests.some(manifestHasAitestCsharpTests);
  if (anyCsharp) {
    const next: UnitWorkspaceManifest[] = [];
    for (const m of manifests) {
      if (manifestHasAitestCsharpTests(m)) {
        const updated = await ensureAitestDotnetInWorkspace({
          projectRoot,
          manifest: m,
        });
        await saveManifest(projectRoot, updated);
        next.push(updated);
      } else {
        next.push(m);
      }
    }
    manifests = next;
  }

  const stages: VerifyStageResult[] = [];
  const backupsByRun: Array<{
    manifest: UnitWorkspaceManifest;
    backups: Awaited<ReturnType<typeof captureStagingBackups>>;
  }> = [];

  try {
    for (const m of manifests) {
      backupsByRun.push({
        manifest: m,
        backups: await captureStagingBackups(projectRoot, m),
      });
    }
    for (const m of manifests) {
      await stageOverlayToTargets(projectRoot, m);
    }

    let compileCmd = (input.compileCommand ?? "").trim();
    let testCmd = input.testCommand.trim();

    // C# AItest host is SoT — never run jest/npm/bare `dotnet test` against production.
    if (anyCsharp) {
      const csharpManifest = manifests.find(manifestHasAitestCsharpTests);
      const resolved = resolveAitestCsharpVerifyCommands(
        csharpManifest?.packagePrefix,
        { compile: compileCmd, test: testCmd }
      );
      compileCmd = resolved.compile;
      testCmd = resolved.test;
    }

    if (compileCmd) {
      const compileRun = await runShellWithCsharpQuarantine(
        projectRoot,
        compileCmd,
        anyCsharp
      );
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

    const testRun = await runShellWithCsharpQuarantine(
      projectRoot,
      testCmd,
      anyCsharp && !compileCmd
    );
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
    // The source remains unchanged until the user chooses Update/Apply.
    await restoreSourceAfterVerify(projectRoot, backupsByRun);
  }
}
