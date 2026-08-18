import { deleteDir } from "../../tauri/bridge";
import {
  workspaceRunDir,
  aiTestDir,
  AI_TEST_STAGING_DIR,
  AI_TEST_LOGS_DIR,
} from "./paths";
import { deleteDraftPath } from "./draftStore";

/**
 * After Apply/Discard — remove this Tool-internal draft from OS temp.
 * Legacy `.ai-test/staging` cleanup remains below for old repositories.
 */
export async function cleanupWorkspaceRunAfterApply(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<void> {
  const runDir = workspaceRunDir(runId, packagePrefix);
  await deleteDraftPath(projectRoot, runDir);

  // Parent staging/ — emptyOnly so sibling runs survive mid-batch.
  try {
    await deleteDir(
      projectRoot,
      `${aiTestDir(packagePrefix)}/${AI_TEST_STAGING_DIR}`,
      { emptyOnly: true }
    );
  } catch {
    /* other runs remain — expected */
  }
  // Backward-compat: legacy `.ai-test/workspace/{runId}` if present.
  try {
    await deleteDir(projectRoot, `${aiTestDir(packagePrefix)}/workspace/${runId}`);
  } catch {
    /* ignore */
  }
  try {
    await deleteDir(projectRoot, `${aiTestDir(packagePrefix)}/workspace`, {
      emptyOnly: true,
    });
  } catch {
    /* ignore */
  }
  try {
    await deleteDir(projectRoot, aiTestDir(packagePrefix), { emptyOnly: true });
  } catch {
    /* still has content */
  }
}

/**
 * Migration cleanup: wipe old source-local staging/logs if they still exist.
 * Call once per packagePrefix when that package's jobs in the batch are done.
 */
export async function removeAiTestDirAfterApplyBatch(
  projectRoot: string,
  packagePrefixes: Array<string | null | undefined>
): Promise<void> {
  const seen = new Set<string>();
  for (const raw of packagePrefixes) {
    const key = (raw || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
    if (seen.has(key)) continue;
    seen.add(key);
    const root = aiTestDir(raw);
    try {
      await deleteDir(projectRoot, `${root}/${AI_TEST_STAGING_DIR}`);
    } catch {
      /* missing / locked — best-effort */
    }
    try {
      await deleteDir(projectRoot, `${root}/${AI_TEST_LOGS_DIR}`);
    } catch {
      /* missing / locked — best-effort */
    }
    try {
      await deleteDir(projectRoot, `${root}/workspace`, { emptyOnly: true });
    } catch {
      /* ignore */
    }
    try {
      await deleteDir(projectRoot, root, { emptyOnly: true });
    } catch {
      /* still has test-cases / conventions */
    }
  }
}
