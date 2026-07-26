import { readTextFile, writeTextFile, deleteTextFile } from "../../tauri/bridge";
import { saveManifest } from "./manager";
import { syncApplyAudit } from "./auditSync";
import { captureStagingBackups } from "./staging";
import type { UnitWorkspaceManifest } from "./types";
import {
  assertSafeAitestTargetRel,
  coerceAitestApplyPath,
} from "../testOutputLayout";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import { getIdeRpcClientOrNull } from "../ideBridge/session";

export type ApplyWorkspaceResult = {
  manifest: UnitWorkspaceManifest;
  appliedPaths: string[];
  /** Paths successfully opened in IDE after Apply (P5 DoD) */
  openedInIde: string[];
  ideOpenError?: string;
};

/**
 * Ghi overlay vào repo thật dưới AItest/ (path jail). Có backup để rollback.
 * Sau Apply: mở file test qua IDE Plugin nếu bridge đang connected.
 */
export async function applyWorkspaceToRepo(
  projectRoot: string,
  manifest: UnitWorkspaceManifest,
  opts?: { openInIde?: boolean; module?: string | null }
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

  const safeManifest: UnitWorkspaceManifest = { ...manifest, files: safeFiles };
  const backups = await captureStagingBackups(projectRoot, safeManifest);
  const applied: string[] = [];

  try {
    for (const f of safeFiles) {
      if (f.op === "delete") {
        continue;
      }
      const content = await readTextFile(projectRoot, f.workspaceRel);
      await writeTextFile(projectRoot, f.targetRel, content);
      applied.push(f.targetRel);
    }

    const next: UnitWorkspaceManifest = {
      ...safeManifest,
      status: "applied",
      appliedAt: new Date().toISOString(),
    };
    await saveManifest(projectRoot, next);
    syncApplyAudit(next, applied, true);

    const openInIde = opts?.openInIde !== false;
    let openedInIde: string[] = [];
    let ideOpenError: string | undefined;
    if (openInIde && applied.length) {
      const openResult = await openAppliedPathsInIde(applied);
      openedInIde = openResult.opened;
      ideOpenError = openResult.error;
    }

    return { manifest: next, appliedPaths: applied, openedInIde, ideOpenError };
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

/** P5 DoD — Desktop → Plugin `aitest/workspace.openFile` */
export async function openAppliedPathsInIde(
  paths: string[]
): Promise<{ opened: string[]; error?: string }> {
  const client = getIdeRpcClientOrNull();
  if (!client || !client.isConnected) {
    return { opened: [], error: "IDE bridge offline — mở file thủ công trong IDE" };
  }
  const opened: string[] = [];
  let lastErr: string | undefined;
  for (const pathRel of paths) {
    try {
      assertSafeAitestTargetRel(pathRel);
      await client.openFile({ pathRel });
      opened.push(pathRel);
    } catch (e) {
      lastErr = e instanceof Error ? e.message : String(e);
    }
  }
  return { opened, error: opened.length ? undefined : lastErr };
}

/** Optional: write + open via IDE createTestFile (when bridge up). */
export async function applyFileViaIdePlugin(input: {
  pathRel: string;
  content: string;
  open?: boolean;
}): Promise<{ ok: boolean; error?: string }> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) {
    return { ok: false, error: "IDE not connected" };
  }
  try {
    const pathRel = assertSafeAitestTargetRel(input.pathRel);
    await client.createTestFile({
      pathRel,
      content: input.content,
      open: input.open !== false,
    });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}
