import { normalizeRelPath } from "./constants";
import type { ImportEdge } from "./types";

/**
 * Dependency graph: importer → list of import specifiers (raw).
 * Phase 1 does not fully resolve path aliases; stores `from` as written.
 */
export function buildDependencyGraph(
  importsByFile: Record<string, ImportEdge[]>
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [pathRel, edges] of Object.entries(importsByFile)) {
    const path = normalizeRelPath(pathRel);
    const set = new Set<string>();
    for (const e of edges) {
      if (e.from) set.add(e.from);
    }
    out[path] = [...set].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

/** Try resolve relative import to a known pathRel (best-effort). */
export function resolveRelativeImport(
  importerPathRel: string,
  specifier: string,
  knownFiles: Set<string>
): string | null {
  if (!specifier.startsWith(".")) return null;
  const importerDir = normalizeRelPath(importerPathRel).split("/").slice(0, -1).join("/");
  const joined = normalizeRelPath(
    [importerDir, specifier].filter(Boolean).join("/")
  );
  // collapse ..
  const parts: string[] = [];
  for (const p of joined.split("/")) {
    if (!p || p === ".") continue;
    if (p === "..") {
      parts.pop();
      continue;
    }
    parts.push(p);
  }
  const base = parts.join("/");
  const candidates = [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}
