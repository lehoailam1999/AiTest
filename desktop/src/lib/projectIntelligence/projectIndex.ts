import type { IndexedFile, ProjectFileIndex } from "./types";

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

const MEMO = new Map<string, ProjectFileIndex>();
const CACHE_KEY = "aitest.projectIndex.cache";

function keyFrom(projectKey: string, paths: string[]): string {
  return `${projectKey}::${paths.length}::${paths.join("|")}`;
}

function loadCachedPaths(projectKey: string): string[] | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Record<string, string[]>;
    const rows = parsed[projectKey];
    return Array.isArray(rows) ? rows : null;
  } catch {
    return null;
  }
}

function saveCachedPaths(projectKey: string, paths: string[]): void {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    const parsed = raw ? (JSON.parse(raw) as Record<string, string[]>) : {};
    parsed[projectKey] = paths;
    localStorage.setItem(CACHE_KEY, JSON.stringify(parsed));
  } catch {
    // ignore cache write failures
  }
}

export function buildProjectIndex(pathRelList: string[]): ProjectFileIndex {
  const files: IndexedFile[] = [];
  const byStem = new Map<string, IndexedFile[]>();
  const byBaseName = new Map<string, IndexedFile>();

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
  }

  return { files, byStem, byBaseName };
}

export function buildProjectIndexCached(
  projectKey: string,
  pathRelList: string[]
): ProjectFileIndex {
  const normalized = pathRelList.map(norm).sort();
  const currentKey = keyFrom(projectKey, normalized);
  const memo = MEMO.get(currentKey);
  if (memo) return memo;

  const cached = loadCachedPaths(projectKey);
  if (cached) {
    const cachedKey = keyFrom(projectKey, cached);
    const inMemo = MEMO.get(cachedKey);
    if (inMemo && cachedKey === currentKey) {
      return inMemo;
    }
  }

  const built = buildProjectIndex(normalized);
  MEMO.set(currentKey, built);
  saveCachedPaths(projectKey, normalized);
  return built;
}

export function findByStem(index: ProjectFileIndex, stem: string): IndexedFile[] {
  return index.byStem.get(stem.toLowerCase()) ?? [];
}

export function findByBaseName(index: ProjectFileIndex, name: string): IndexedFile | undefined {
  return index.byBaseName.get(name.toLowerCase());
}
