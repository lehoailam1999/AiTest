import { deleteDir } from "../../tauri/bridge";
import { workspaceRunDir, aiTestDir, AI_TEST_STAGING_DIR } from "./paths";

/**
 * After Apply PASS — remove this run's staging only (siblings mid-batch).
 * Batch finish: `removeAiTestDirAfterApplyBatch` (UUAS).
 */
export async function cleanupWorkspaceRunAfterApply(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<void> {
  const runDir = workspaceRunDir(runId, packagePrefix);
  await deleteDir(projectRoot, runDir);

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
 * After Apply batch finishes — remove entire `{pkg}/.ai-test` (staging disposable).
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
      // Full remove_dir_all — folder must go after Apply (not leave empty staging/).
      await deleteDir(projectRoot, root);
    } catch {
      /* missing / locked — best-effort */
    }
  }
}
