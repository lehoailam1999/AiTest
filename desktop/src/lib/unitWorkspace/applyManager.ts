import { readTextFile, writeTextFile, deleteTextFile } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncApplyAudit } from "./auditSync";
import { captureStagingBackups } from "./staging";
import { cleanupWorkspaceRunAfterApply } from "./cleanup";
import { writeTextFileIfChanged } from "./contentDedup";
import type { UnitWorkspaceManifest } from "./types";
import {
  assertSafeAitestTargetRel,
  coerceAitestApplyPath,
} from "../testOutputLayout";
import { resolvePackagePrefix } from "../resolvePackagePrefix";

export type ApplyWorkspaceResult = {
  manifest: UnitWorkspaceManifest;
  appliedPaths: string[];
  stagingCleaned: boolean;
};

/**
 * Ghi overlay vào repo thật dưới AItest/ (path jail). Có backup để rollback.
 * Local FS only — không phụ thuộc IDE bridge.
 * Sau Apply thành công: dọn `.ai-test/workspace/{runId}` (staging).
 */
export async function applyWorkspaceToRepo(
  projectRoot: string,
  manifest: UnitWorkspaceManifest,
  opts?: { module?: string | null }
): Promise<ApplyWorkspaceResult> {
  if (manifest.status !== "pass") {
    throw new Error("Chỉ Apply sau khi Verify PASS.");
  }
  if (!manifest.files.length) {
    throw new Error("Không có file trong workspace.");
  }

  const kind = manifest.artifactKind === "api" ? "api" : "unit";
  const packagePrefix = await resolvePackagePrefix(projectRoot, manifest.sourceFileName);
  const safeFiles = manifest.files.map((f) => {
    const targetRel = coerceAitestApplyPath(f.targetRel, {
      kind,
      module: opts?.module,
      sourceFileName: manifest.sourceFileName,
      packagePrefix,
    });
    assertSafeAitestTargetRel(targetRel);
    return { ...f, targetRel };
  });

  const safeManifest: UnitWorkspaceManifest = {
    ...manifest,
    files: safeFiles,
    packagePrefix: packagePrefix || manifest.packagePrefix,
  };
  const backups = await captureStagingBackups(projectRoot, safeManifest);
  const applied: string[] = [];

  try {
    for (const f of safeFiles) {
      if (f.op === "delete") {
        continue;
      }
      const content = await readTextFile(projectRoot, f.workspaceRel);
      await writeTextFileIfChanged(projectRoot, f.targetRel, content);
      applied.push(f.targetRel);
    }

    const next: UnitWorkspaceManifest = {
      ...safeManifest,
      status: "applied",
      appliedAt: new Date().toISOString(),
    };
    // Persist apply status to audit before wiping local staging.
    syncApplyAudit(next, applied, true);

    let stagingCleaned = false;
    try {
      await cleanupWorkspaceRunAfterApply(projectRoot, next.runId, next.packagePrefix);
      stagingCleaned = true;
    } catch {
      // Apply đã thành công — dọn staging thất bại không rollback AItest/.
      try {
        await saveManifest(projectRoot, next);
      } catch {
        /* ignore */
      }
    }

    return { manifest: next, appliedPaths: applied, stagingCleaned };
  } catch (e) {
    for (const rel of applied) {
      const b = backups.find((x) => x.targetRel === rel);
      if (!b) continue;
      if (b.previousContent === null) {
        try {
          await deleteTextFile(projectRoot, rel);
        } catch {
          /* ignore */
        }
      } else {
        await writeTextFile(projectRoot, rel, b.previousContent);
      }
    }
    throw e;
  }
}
