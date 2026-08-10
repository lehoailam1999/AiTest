import { normalizeRelPath } from "./constants";
import type { ImportEdge } from "./types";

export type ResolveImportOpts = {
  /** lowercase symbol → pathRel[] from index */
  symbolIndex?: Record<string, string[]>;
};

/**
 * Dependency graph: importer → list of import specs (raw) and/or resolved pathRels.
 * When symbolIndex + knownFiles provided, C# type names resolve to pathRels.
 */
export function buildDependencyGraph(
  importsByFile: Record<string, ImportEdge[]>,
  opts?: ResolveImportOpts & { knownFiles?: Set<string> }
): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const known = opts?.knownFiles;
  const symbolIndex = opts?.symbolIndex;
  for (const [pathRel, edges] of Object.entries(importsByFile)) {
    const path = normalizeRelPath(pathRel);
    const set = new Set<string>();
    for (const e of edges) {
      if (!e.from) continue;
      if (known && symbolIndex) {
        const resolved = resolveImportSpecifier(path, e.from, known, {
          symbolIndex,
        });
        set.add(resolved || e.from);
      } else {
        set.add(e.from);
      }
    }
    out[path] = [...set].sort((a, b) => a.localeCompare(b));
  }
  return out;
}

function proximityScore(importerPathRel: string, candidate: string): number {
  const a = normalizeRelPath(importerPathRel);
  const b = normalizeRelPath(candidate);
  const aDir = a.includes("/") ? a.slice(0, a.lastIndexOf("/")) : "";
  const bDir = b.includes("/") ? b.slice(0, b.lastIndexOf("/")) : "";
  let s = 0;
  if (aDir && aDir === bDir) s += 50;
  else if (aDir && bDir.startsWith(aDir + "/")) s += 30;
  else if (aDir && bDir) {
    const aParent = aDir.includes("/") ? aDir.slice(0, aDir.lastIndexOf("/")) : "";
    if (aParent && bDir.startsWith(aParent + "/")) s += 18;
  }
  if (/\.cs$/i.test(b) && /\.cs$/i.test(a)) s += 8;
  if (/\/(interfaces?|contracts?|dtos?|models?)\//i.test(b)) s += 6;
  if (/^I[A-Z]/.test(b.split("/").pop() || "")) s += 4;
  // Prefer same language family as importer
  if (/\.cs$/i.test(a) && !/\.cs$/i.test(b)) s -= 20;
  if (/\.(tsx?|jsx?)$/i.test(a) && /\.cs$/i.test(b)) s -= 20;
  return s;
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
    `${base}.cs`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
  ];
  for (const c of candidates) {
    if (knownFiles.has(c)) return c;
  }
  return null;
}

/**
 * Resolve TS relative import OR C# type/namespace last-segment via symbolIndex.
 */
export function resolveImportSpecifier(
  importerPathRel: string,
  specifier: string,
  knownFiles: Set<string>,
  opts?: ResolveImportOpts
): string | null {
  const raw = (specifier || "").trim().replace(/\\/g, "/");
  if (!raw) return null;

  const relative = resolveRelativeImport(importerPathRel, raw, knownFiles);
  if (relative) return relative;

  if (knownFiles.has(raw)) return raw;
  for (const ext of [".cs", ".ts", ".tsx", ".js", ".jsx"]) {
    if (knownFiles.has(raw + ext)) return raw + ext;
  }

  // C# / CLR: Namespace.Type or bare TypeName → symbolIndex
  const typeName = raw.includes(".") ? raw.split(".").pop() || "" : raw;
  if (!typeName || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(typeName)) return null;
  if (!/^[A-Z]/.test(typeName) && !raw.includes(".")) return null;

  const symbolIndex = opts?.symbolIndex;
  if (!symbolIndex) return null;
  const hits = (symbolIndex[typeName.toLowerCase()] || [])
    .map(normalizeRelPath)
    .filter((p) => knownFiles.has(p) && p !== normalizeRelPath(importerPathRel));
  if (!hits.length) return null;

  hits.sort(
    (a, b) =>
      proximityScore(importerPathRel, b) - proximityScore(importerPathRel, a) ||
      a.localeCompare(b)
  );
  return hits[0] || null;
}
