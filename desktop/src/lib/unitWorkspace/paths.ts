/**
 * Opaque keys for Tool-internal Unit drafts.
 * The Tauri draft store maps these keys to OS temp; they are never SUT paths.
 */
export const AI_TEST_DIR = ".ai-test";
export const AI_TEST_STAGING_DIR = "staging";
export const AI_TEST_LOGS_DIR = "logs";

function normPkg(packagePrefix?: string | null): string {
  return (packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
}

/** `{pkg}/.ai-test` or `.ai-test` when source already sits at apply root. */
export function aiTestDir(packagePrefix?: string | null): string {
  const pkg = normPkg(packagePrefix);
  return pkg ? `${pkg}/${AI_TEST_DIR}` : AI_TEST_DIR;
}

export function workspaceRunDir(runId: string, packagePrefix?: string | null): string {
  void packagePrefix;
  return `unit-runs/${runId}`;
}

export function manifestRelPath(runId: string, packagePrefix?: string | null): string {
  return `${workspaceRunDir(runId, packagePrefix)}/manifest.json`;
}

/** Overlay key relative to the Tool's private draft root. */
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
