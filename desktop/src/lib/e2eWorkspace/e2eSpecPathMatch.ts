/**
 * Match Playwright report specPath ↔ Generate primarySpecPath.
 * Paths diverge after remap / hash suffix / AItest prefix — leaf-only was too weak.
 */

export function normalizeE2eSpecPath(p: string): string {
  let s = (p || "").replace(/\\/g, "/");
  // Drop leading AItest/ (case-insensitive) for comparison
  s = s.replace(/^\/?AItest\//i, "");
  while (s.startsWith("./")) s = s.slice(2);
  return s;
}

/** foo.ab12cd34.spec.ts → foo.spec.ts ; foo.spec.ts → foo.spec.ts */
export function stripE2eSpecHashSuffix(leaf: string): string {
  const m = leaf.match(/^(.*)\.([a-f0-9]{8})\.(spec|test)\.([^.]+)$/i);
  if (m) return `${m[1]}.${m[3]}.${m[4]}`;
  return leaf;
}

export function e2eSpecLeaf(path: string): string {
  const norm = normalizeE2eSpecPath(path);
  return norm.split("/").pop() || norm;
}

/** Parent folder name that usually encodes TC slug (E2E-…-hash). */
export function e2eTcFolderKey(path: string): string | null {
  const norm = normalizeE2eSpecPath(path);
  const parts = norm.split("/");
  const specsIdx = parts.findIndex((p) => p.toLowerCase() === "specs");
  if (specsIdx > 0) return parts[specsIdx - 1] || null;
  // …/TCFolder/foo.spec.ts without specs/
  if (parts.length >= 2) return parts[parts.length - 2] || null;
  return null;
}

export function e2eSpecPathsMatch(a: string, b: string): boolean {
  const na = normalizeE2eSpecPath(a);
  const nb = normalizeE2eSpecPath(b);
  if (na === nb) return true;
  if (na.endsWith(nb) || nb.endsWith(na)) return true;
  const la = e2eSpecLeaf(na);
  const lb = e2eSpecLeaf(nb);
  if (la === lb) return true;
  if (stripE2eSpecHashSuffix(la) === stripE2eSpecHashSuffix(lb)) return true;
  const fa = e2eTcFolderKey(na);
  const fb = e2eTcFolderKey(nb);
  if (fa && fb && fa === fb) return true;
  return false;
}

export type E2eSpecReportRow = {
  specPath: string;
  success?: boolean;
  errorExcerpt?: string;
};

/**
 * Find report row for a generated primarySpecPath.
 * When unmapped but only one report row (or one failing) and one candidate TC, use that row.
 */
export function findSpecReportForPrimary(
  primarySpecPath: string,
  specs: E2eSpecReportRow[],
  opts?: { soleTcFallback?: boolean }
): E2eSpecReportRow | undefined {
  const direct = specs.find((s) => e2eSpecPathsMatch(s.specPath, primarySpecPath));
  if (direct) return direct;
  if (!opts?.soleTcFallback || specs.length === 0) return undefined;
  if (specs.length === 1) return specs[0];
  const fails = specs.filter((s) => s.success === false);
  if (fails.length === 1) return fails[0];
  return undefined;
}
