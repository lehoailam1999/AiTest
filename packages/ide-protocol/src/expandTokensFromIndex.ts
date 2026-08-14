/**
 * Index-backed token expansion — derive Latin stems from SUT index paths/symbols.
 * Portable: no product dictionary; only stems that exist on this repo's index.
 */
import { normalizeAliasKey } from "./viCodeAliases.js";

const HANDLER_SUFFIX =
  /(CommandHandler|QueryHandler|Handler|Service|Controller|Manager|UseCase|Repository|Command|Query)$/i;

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = String(x || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

function splitPascal(stem: string): string[] {
  return stem
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .split(/[\s_]+/)
    .filter(Boolean);
}

/** Cache stems by path-list fingerprint (Approve batch reuses same index). */
const _stemsCache = new Map<string, string[]>();
const STEMS_CACHE_MAX = 8;

function pathsFingerprint(paths: string[]): string {
  const n = paths.length;
  if (n === 0) return "0";
  const head = paths[0] || "";
  const mid = paths[Math.floor(n / 2)] || "";
  const tail = paths[n - 1] || "";
  return `${n}|${head.length}|${mid.length}|${tail.length}|${head.slice(-24)}|${tail.slice(-24)}`;
}

/** Extract searchable stems from indexed paths (folders + file/symbol names). */
export function extractStemsFromIndexPaths(paths: string[]): string[] {
  const fp = pathsFingerprint(paths);
  const cached = _stemsCache.get(fp);
  if (cached) return cached;

  const stems = new Set<string>();
  for (const raw of paths) {
    const p = String(raw || "").replace(/\\/g, "/");
    if (!p) continue;
    const segments = p.split("/").filter(Boolean);
    for (const seg of segments) {
      const base = seg.replace(/\.[^.]+$/, "");
      if (base.length < 4) continue;
      stems.add(base);
      for (const part of splitPascal(base)) {
        if (part.length >= 4) stems.add(part);
      }
      const trimmed = base.replace(HANDLER_SUFFIX, "");
      if (trimmed.length >= 4 && trimmed !== base) {
        stems.add(trimmed);
        for (const part of splitPascal(trimmed)) {
          if (part.length >= 4) stems.add(part);
        }
      }
    }
  }
  const out = [...stems];
  if (_stemsCache.size >= STEMS_CACHE_MAX) {
    const first = _stemsCache.keys().next().value;
    if (first != null) _stemsCache.delete(first);
  }
  _stemsCache.set(fp, out);
  return out;
}

/** Test/helper — clear stem cache. */
export function clearIndexStemCache(): void {
  _stemsCache.clear();
}

/** Path segment / substring match — shared by Approve rank + index token filter. */
export function pathHitsIndexToken(pathRel: string, token: string): boolean {
  const low = pathRel.replace(/\\/g, "/").toLowerCase();
  const tl = token.toLowerCase();
  if (tl.length < 2) return false;
  const parts = low.split(/[^a-z0-9]+/).filter(Boolean);
  if (tl.length <= 3) {
    return parts.some((p) => p === tl);
  }
  if (low.includes(tl)) return true;
  return parts.some((p) => p.includes(tl) || (p.length >= 4 && tl.includes(p)));
}

/** Keep tokens that hit ≥1 indexed path. */
export function filterTokensHittingPaths(
  tokens: string[],
  paths: string[]
): string[] {
  if (!tokens.length || !paths.length) return [];
  return tokens.filter((t) =>
    paths.some((p) => pathHitsIndexToken(p, t))
  );
}

export type ExpandTokensFromIndexOpts = {
  minStemLen?: number;
  minWordLen?: number;
};

/**
 * Match TC text (VI normalized + Latin identifiers) against index path stems.
 * Returns only stems present on this repo's index.
 */
export function expandTokensFromIndex(
  raw: string,
  paths: string[],
  opts?: ExpandTokensFromIndexOpts
): string[] {
  const minStem = opts?.minStemLen ?? 4;
  const minWord = opts?.minWordLen ?? 4;
  if (!raw?.trim() || !paths.length) return [];

  const stems = extractStemsFromIndexPaths(paths).filter(
    (s) => s.length >= minStem
  );
  if (!stems.length) return [];

  const blob = normalizeAliasKey(raw);
  const latinIds = [...(raw.match(/[A-Za-z][A-Za-z0-9]{3,}/g) || [])];
  const viWords = blob.split(/\s+/).filter((w) => w.length >= minWord);
  const out: string[] = [];

  for (const stem of stems) {
    const sl = stem.toLowerCase();
    if (blob.includes(sl)) {
      out.push(stem);
      continue;
    }
    for (const id of latinIds) {
      if (id.length >= minStem && sl.includes(id.toLowerCase())) {
        out.push(stem);
        break;
      }
    }
    if (out[out.length - 1] === stem) continue;
    for (const w of viWords) {
      if (sl.includes(w) || (w.length >= minStem && w.includes(sl))) {
        out.push(stem);
        break;
      }
    }
  }

  return uniq(out.filter((t) => t.length >= minStem));
}

/** Alias — same helper used across Desktop rank + legacy seed. */
export const pathHitsToken = pathHitsIndexToken;
