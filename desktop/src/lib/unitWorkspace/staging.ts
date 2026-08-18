import { readTextFile, writeTextFile, deleteTextFile } from "../../tauri/bridge";
import { workspaceRunDir } from "./paths";
import { writeTextFileIfChanged } from "./contentDedup";
import type { StagingBackup, UnitWorkspaceManifest } from "./types";
import { readDraftText, writeDraftText } from "./draftStore";

function backupsRel(runId: string, packagePrefix?: string | null): string {
  return `${workspaceRunDir(runId, packagePrefix)}/backups.json`;
}

export async function loadStagingBackups(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<StagingBackup[]> {
  try {
    const raw = await readDraftText(
      projectRoot,
      backupsRel(runId, packagePrefix)
    );
    const parsed = JSON.parse(raw) as StagingBackup[];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveStagingBackups(
  projectRoot: string,
  runId: string,
  backups: StagingBackup[],
  packagePrefix?: string | null
): Promise<void> {
  await writeDraftText(
    projectRoot,
    backupsRel(runId, packagePrefix),
    JSON.stringify(backups, null, 2)
  );
}

async function fileExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot current target paths before writing overlay content. */
export async function captureStagingBackups(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<StagingBackup[]> {
  const backups: StagingBackup[] = [];
  for (const f of manifest.files) {
    const exists = await fileExists(projectRoot, f.targetRel);
    let previousContent: string | null = null;
    if (exists) {
      try {
        previousContent = await readTextFile(projectRoot, f.targetRel);
      } catch {
        previousContent = "";
      }
    }
    backups.push({ targetRel: f.targetRel, previousContent });
  }
  await saveStagingBackups(projectRoot, manifest.runId, backups, manifest.packagePrefix);
  return backups;
}

/** Copy overlay → target paths (staging for verify). Skip identical content. */
export async function stageOverlayToTargets(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<void> {
  for (const f of manifest.files) {
    if (f.op === "delete") {
      await deleteTextFile(projectRoot, f.targetRel);
      continue;
    }
    const content = await readDraftText(projectRoot, f.workspaceRel);
    await writeTextFileIfChanged(projectRoot, f.targetRel, content);
  }
}

/** Restore source after temporary Verify staging or a failed Apply. */
export async function rollbackStaging(
  projectRoot: string,
  runId: string,
  backups?: StagingBackup[],
  packagePrefix?: string | null
): Promise<void> {
  const list = backups ?? (await loadStagingBackups(projectRoot, runId, packagePrefix));
  for (const b of list) {
    if (b.previousContent === null) {
      try {
        await deleteTextFile(projectRoot, b.targetRel);
      } catch {
        /* ignore */
      }
    } else {
      await writeTextFile(projectRoot, b.targetRel, b.previousContent);
    }
  }
}

/** Restore the source after temporary Verify staging; Apply is the only persistent update. */
export async function restoreSourceAfterVerify(
  projectRoot: string,
  backupsByRun: Array<{ manifest: UnitWorkspaceManifest; backups: StagingBackup[] }>
): Promise<void> {
  for (const item of backupsByRun) {
    try {
      await rollbackStaging(
        projectRoot,
        item.manifest.runId,
        item.backups,
        item.manifest.packagePrefix
      );
    } catch {
      /* best-effort */
    }
  }
}
