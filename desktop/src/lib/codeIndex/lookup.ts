import type { CodeIndexSnapshot, SymbolLookupHit } from "./types";

/**
 * Lookup symbol/class/function by name (case-insensitive). Target KPI &lt; 100 ms in-memory.
 */
export function lookupSymbol(
  snapshot: CodeIndexSnapshot,
  name: string,
  opts?: { limit?: number }
): SymbolLookupHit[] {
  const key = name.trim().toLowerCase();
  if (!key) return [];
  const paths = snapshot.symbolIndex[key] || [];
  const limit = opts?.limit ?? 50;
  const hits: SymbolLookupHit[] = [];
  for (const pathRel of paths) {
    const symbols = snapshot.symbolsByFile[pathRel] || [];
    for (const s of symbols) {
      if (s.name.toLowerCase() !== key) continue;
      hits.push({
        name: s.name,
        kind: s.kind,
        pathRel,
        line: s.line,
        parent: s.parent,
      });
      if (hits.length >= limit) return hits;
    }
  }
  return hits;
}

export function listDependencies(
  snapshot: CodeIndexSnapshot,
  pathRel: string
): string[] {
  return snapshot.dependencyGraph[pathRel] || [];
}
