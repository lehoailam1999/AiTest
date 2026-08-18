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
  compiledAitestArtifactRels,
} from "../testOutputLayout";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  ensureAitestDotnetInWorkspace,
  manifestHasAitestCsharpTests,
} from "./ensureAitestDotnet";
import { ideApplyFiles, isIdeCodegenReady, rememberCodegenResult } from "../ideProtocol";
import { pushTimeline } from "./unitJobEvents";
import { recordUnitJobMetric } from "../unitJobMetrics";
import { readDraftText } from "./draftStore";
import {
  reconcileUnitArtifactOwnership,
  type FailedUnitOwner,
} from "./unitArtifactOwnership";

async function removeCompiledAitestArtifacts(
  projectRoot: string,
  targetRel: string
): Promise<void> {
  for (const rel of compiledAitestArtifactRels(targetRel)) {
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
      const content = await readDraftText(projectRoot, f.workspaceRel);
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
          // Partial Apply: other files may already be on disk — surface clear error.
          const okN = applied.length;
          throw new Error(
            (g.error || `IDE Apply failed: ${g.path}`) +
              (okN
                ? ` (${okN} file khác đã ghi; kiểm tra AItest/ trên SUT)`
                : "")
          );
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
    const content = await readDraftText(projectRoot, f.workspaceRel);
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
  appliedPaths: string[],
  applyTimeMs?: number
): Promise<ApplyManyItemResult> {
  const next: UnitWorkspaceManifest = {
    ...safe,
    status: "applied",
    appliedAt: new Date().toISOString(),
    timeline: pushTimeline(
      safe.timeline || [],
      "job.apply.completed",
      applyTimeMs != null ? `applyTimeMs=${applyTimeMs}` : undefined
    ),
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
  if (typeof applyTimeMs === "number") {
    recordUnitJobMetric({
      projectId: next.projectId,
      contextSource: next.via === "ide-extension" ? "implementation-plan" : "local-fs",
      runnerUsed: next.via || "unknown",
      ideConnected: next.via === "ide-extension",
      jobId: next.jobId,
      via: next.via || null,
      applyTimeMs,
      durationMs: applyTimeMs,
      ok: true,
    });
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
  opts?: {
    module?: string | null;
    /** Gen-failed TC keys whose previously owned source tests must be removed. */
    failedUnits?: FailedUnitOwner[];
  }
): Promise<{
  results: ApplyManyItemResult[];
  appliedPaths: string[];
  deletedFailedPaths: string[];
  failedCleanupErrors: string[];
}> {
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
  const applyStarted = Date.now();

  try {
    for (const p of prepared) {
      const marked: UnitWorkspaceManifest = {
        ...p.safe,
        timeline: pushTimeline(p.safe.timeline || [], "job.apply.started"),
      };
      await saveManifest(projectRoot, marked).catch(() => {});
      p.safe = marked;
      const applied = await writeManifestOverlay(projectRoot, p.safe);
      writtenByRun.set(p.runId, applied);
      allWritten.push(...applied);
    }
  } catch (e) {
    await rollbackWrittenTargets(projectRoot, allWritten, previousByTarget);
    throw e;
  }

  const applyTimeMs = Date.now() - applyStarted;
  const results: ApplyManyItemResult[] = [...earlyFails];
  for (const p of prepared) {
    results.push(
      await finalizeAppliedRun(
        projectRoot,
        p.safe,
        writtenByRun.get(p.runId) || [],
        applyTimeMs
      )
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

  let deletedFailedPaths: string[] = [];
  let failedCleanupErrors: string[] = [];
  try {
    const successful = prepared
      .filter((item) => results.some((result) => result.runId === item.runId && result.ok))
      .map((item) => ({
        testCaseId: item.safe.testCaseId,
        packagePrefix: item.safe.packagePrefix,
        targetPaths: item.safe.files
          .filter((file) => file.op !== "delete")
          .map((file) => file.targetRel),
      }));
    const successfulIds = new Set(
      successful.map((item) => item.testCaseId.trim().toLowerCase())
    );
    const ownership = await reconcileUnitArtifactOwnership({
      projectRoot,
      successful,
      failed: (opts?.failedUnits || []).filter(
        (item) => !successfulIds.has(item.testCaseId.trim().toLowerCase())
      ),
    });
    deletedFailedPaths = ownership.deletedPaths;
    failedCleanupErrors = ownership.deleteErrors;
  } catch (error) {
    failedCleanupErrors = [
      error instanceof Error ? error.message : "Không cập nhật được ownership file test",
    ];
  }

  return {
    results,
    appliedPaths: allWritten,
    deletedFailedPaths,
    failedCleanupErrors,
  };
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
