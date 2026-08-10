import { readTextFile, writeTextFile, deleteTextFile } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncApplyAudit } from "./auditSync";
import { captureStagingBackups } from "./staging";
import { cleanupWorkspaceRunAfterApply, removeAiTestDirAfterApplyBatch } from "./cleanup";
import { writeTextFileIfChanged } from "./contentDedup";
import type { StagingBackup, UnitWorkspaceManifest } from "./types";
import {
  assertSafeAitestTargetRel,
  coerceAitestApplyPath,
} from "../testOutputLayout";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  ensureAitestDotnetInWorkspace,
  manifestHasAitestCsharpTests,
} from "./ensureAitestDotnet";
import { ideApplyFiles, isIdeCodegenReady, rememberCodegenResult } from "../ideProtocol";

const BUILD_OUTPUT_DIRS = ["dist", "build", "out"] as const;

function compiledArtifactCandidates(targetRel: string): string[] {
  const norm = (targetRel || "").replace(/\\/g, "/").replace(/^\/+/, "");
  const idx = norm.toLowerCase().indexOf("/aitest/");
  if (idx < 0) return [];
  const prefix = idx > 0 ? norm.slice(0, idx) : "";
  const tail = norm.slice(idx + 1); // keep "AItest/..."
  const sourceExt = (tail.match(/(\.[^.]+)$/)?.[1] || "").toLowerCase();
  if (![".ts", ".tsx"].includes(sourceExt)) return [];

  const stem = tail.slice(0, -sourceExt.length);
  const out: string[] = [];
  for (const outDir of BUILD_OUTPUT_DIRS) {
    const root = prefix ? `${prefix}/${outDir}` : outDir;
    out.push(`${root}/${stem}.js`);
    out.push(`${root}/${stem}.js.map`);
    out.push(`${root}/${stem}.d.ts`);
    out.push(`${root}/${stem}.d.ts.map`);
  }
  return out.map((p) => p.replace(/\/+/g, "/"));
}

async function removeCompiledAitestArtifacts(
  projectRoot: string,
  targetRel: string
): Promise<void> {
  for (const rel of compiledArtifactCandidates(targetRel)) {
    try {
      await deleteTextFile(projectRoot, rel);
    } catch {
      /* best-effort cleanup */
    }
  }
}

export type ApplyWorkspaceResult = {
  manifest: UnitWorkspaceManifest;
  appliedPaths: string[];
  stagingCleaned: boolean;
};

export type ApplyManyItemResult = {
  runId: string;
  ok: boolean;
  appliedPaths: string[];
  stagingCleaned: boolean;
  error?: string;
  manifest?: UnitWorkspaceManifest;
};

