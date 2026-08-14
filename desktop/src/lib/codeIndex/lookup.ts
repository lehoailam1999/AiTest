import type { CodeIndexSnapshot, SymbolLookupHit } from "./types";

/**
 * Lookup symbol/class/function by name (case-insensitive). Target KPI &lt; 100 ms in-memory.
 * `Type.Method` → lookup type; hit.line/endLine prefer the method when present.
 */
export function lookupSymbol(
  snapshot: CodeIndexSnapshot,
  name: string,
  opts?: { limit?: number }
): SymbolLookupHit[] {
  const raw = name.trim();
  if (!raw) return [];
  const dotted = /^([A-Za-z_][A-Za-z0-9_]*)\.([A-Za-z_][A-Za-z0-9_]*)$/.exec(raw);
  const typeName = dotted ? dotted[1]! : raw;
  const methodName = dotted ? dotted[2]! : null;
  const typeKey = typeName.toLowerCase();
  const paths = snapshot.symbolIndex[typeKey] || [];
  const limit = opts?.limit ?? 50;
  const hits: SymbolLookupHit[] = [];
  for (const pathRel of paths) {
    const symbols = snapshot.symbolsByFile[pathRel] || [];
    const typeHits = symbols.filter(
      (s) =>
        s.name.toLowerCase() === typeKey &&
        s.kind !== "method"
    );
    for (const s of typeHits) {
      let line = s.line;
      let endLine = s.endLine;
      let kind = s.kind;
      let parent = s.parent;
      if (methodName) {
        const method = symbols.find(
          (m) =>
            m.kind === "method" &&
            m.name.toLowerCase() === methodName.toLowerCase() &&
            (!m.parent || m.parent.toLowerCase() === typeKey)
        );
        if (method) {
          line = method.line;
          endLine = method.endLine;
          kind = method.kind;
          parent = method.parent || s.name;
        }
      }
      hits.push({
        name: methodName ? `${s.name}.${methodName}` : s.name,
        kind,
        pathRel,
        line,
        endLine,
        parent,
      });
      if (hits.length >= limit) return hits;
    }
  }
  // Fallback: bare method / function name (no Type. prefix)
  if (!hits.length && !methodName) {
    for (const pathRel of paths) {
      const symbols = snapshot.symbolsByFile[pathRel] || [];
      for (const s of symbols) {
        if (s.name.toLowerCase() !== typeKey) continue;
        hits.push({
          name: s.name,
          kind: s.kind,
          pathRel,
          line: s.line,
          endLine: s.endLine,
          parent: s.parent,
        });
        if (hits.length >= limit) return hits;
      }
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
