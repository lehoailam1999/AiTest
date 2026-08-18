import { loadManifest, saveManifest } from "./manager";
import { cleanupWorkspaceRunAfterApply } from "./cleanup";
import type { UnitWorkspaceManifest } from "./types";

/**
 * Discard a Tool draft. Source files are untouched because only Update/Apply
 * is allowed to persist changes under AItest/.
 */
export async function discardWorkspaceRun(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<{ removedTargets: string[] }> {
  const manifest = await loadManifest(projectRoot, runId, packagePrefix);
  const removedTargets: string[] = [];

  if (manifest) {
    try {
      const discarded: UnitWorkspaceManifest = {
        ...manifest,
        status: "discarded",
      };
      await saveManifest(projectRoot, discarded);
    } catch {
      /* may be wiped next */
    }
  }

  try {
    await cleanupWorkspaceRunAfterApply(projectRoot, runId, packagePrefix);
  } catch {
    /* best-effort */
  }

  return { removedTargets };
}

/** Discard many batch jobs. */
export async function discardWorkspaceRuns(
  projectRoot: string,
  jobs: Array<{ runId: string; packagePrefix?: string | null }>
): Promise<{ removedTargets: string[]; runs: number }> {
  const removed = new Set<string>();
  let runs = 0;
  for (const j of jobs) {
    if (!j.runId) continue;
    const r = await discardWorkspaceRun(projectRoot, j.runId, j.packagePrefix);
    runs += 1;
    for (const t of r.removedTargets) removed.add(t);
  }
  return { removedTargets: [...removed], runs };
}
