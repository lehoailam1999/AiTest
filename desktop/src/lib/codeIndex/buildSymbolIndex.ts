import { normalizeRelPath } from "./constants";
import type { IndexedSymbol } from "./types";

/** Build lowercase name → pathRel[] (sorted unique). */
export function buildSymbolIndex(
  symbolsByFile: Record<string, IndexedSymbol[]>
): Record<string, string[]> {
  const map = new Map<string, Set<string>>();
  for (const [pathRel, symbols] of Object.entries(symbolsByFile)) {
    const path = normalizeRelPath(pathRel);
    for (const s of symbols) {
      const key = s.name.toLowerCase();
      let set = map.get(key);
      if (!set) {
        set = new Set();
        map.set(key, set);
      }
      set.add(path);
    }
  }
  const out: Record<string, string[]> = {};
  for (const [k, set] of map) {
    out[k] = [...set].sort((a, b) => a.localeCompare(b));
  }
  return out;
}