/** Prefer manifest.packagePrefix (Generate) so Apply matches staging. */
export async function resolveApplyPackagePrefix(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<string> {
  if (typeof manifest.packagePrefix === "string") {
    return manifest.packagePrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  }
  return resolvePackagePrefix(projectRoot, manifest.sourceFileName);
}

async function prepareManifestForApply(
  projectRoot: string,
  manifest: UnitWorkspaceManifest,
  opts?: { module?: string | null }
): Promise<UnitWorkspaceManifest> {
  if (manifest.status !== "pass" && !manifest.verify?.overallPass) {
    throw new Error("Chỉ Apply sau khi Verify PASS.");
  }
  if (!manifest.files.length) {
    throw new Error("Không có file trong workspace.");
  }

  const kind = manifest.artifactKind === "api" ? "api" : "unit";
  const packagePrefix = await resolveApplyPackagePrefix(projectRoot, manifest);
  const safeFiles = manifest.files.map((f) => {
    const targetRel = coerceAitestApplyPath(f.targetRel, {
      kind,
      module: opts?.module,
      sourceFileName: manifest.sourceFileName,
      packagePrefix,
      preserveLayout: true,
    });
    assertSafeAitestTargetRel(targetRel);
    return { ...f, targetRel };
  });

  const byTarget = new Map<string, (typeof safeFiles)[0]>();
  for (const f of safeFiles) {
    byTarget.set(f.targetRel.replace(/\\/g, "/"), f);
  }

  let safeManifest: UnitWorkspaceManifest = {
    ...manifest,
    status: "pass",
    files: [...byTarget.values()],
    packagePrefix,
  };
  if (manifestHasAitestCsharpTests(safeManifest)) {
    safeManifest = await ensureAitestDotnetInWorkspace({
      projectRoot,
      manifest: safeManifest,
    });
  }
  return safeManifest;
}

async function writeManifestOverlay(
  projectRoot: string,
  safeManifest: UnitWorkspaceManifest
): Promise<string[]> {
  const applied: string[] = [];

  if (isIdeCodegenReady()) {
    const files: { path: string; content: string; kind: string }[] = [];
    for (const f of safeManifest.files) {
      if (f.op === "delete") continue;
      const content = await readTextFile(projectRoot, f.workspaceRel);
      files.push({ path: f.targetRel, content, kind: "unit" });
    }
    if (files.length) {
      const ideResult = await ideApplyFiles({
        projectId: safeManifest.projectId,
        projectRoot,
        layout: "unit",
        files,
        packagePrefix: safeManifest.packagePrefix || undefined,
      });
      rememberCodegenResult(ideResult);
      for (const g of ideResult.workspaceTree.generatedFiles) {
        if (g.status === "CREATED" || g.status === "UPDATED") applied.push(g.path);
        if (g.status === "REJECTED_JAIL" || g.status === "ERROR") {
          throw new Error(g.error || `IDE Apply failed: ${g.path}`);
        }
      }
    }
    for (const f of safeManifest.files) {
      if (f.op === "delete") {
        try {
          await deleteTextFile(projectRoot, f.targetRel);
          applied.push(f.targetRel);
        } catch {
          /* missing ok */
        }
      }
    }
    if (applied.length === 0) {
      throw new Error("Apply không ghi được file nào — overlay trống hoặc path lỗi.");
    }
    return applied;
  }

  for (const f of safeManifest.files) {
    if (f.op === "delete") {
      try {
        await deleteTextFile(projectRoot, f.targetRel);
        applied.push(f.targetRel);
      } catch {
        /* missing is ok */
      }
      continue;
    }
    const content = await readTextFile(projectRoot, f.workspaceRel);
    await writeTextFileIfChanged(projectRoot, f.targetRel, content);
    await removeCompiledAitestArtifacts(projectRoot, f.targetRel);
    applied.push(f.targetRel);
  }
  if (applied.length === 0) {
    throw new Error("Apply không ghi được file nào — overlay trống hoặc path lỗi.");
  }
  return applied;
}

async function rollbackWrittenTargets(
  projectRoot: string,
  written: string[],
  previousByTarget: Map<string, string | null>
): Promise<void> {
  for (const rel of written) {
    const prev = previousByTarget.get(rel);
    if (prev === undefined) continue;
    if (prev === null) {
      try {
        await deleteTextFile(projectRoot, rel);
      } catch {
        /* ignore */
      }
    } else {
      try {
        await writeTextFile(projectRoot, rel, prev);
      } catch {
        /* ignore */
      }
    }
  }
}

async function finalizeAppliedRun(
  projectRoot: string,
  safe: UnitWorkspaceManifest,
  appliedPaths: string[]
): Promise<ApplyManyItemResult> {
  const next: UnitWorkspaceManifest = {
    ...safe,
    status: "applied",
    appliedAt: new Date().toISOString(),
  };
  syncApplyAudit(next, appliedPaths, true);
  let stagingCleaned = false;
  try {
    await cleanupWorkspaceRunAfterApply(projectRoot, next.runId, next.packagePrefix);
    stagingCleaned = true;
  } catch {
    try {
      await saveManifest(projectRoot, next);
    } catch {
      /* ignore */
    }
  }
  return {
    runId: next.runId,
    ok: true,
    appliedPaths,
    stagingCleaned,
    manifest: next,
  };
}

function backupsToMap(backups: StagingBackup[]): Map<string, string | null> {
  const map = new Map<string, string | null>();
  for (const b of backups) {
    if (!map.has(b.targetRel)) map.set(b.targetRel, b.previousContent);
  }
  return map;
}

/**
 * UUAS Apply — see `.cursor/rules/unit-apply-layout.mdc`.
 * Batch: write all overlays first, then cleanup each `{runId}` only.
 */
export async function applyManyWorkspacesToRepo(
  projectRoot: string,
  manifests: UnitWorkspaceManifest[],
  opts?: { module?: string | null }
): Promise<{ results: ApplyManyItemResult[]; appliedPaths: string[] }> {
  type Prepared = {
    runId: string;
    safe: UnitWorkspaceManifest;
    backups: StagingBackup[];
  };
  const prepared: Prepared[] = [];
  const earlyFails: ApplyManyItemResult[] = [];

  for (const m of manifests) {
    try {
      const safe = await prepareManifestForApply(projectRoot, m, opts);
      const backups = await captureStagingBackups(projectRoot, safe);
      prepared.push({ runId: safe.runId, safe, backups });
    } catch (e) {
      earlyFails.push({
        runId: m.runId,
        ok: false,
        appliedPaths: [],
        stagingCleaned: false,
        error: e instanceof Error ? e.message : "Prepare Apply lỗi",
      });
    }
  }

  const previousByTarget = new Map<string, string | null>();
  for (const p of prepared) {
    for (const [rel, prev] of backupsToMap(p.backups)) {
      if (!previousByTarget.has(rel)) previousByTarget.set(rel, prev);
    }
  }

  const writtenByRun = new Map<string, string[]>();
  const allWritten: string[] = [];

  try {
    for (const p of prepared) {
      const applied = await writeManifestOverlay(projectRoot, p.safe);
      writtenByRun.set(p.runId, applied);
      allWritten.push(...applied);
    }
  } catch (e) {
    await rollbackWrittenTargets(projectRoot, allWritten, previousByTarget);
    throw e;
  }

  const results: ApplyManyItemResult[] = [...earlyFails];
  for (const p of prepared) {
    results.push(
      await finalizeAppliedRun(projectRoot, p.safe, writtenByRun.get(p.runId) || [])
    );
  }

  // Drop entire `{pkg}/.ai-test` after batch Apply (Verify may leave staging; Apply owns cleanup).
  const pkgsToSweep = results
    .filter((r) => r.ok)
    .map((r) => {
      const p = prepared.find((x) => x.runId === r.runId);
      return p?.safe.packagePrefix;
    });
  await removeAiTestDirAfterApplyBatch(projectRoot, pkgsToSweep);

  return { results, appliedPaths: allWritten };
}

/** Single-job Apply — same pipeline as batch (one manifest). */
export async function applyWorkspaceToRepo(
  projectRoot: string,
  manifest: UnitWorkspaceManifest,
  opts?: { module?: string | null }
): Promise<ApplyWorkspaceResult> {
  const { results } = await applyManyWorkspacesToRepo(projectRoot, [manifest], opts);
  const r = results[0];
  if (!r?.ok || !r.manifest) {
    throw new Error(r?.error || "Apply lỗi");
  }
  return {
    manifest: r.manifest,
    appliedPaths: r.appliedPaths,
    stagingCleaned: r.stagingCleaned,
  };
}
