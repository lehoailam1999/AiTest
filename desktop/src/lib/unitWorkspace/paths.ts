/**
 * Staging dirs for unit workspace runs.
 * Nested under the owning package when known (e.g. backend/.ai-test/…),
 * never at monorepo root for BE/FE sources.
 */
export const AI_TEST_DIR = ".ai-test";
export const AI_TEST_STAGING_DIR = "staging";

function normPkg(packagePrefix?: string | null): string {
  return (packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** `{pkg}/.ai-test` or `.ai-test` when source already sits at apply root. */
export function aiTestDir(packagePrefix?: string | null): string {
  const pkg = normPkg(packagePrefix);
  return pkg ? `${pkg}/${AI_TEST_DIR}` : AI_TEST_DIR;
}

export function workspaceRunDir(runId: string, packagePrefix?: string | null): string {
  return `${aiTestDir(packagePrefix)}/${AI_TEST_STAGING_DIR}/${runId}`;
}

export function manifestRelPath(runId: string, packagePrefix?: string | null): string {
  return `${workspaceRunDir(runId, packagePrefix)}/manifest.json`;
}

/** Overlay file path relative to project root. */
export function overlayRelPath(
  runId: string,
  targetRel: string,
  packagePrefix?: string | null
): string {
  const norm = targetRel.replace(/\\/g, "/").replace(/^\/+/, "");
  return `${workspaceRunDir(runId, packagePrefix)}/overlay/${norm}`;
}

export function newRunId(testCaseId: string): string {
  const short = testCaseId.replace(/-/g, "").slice(0, 8);
  return `unit-${short}-${Date.now()}`;
}
