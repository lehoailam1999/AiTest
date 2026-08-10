import type { IndexedFile, ProjectFileIndex } from "./types";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

const MEMO = new Map<string, ProjectFileIndex>();
const CACHE_KEY = "aitest.projectIndex.cache.v2";

/** Path segments / noise we do not index as lookup tokens. */
const SKIP_SEG = new Set(
  [
    "src",
    "lib",
    "app",
    "apps",
    "wwwroot",
    "bin",
    "obj",
    "dist",
    "build",
    "node_modules",
    "packages",
    "www",
    "public",
    "assets",
    "static",
    "shared",
    "common",
    "core",
    "infra",
    "infrastructure",
    "application",
    "domain",
    "api",
    "controllers",
    "services",
    "handlers",
    "models",
    "entities",
    "dto",
    "dtos",
    "commands",
    "queries",
    "features",
    "modules",
    "pages",
    "components",
    "hooks",
    "utils",
    "helpers",
    "types",
    "interfaces",
    "internal",
    "external",
  ].map((x) => x.toLowerCase())
);

function fingerprint(paths: string[]): string {
  let h = paths.length | 0;
  for (let i = 0; i < paths.length; i++) {
    const p = paths[i];
    h = (Math.imul(31, h) + p.length) | 0;
    // sample ends — cheap stable fingerprint without joining all paths
    if (p.length) {
      h = (Math.imul(31, h) + p.charCodeAt(0)) | 0;
      h = (Math.imul(31, h) + p.charCodeAt(p.length - 1)) | 0;
    }
    if (i % 17 === 0) {
      for (let j = 0; j < p.length; j += 3) {
        h = (Math.imul(31, h) + p.charCodeAt(j)) | 0;
      }
    }
  }
  return `${paths.length}:${h >>> 0}`;
}

function loadCachedFingerprint(projectKey: string): string | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, string>;
    const fp = parsed[projectKey];
    return typeof fp === "string" ? fp : null;
  } catch {
    return null;
  }
}

function saveCachedFingerprint(projectKey: string, fp: string): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string>) : {};
    parsed[projectKey] = fp;
    localStorage.setItem(CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore cache write failures
  }
}

/** PascalCase / snake pieces from a file stem for fast token → path lookup. */
export function stemLookupTokens(stem: string): string[] {
  const out: string[] = [];
  const s = (stem || "").trim();
  if (!s) return out;
  out.push(s.toLowerCase());
  for (const m of s.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|\d+/g) ?? []) {
    if (m.length >= 3) out.push(m.toLowerCase());
  }
  for (const m of s.toLowerCase().split(/[^a-z0-9]+/)) {
    if (m.length >= 3) out.push(m);
  }
  return [...new Set(out)];
}

function pushToken(
  byToken: Map<string, IndexedFile[]>,
  token: string,
  row: IndexedFile
): void {
  const k = token.toLowerCase();
  if (k.length < 3 || SKIP_SEG.has(k)) return;
  const bucket = byToken.get(k) ?? [];
  if (!bucket.some((f) => f.pathRel === row.pathRel)) {
    bucket.push(row);
    byToken.set(k, bucket);
  }
}

export function buildProjectIndex(pathRelList: string[]): ProjectFileIndex {
  const files: IndexedFile[] = [];
  const byStem = new Map<string, IndexedFile[]>();
  const byBaseName = new Map<string, IndexedFile>();
  const byToken = new Map<string, IndexedFile[]>();

  for (const raw of pathRelList) {
    const pathRel = norm(raw);
    const baseName = pathRel.split("/").pop() || pathRel;
    const dot = baseName.lastIndexOf(".");
    const stem = dot > 0 ? baseName.slice(0, dot) : baseName;
    const ext = dot > 0 ? baseName.slice(dot).toLowerCase() : "";
    const row: IndexedFile = { pathRel, baseName, stem, ext };
    files.push(row);
    const stemKey = stem.toLowerCase();
    const bucket = byStem.get(stemKey) ?? [];
    bucket.push(row);
    byStem.set(stemKey, bucket);
    byBaseName.set(baseName.toLowerCase(), row);

    for (const t of stemLookupTokens(stem)) pushToken(byToken, t, row);
    for (const seg of pathRel.split("/")) {
      if (!seg || seg.includes(".")) continue;
      pushToken(byToken, seg, row);
      for (const t of stemLookupTokens(seg)) pushToken(byToken, t, row);
    }
  }

  return { files, byStem, byBaseName, byToken };
}

export function buildProjectIndexCached(
  projectKey: string,
  pathRelList: string[]
): ProjectFileIndex {
  const normalized = pathRelList.map(norm).sort();
  const fp = fingerprint(normalized);
  const memoKey = `${projectKey}::${fp}`;
  const memo = MEMO.get(memoKey);
  if (memo) return memo;

  const cachedFp = loadCachedFingerprint(projectKey);
  if (cachedFp === fp) {
    const hit = MEMO.get(memoKey);
    if (hit) return hit;
  }

  const built = buildProjectIndex(normalized);
  MEMO.set(memoKey, built);
  saveCachedFingerprint(projectKey, fp);
  return built;
}

export function findByStem(index: ProjectFileIndex, stem: string): IndexedFile[] {
  return index.byStem.get(stem.toLowerCase()) ?? [];
}

export function findByBaseName(index: ProjectFileIndex, name: string): IndexedFile | undefined {
  return index.byBaseName.get(name.toLowerCase());
}

/** Fast Unit seed pool: token → indexed production-ish paths. */
export function findByToken(index: ProjectFileIndex, token: string): IndexedFile[] {
  return index.byToken.get(token.toLowerCase()) ?? [];
}
