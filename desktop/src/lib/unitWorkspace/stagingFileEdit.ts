/**
 * Edit / delete a generated file in the Tool draft.
 * The source changes only when the user chooses Update/Apply.
 */
import { assertSafeAitestTargetRel } from "../testOutputLayout";
import { loadManifest, saveManifest } from "./manager";
import type { UnitWorkspaceManifest } from "./types";
import { deleteDraftPath, writeDraftText } from "./draftStore";

function norm(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

export type StagingFileEditResult = {
  manifest: UnitWorkspaceManifest;
  /** Paths written or removed under AItest/ (source tree). */
  syncedTargets: string[];
};

/**
 * Overwrite Tool draft only. Update/Apply later writes the source file.
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

  await writeDraftText(projectRoot, entry.workspaceRel, content);
  const next: UnitWorkspaceManifest = {
    ...manifest,
    status: "generated",
    verify: undefined,
  };
  await saveManifest(projectRoot, next);

  return { manifest: next, syncedTargets: [] };
}

/**
 * Mark an existing source file for deletion, or drop a never-applied new draft.
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

  await deleteDraftPath(projectRoot, entry.workspaceRel);

  const next: UnitWorkspaceManifest = {
    ...manifest,
    files:
      entry.op === "new"
        ? manifest.files.filter((f) => norm(f.targetRel) !== want)
        : manifest.files.map((f) =>
            norm(f.targetRel) === want ? { ...f, op: "delete" as const } : f
          ),
    status: "generated",
    verify: undefined,
  };
  await saveManifest(projectRoot, next);

  return { manifest: next, syncedTargets: [] };
}
