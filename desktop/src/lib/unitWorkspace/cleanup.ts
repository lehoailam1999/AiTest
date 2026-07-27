import { deleteDir } from "../../tauri/bridge";
import { workspaceRunDir, aiTestDir } from "./paths";

/**
 * After Apply PASS — remove staging for this run only (overlay / logs / backups / manifest).
 * Applied tests under AItest/ are untouched. Other unit-* runs are kept.
 * Job Board uses API audit, not this folder.
 */
export async function cleanupWorkspaceRunAfterApply(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<void> {
  const runDir = workspaceRunDir(runId, packagePrefix);
  await deleteDir(projectRoot, runDir);

  // Best-effort: remove empty parents only (will no-op / fail if other runs remain).
  try {
    await deleteDir(projectRoot, `${aiTestDir(packagePrefix)}/workspace`, {
      emptyOnly: true,
    });
  } catch {
    /* other runs still present */
  }
  try {
    await deleteDir(projectRoot, aiTestDir(packagePrefix), { emptyOnly: true });
  } catch {
    /* still has content */
  }
}
