import {
  CODE_INDEX_REL_PATH,
  CODE_INDEX_SCHEMA,
  toProjectRelativePath,
} from "./constants";
import type { CodeIndexIo, CodeIndexSnapshot } from "./types";

/** In-memory cache — Approve/enrich often reloads the same JSON snapshot. */
const INDEX_SNAP_CACHE = new Map<string, { snap: CodeIndexSnapshot; at: number }>();
const INDEX_CACHE_TTL_MS = 90_000;

function cacheKey(projectRoot: string, relPath: string): string {
  return `${projectRoot.replace(/\\/g, "/").toLowerCase()}::${relPath.replace(/\\/g, "/")}`;
}

export function invalidateIndexSnapshotCache(
  projectRoot?: string,
  relPath: string = CODE_INDEX_REL_PATH
): void {
  if (!projectRoot) {
    INDEX_SNAP_CACHE.clear();
    return;
  }
  INDEX_SNAP_CACHE.delete(cacheKey(projectRoot, relPath));
}

export function emptySnapshot(now = new Date().toISOString()): CodeIndexSnapshot {
  return {
    meta: {
      schema: CODE_INDEX_SCHEMA,
      createdAt: now,
      updatedAt: now,
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      parser: "lightweight-ts-js-v1",
    },
    files: {},
    symbolsByFile: {},
    importsByFile: {},
    exportsByFile: {},
    symbolIndex: {},
    dependencyGraph: {},
  };
}

export function serializeSnapshot(snap: CodeIndexSnapshot): string {
  return JSON.stringify(snap);
}

export function parseSnapshotJson(raw: string): CodeIndexSnapshot | null {
  try {
    const data = JSON.parse(raw) as CodeIndexSnapshot;
    if (!data || data.meta?.schema !== CODE_INDEX_SCHEMA) return null;
    if (!data.files || !data.symbolIndex) return null;
    return data;
  } catch {
    return null;
  }
}

function normalizeSnapshotPaths(
  snap: CodeIndexSnapshot,
  projectRoot: string
): CodeIndexSnapshot {
  const keyMap = new Map<string, string>();
  for (const key of Object.keys(snap.files || {})) {
    const rel = toProjectRelativePath(projectRoot, key);
    if (rel) keyMap.set(key, rel);
  }
  const remapKeyed = <T>(source: Record<string, T>): Record<string, T> => {
    const out: Record<string, T> = {};
    for (const [key, value] of Object.entries(source || {})) {
      const rel = keyMap.get(key) || toProjectRelativePath(projectRoot, key);
      if (rel) out[rel] = value;
    }
    return out;
  };
  const files = remapKeyed(snap.files);
  for (const [pathRel, record] of Object.entries(files)) {
    files[pathRel] = { ...record, pathRel };
  }
  const remapValue = (value: string): string =>
    toProjectRelativePath(projectRoot, value) || value.replace(/\\/g, "/");
  return {
    ...snap,
    meta: { ...snap.meta, projectRootHint: undefined },
    files,
    symbolsByFile: remapKeyed(snap.symbolsByFile || {}),
    importsByFile: remapKeyed(snap.importsByFile || {}),
    exportsByFile: remapKeyed(snap.exportsByFile || {}),
    symbolIndex: Object.fromEntries(
      Object.entries(snap.symbolIndex || {}).map(([symbol, paths]) => [
        symbol,
        paths.map(remapValue).filter((path) => !/^[A-Za-z]:\//.test(path)),
      ])
    ),
    dependencyGraph: Object.fromEntries(
      Object.entries(snap.dependencyGraph || {}).flatMap(([key, paths]) => {
        const rel = keyMap.get(key) || toProjectRelativePath(projectRoot, key);
        return rel
          ? [[rel, paths.map(remapValue).filter((path) => !/^[A-Za-z]:\//.test(path))]]
          : [];
      })
    ),
  };
}

export async function loadIndexSnapshot(
  projectRoot: string,
  io: CodeIndexIo,
  relPath: string = CODE_INDEX_REL_PATH
): Promise<CodeIndexSnapshot | null> {
  const key = cacheKey(projectRoot, relPath);
  const cached = INDEX_SNAP_CACHE.get(key);
  if (cached && Date.now() - cached.at < INDEX_CACHE_TTL_MS) {
    return cached.snap;
  }
  try {
    let raw: string | null = null;
    if (io.readFileOptional) {
      raw = await io.readFileOptional(projectRoot, relPath);
    } else {
      try {
        raw = await io.readFile(projectRoot, relPath);
      } catch {
        raw = null;
      }
    }
    if (!raw?.trim()) return null;
    const parsed = parseSnapshotJson(raw);
    const snap = parsed ? normalizeSnapshotPaths(parsed, projectRoot) : null;
    if (snap) {
      INDEX_SNAP_CACHE.set(key, { snap, at: Date.now() });
    }
    return snap;
  } catch {
    return null;
  }
}

export async function saveIndexSnapshot(
  projectRoot: string,
  io: CodeIndexIo,
  snap: CodeIndexSnapshot,
  relPath: string = CODE_INDEX_REL_PATH
): Promise<string> {
  await io.writeFile(projectRoot, relPath, serializeSnapshot(snap));
  invalidateIndexSnapshotCache(projectRoot, relPath);
  return relPath;
}
