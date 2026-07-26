/**
 * Compare project Root Apply path vs IDE workspace root (normalize separators / case).
 */
export function normalizeFsRoot(path: string | null | undefined): string {
  if (!path) return "";
  return path
    .replace(/\\/g, "/")
    .replace(/\/+/g, "/")
    .replace(/\/$/, "")
    .toLowerCase();
}

/** True when both set and point at the same folder (or one is nested under the other). */
export function rootsAligned(
  projectRoot: string | null | undefined,
  ideRoot: string | null | undefined
): boolean {
  const a = normalizeFsRoot(projectRoot);
  const b = normalizeFsRoot(ideRoot);
  if (!a || !b) return true; // no comparison yet — don't warn
  return a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
}

export function rootsMismatch(
  projectRoot: string | null | undefined,
  ideRoot: string | null | undefined
): boolean {
  const a = normalizeFsRoot(projectRoot);
  const b = normalizeFsRoot(ideRoot);
  if (!a || !b) return false;
  return !rootsAligned(a, b);
}
