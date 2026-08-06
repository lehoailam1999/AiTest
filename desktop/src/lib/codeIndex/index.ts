/**
 * Phase 1 — Code Knowledge Index (Desktop-local).
 *
 * Usage on a real project:
 *   const io = createTauriCodeIndexIo();
 *   const { snapshot, elapsedMs } = await syncProjectIndex(projectRoot, io);
 *   const hits = lookupSymbol(snapshot, "OrderService");
 *
 * Index file: `{projectRoot}/.ai-test/index.db` (JSON schema v1; SQLite later).
 */
export { CODE_INDEX_REL_PATH, CODE_INDEX_EXTENSIONS, CODE_INDEX_SCHEMA } from "./constants";
export { scanProjectFiles } from "./scanProject";
export { parseTsJsSource } from "./parseTsAst";
export { buildSymbolIndex } from "./buildSymbolIndex";
export { buildDependencyGraph, resolveRelativeImport } from "./buildDependencyGraph";
export { hashContent } from "./hashContent";
export {
  emptySnapshot,
  loadIndexSnapshot,
  saveIndexSnapshot,
  parseSnapshotJson,
} from "./indexStore";
export { syncProjectIndex } from "./incrementalSync";
export type { SyncProjectIndexOptions } from "./incrementalSync";
export { lookupSymbol, listDependencies } from "./lookup";
export { createTauriCodeIndexIo } from "./tauriIo";
export type {
  CodeIndexIo,
  CodeIndexSnapshot,
  SyncProjectIndexResult,
  SymbolLookupHit,
  IndexedSymbol,
  FileParseResult,
} from "./types";
