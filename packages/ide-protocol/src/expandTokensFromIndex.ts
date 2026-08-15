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

/** Content hash, memoized per array identity so repeated calls stay O(1). */
const _fingerprintByArray = new WeakMap<string[], string>();

function pathsFingerprint(paths: string[]): string {
  const n = paths.length;
  if (n === 0) return "0";
  const memo = _fingerprintByArray.get(paths);
  if (memo) return memo;
  let hash = 5381;
  for (const p of paths) {
    for (let i = 0; i < p.length; i += 1) {
      hash = (hash * 33) ^ p.charCodeAt(i);
    }
    hash = (hash * 33) ^ 10;
  }
  const fp = `${n}|${(hash >>> 0).toString(36)}`;
  _fingerprintByArray.set(paths, fp);
  return fp;
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

const _expandCache = new Map<string, string[]>();
const EXPAND_CACHE_MAX = 512;

/** Test/helper — clear stem cache. */
export function clearIndexStemCache(): void {
  _stemsCache.clear();
  _expandCache.clear();
  _pathTokensCache.clear();
  _corpusCache.clear();
}

/**
 * Approve ranks every token against every indexed path, so the lowercase split
 * is recomputed millions of times per run without this memo.
 */
type PathTokens = { low: string; parts: string[] };
const _pathTokensCache = new Map<string, PathTokens>();
const PATH_TOKENS_CACHE_MAX = 40_000;

function pathTokens(pathRel: string): PathTokens {
  const cached = _pathTokensCache.get(pathRel);
  if (cached) return cached;
  const low = pathRel.replace(/\\/g, "/").toLowerCase();
  const entry: PathTokens = {
    low,
    parts: low.split(/[^a-z0-9]+/).filter(Boolean),
  };
  if (_pathTokensCache.size >= PATH_TOKENS_CACHE_MAX) _pathTokensCache.clear();
  _pathTokensCache.set(pathRel, entry);
  return entry;
}

/** Path segment / substring match — shared by Approve rank + index token filter. */
export function pathHitsIndexToken(pathRel: string, token: string): boolean {
  const tl = token.toLowerCase();
  if (tl.length < 2) return false;
  const { low, parts } = pathTokens(pathRel);
  if (tl.length <= 3) {
    return parts.some((p) => p === tl);
  }
  if (low.includes(tl)) return true;
  return parts.some((p) => p.includes(tl) || (p.length >= 4 && tl.includes(p)));
}

type PathCorpus = {
  /** All paths joined by \n so one substring scan replaces a per-path loop. */
  joined: string;
  parts: Set<string>;
  longParts: string[];
  hits: Map<string, boolean>;
};

const _corpusCache = new Map<string, PathCorpus>();
const CORPUS_CACHE_MAX = 4;

function pathCorpus(paths: string[]): PathCorpus {
  const fp = pathsFingerprint(paths);
  const cached = _corpusCache.get(fp);
  if (cached) return cached;
  const lows: string[] = [];
  const parts = new Set<string>();
  for (const p of paths) {
    const entry = pathTokens(p);
    lows.push(entry.low);
    for (const part of entry.parts) parts.add(part);
  }
  const corpus: PathCorpus = {
    joined: `\n${lows.join("\n")}\n`,
    parts,
    longParts: [...parts].filter((p) => p.length >= 4),
    hits: new Map(),
  };
  if (_corpusCache.size >= CORPUS_CACHE_MAX) _corpusCache.clear();
  _corpusCache.set(fp, corpus);
  return corpus;
}

function tokenHitsCorpus(corpus: PathCorpus, token: string): boolean {
  const tl = token.toLowerCase();
  if (tl.length < 2) return false;
  const memo = corpus.hits.get(tl);
  if (memo !== undefined) return memo;
  let hit: boolean;
  if (tl.length <= 3) {
    hit = corpus.parts.has(tl);
  } else if (corpus.joined.includes(tl)) {
    hit = true;
  } else {
    hit = corpus.longParts.some((p) => tl.includes(p));
  }
  corpus.hits.set(tl, hit);
  return hit;
}

/** Keep tokens that hit ≥1 indexed path. */
export function filterTokensHittingPaths(
  tokens: string[],
  paths: string[]
): string[] {
  if (!tokens.length || !paths.length) return [];
  const corpus = pathCorpus(paths);
  return tokens.filter((t) => tokenHitsCorpus(corpus, t));
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

  const memoKey = `${pathsFingerprint(paths)}|${minStem}|${minWord}|${raw}`;
  const memo = _expandCache.get(memoKey);
  if (memo) return memo;

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

  const expanded = uniq(out.filter((t) => t.length >= minStem));
  if (_expandCache.size >= EXPAND_CACHE_MAX) _expandCache.clear();
  _expandCache.set(memoKey, expanded);
  return expanded;
}

/** Alias — same helper used across Desktop rank + legacy seed. */
export const pathHitsToken = pathHitsIndexToken;
