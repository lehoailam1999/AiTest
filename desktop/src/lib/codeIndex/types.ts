/** Phase 1 Code Knowledge Index — shared shapes. */

export type SymbolKind =
  | "class"
  | "function"
  | "method"
  | "interface"
  | "enum"
  | "variable"
  | "type"
  | "decorator";

export type IndexedSymbol = {
  name: string;
  kind: SymbolKind;
  /** 1-based line in file */
  line: number;
  /**
   * 1-based inclusive end line when brace body is known (optional).
   * Layer 1 symbol-level — absent on older snapshots / expression-bodied members.
   */
  endLine?: number;
  /** Parent class/interface when kind=method */
  parent?: string;
  exported?: boolean;
};

export type ImportEdge = {
  /** Specifier as written (e.g. ./foo, @app/order) */
  from: string;
  /** Named imports; empty if side-effect / namespace only */
  names: string[];
  isTypeOnly?: boolean;
  line: number;
};

export type ExportInfo = {
  name: string;
  line: number;
  isDefault?: boolean;
};

export type FileParseResult = {
  pathRel: string;
  language: "ts" | "tsx" | "js" | "jsx" | "cs";
  symbols: IndexedSymbol[];
  imports: ImportEdge[];
  exports: ExportInfo[];
};

export type FileIndexRecord = {
  pathRel: string;
  language: string;
  contentHash: string;
  byteSize: number;
  mtimeMs?: number;
  symbolCount: number;
  importCount: number;
  indexedAt: string;
};

export type CodeIndexMeta = {
  schema: "aitest-code-index-v1";
  projectRootHint?: string;
  createdAt: string;
  updatedAt: string;
  fileCount: number;
  symbolCount: number;
  edgeCount: number;
  /** Phase 1 parser id */
  parser: string;
};

export type CodeIndexSnapshot = {
  meta: CodeIndexMeta;
  files: Record<string, FileIndexRecord>;
  /** pathRel → symbols */
  symbolsByFile: Record<string, IndexedSymbol[]>;
  /** pathRel → imports */
  importsByFile: Record<string, ImportEdge[]>;
  /** pathRel → exports */
  exportsByFile: Record<string, ExportInfo[]>;
  /** lowercase symbol name → pathRel[] */
  symbolIndex: Record<string, string[]>;
  /** importer pathRel → resolved/raw from[] */
  dependencyGraph: Record<string, string[]>;
};

export type SyncProjectIndexResult = {
  snapshot: CodeIndexSnapshot;
  scanned: number;
  parsed: number;
  reused: number;
  removed: number;
  elapsedMs: number;
  indexRelPath: string;
};

export type SymbolLookupHit = {
  name: string;
  kind: SymbolKind;
  pathRel: string;
  line: number;
  endLine?: number;
  parent?: string;
};

export type CodeIndexIo = {
  listFiles: (projectRoot: string, extensions: string[]) => Promise<string[]>;
  readFile: (projectRoot: string, pathRel: string) => Promise<string>;
  writeFile: (projectRoot: string, pathRel: string, content: string) => Promise<void>;
  readFileOptional?: (projectRoot: string, pathRel: string) => Promise<string | null>;
};
