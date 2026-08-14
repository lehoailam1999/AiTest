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

export function e2eSpecWorkCwd(specPath: string): string {
  const p = (specPath || "").replace(/\\/g, "/");
  const idx = p.toLowerCase().lastIndexOf("/specs/");
  if (idx > 0) return p.slice(0, idx);
  const parts = p.split("/");
  if (parts.length > 1) return parts.slice(0, -1).join("/");
  return ".";
}

export function e2eSpecArgFromCwd(specPath: string): string {
  const p = (specPath || "").replace(/\\/g, "/");
  const cwd = e2eSpecWorkCwd(p);
  if (p.toLowerCase().startsWith(`${cwd.toLowerCase()}/`)) {
    return p.slice(cwd.length + 1);
  }
  return p.split("/").pop() || p;
}

export function absUnderProject(projectRoot: string, relOrAbs: string): string {
  const root = (projectRoot || "").replace(/\\/g, "/").replace(/\/$/, "");
  const p = (relOrAbs || "").replace(/\\/g, "/");
  if (!p) return root;
  if (/^[A-Za-z]:\//.test(p) || p.startsWith("/")) return p;
  return `${root}/${p.replace(/^\//, "")}`;
}

export function buildIdePlaywrightCommand(opts: {
  packageRootAbs: string;
  specArg: string;
  headed?: boolean;
}): string[] {
  const cmd = [
    "npx",
    "--prefix",
    opts.packageRootAbs,
    "playwright",
    "test",
    opts.specArg,
  ];
  if (opts.headed) cmd.push("--headed");
  return cmd;
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
