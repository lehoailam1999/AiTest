/**
 * Edit / delete a single generated file in a Unit workspace run.
 * Syncs staging overlay + AItest target on disk (when present).
 * Never touches production SUT outside AItest/.
 */
import { deleteTextFile, readTextFile, writeTextFile } from "../../tauri/bridge";
import { assertSafeAitestTargetRel } from "../testOutputLayout";
import { loadManifest, saveManifest } from "./manager";
import type { UnitWorkspaceManifest } from "./types";

function norm(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

async function tryDelete(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    await deleteTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

async function tryWriteIfExists(
  projectRoot: string,
  rel: string,
  content: string
): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    await writeTextFile(projectRoot, rel, content);
    return true;
  } catch {
    return false;
  }
}

export type StagingFileEditResult = {
  manifest: UnitWorkspaceManifest;
  /** Paths written or removed under AItest/ (already on disk). */
  syncedTargets: string[];
};

/**
 * Overwrite staging overlay content; also update targetRel if already on disk.
 */
export async function updateWorkspaceFileContent(
  projectRoot: string,
  runId: string,
  targetRel: string,
  content: string,
  packagePrefix?: string | null
): Promise<StagingFileEditResult> {
  const manifest = await loadManifest(projectRoot, runId, packagePrefix);
  if (!manifest) throw new Error(`Không tìm thấy staging run ${runId}`);

  const want = norm(targetRel);
  const entry = manifest.files.find((f) => norm(f.targetRel) === want);
  if (!entry) throw new Error(`File không có trong manifest: ${targetRel}`);
  assertSafeAitestTargetRel(entry.targetRel);

  await writeTextFile(projectRoot, entry.workspaceRel, content);

  const syncedTargets: string[] = [];
  if (await tryWriteIfExists(projectRoot, entry.targetRel, content)) {
    syncedTargets.push(entry.targetRel);
  }

  return { manifest, syncedTargets };
}

/**
 * Remove file from manifest, delete overlay + AItest target (if present).
 */
export async function deleteWorkspaceFile(
  projectRoot: string,
  runId: string,
  targetRel: string,
  packagePrefix?: string | null
): Promise<StagingFileEditResult> {
  const manifest = await loadManifest(projectRoot, runId, packagePrefix);
  if (!manifest) throw new Error(`Không tìm thấy staging run ${runId}`);

  const want = norm(targetRel);
  const entry = manifest.files.find((f) => norm(f.targetRel) === want);
  if (!entry) throw new Error(`File không có trong manifest: ${targetRel}`);
  assertSafeAitestTargetRel(entry.targetRel);

  await tryDelete(projectRoot, entry.workspaceRel);

  const syncedTargets: string[] = [];
  if (await tryDelete(projectRoot, entry.targetRel)) {
    syncedTargets.push(entry.targetRel);
  }

  const next: UnitWorkspaceManifest = {
    ...manifest,
    files: manifest.files.filter((f) => norm(f.targetRel) !== want),
    status: manifest.status === "applied" ? "generated" : manifest.status,
  };
  await saveManifest(projectRoot, next);

  return { manifest: next, syncedTargets };
}
