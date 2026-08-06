import { CODE_INDEX_REL_PATH, CODE_INDEX_SCHEMA } from "./constants";
import type { CodeIndexIo, CodeIndexSnapshot } from "./types";

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

export async function loadIndexSnapshot(
  projectRoot: string,
  io: CodeIndexIo,
  relPath: string = CODE_INDEX_REL_PATH
): Promise<CodeIndexSnapshot | null> {
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
    return parseSnapshotJson(raw);
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
  return relPath;
}
