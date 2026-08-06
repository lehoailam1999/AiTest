import { buildDependencyGraph } from "./buildDependencyGraph";
import { buildSymbolIndex } from "./buildSymbolIndex";
import { CODE_INDEX_PARSER, CODE_INDEX_REL_PATH, CODE_INDEX_SCHEMA } from "./constants";
import { hashContent } from "./hashContent";
import { emptySnapshot, loadIndexSnapshot, saveIndexSnapshot } from "./indexStore";
import { parseTsJsSource } from "./parseTsAst";
import { scanProjectFiles } from "./scanProject";
import type {
  CodeIndexIo,
  CodeIndexSnapshot,
  FileIndexRecord,
  SyncProjectIndexResult,
} from "./types";

export type SyncProjectIndexOptions = {
  /** Force re-parse even when hash matches */
  force?: boolean;
  /** Cap files processed (debug) */
  maxFiles?: number;
  indexRelPath?: string;
};

/**
 * Incremental index: scan project → hash → re-parse only changed/new files → persist `.ai-test/index.db`.
 * Runs against a real project folder (`projectRoot`).
 */
export async function syncProjectIndex(
  projectRoot: string,
  io: CodeIndexIo,
  opts?: SyncProjectIndexOptions
): Promise<SyncProjectIndexResult> {
  const t0 = Date.now();
  const indexRelPath = opts?.indexRelPath ?? CODE_INDEX_REL_PATH;
  const prev = (await loadIndexSnapshot(projectRoot, io, indexRelPath)) ?? emptySnapshot();
  const paths = await scanProjectFiles(projectRoot, io);
  const limited = opts?.maxFiles != null ? paths.slice(0, opts.maxFiles) : paths;

  const next: CodeIndexSnapshot = {
    meta: {
      schema: CODE_INDEX_SCHEMA,
      projectRootHint: projectRoot,
      createdAt: prev.meta.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      fileCount: 0,
      symbolCount: 0,
      edgeCount: 0,
      parser: CODE_INDEX_PARSER,
    },
    files: {},
    symbolsByFile: {},
    importsByFile: {},
    exportsByFile: {},
    symbolIndex: {},
    dependencyGraph: {},
  };

  let parsed = 0;
  let reused = 0;
  const live = new Set(limited);

  for (const pathRel of limited) {
    let content: string;
    try {
      content = await io.readFile(projectRoot, pathRel);
    } catch {
      continue;
    }
    const contentHash = await hashContent(content);
    const old = prev.files[pathRel];
    if (
      !opts?.force &&
      old &&
      old.contentHash === contentHash &&
      prev.symbolsByFile[pathRel] &&
      prev.importsByFile[pathRel]
    ) {
      next.files[pathRel] = old;
      next.symbolsByFile[pathRel] = prev.symbolsByFile[pathRel];
      next.importsByFile[pathRel] = prev.importsByFile[pathRel];
      next.exportsByFile[pathRel] = prev.exportsByFile[pathRel] || [];
      reused++;
      continue;
    }

    const parsedFile = parseTsJsSource(pathRel, content);
    if (!parsedFile) continue;
    parsed++;
    const rec: FileIndexRecord = {
      pathRel,
      language: parsedFile.language,
      contentHash,
      byteSize: content.length,
      symbolCount: parsedFile.symbols.length,
      importCount: parsedFile.imports.length,
      indexedAt: new Date().toISOString(),
    };
    next.files[pathRel] = rec;
    next.symbolsByFile[pathRel] = parsedFile.symbols;
    next.importsByFile[pathRel] = parsedFile.imports;
    next.exportsByFile[pathRel] = parsedFile.exports;
  }

  let removed = 0;
  for (const oldPath of Object.keys(prev.files)) {
    if (!live.has(oldPath)) removed++;
  }

  next.symbolIndex = buildSymbolIndex(next.symbolsByFile);
  next.dependencyGraph = buildDependencyGraph(next.importsByFile);
  next.meta.fileCount = Object.keys(next.files).length;
  next.meta.symbolCount = Object.values(next.symbolsByFile).reduce(
    (n, s) => n + s.length,
    0
  );
  next.meta.edgeCount = Object.values(next.dependencyGraph).reduce(
    (n, e) => n + e.length,
    0
  );

  await saveIndexSnapshot(projectRoot, io, next, indexRelPath);

  return {
    snapshot: next,
    scanned: limited.length,
    parsed,
    reused,
    removed,
    elapsedMs: Date.now() - t0,
    indexRelPath,
  };
}
