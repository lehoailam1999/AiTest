import type {
  FindImplementationsResult,
  FindReferencesResult,
  GoToDefinitionResult,
  SearchSymbolResult,
  SearchTextResult,
  SymbolPositionParams,
} from "@aitest/ide-protocol";

export type RepoDocumentSymbol = {
  name: string;
  detail?: string;
  kind: number;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  selectionRange: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
  children: RepoDocumentSymbol[];
};

export type RepoDocument = {
  pathRel: string;
  language: string;
  text: string;
  version?: number;
  dirty: boolean;
  symbols: RepoDocumentSymbol[];
};

export type RepositoryRuntime = {
  workspaceRoot(): string | null;
  now(): Date;
  git(args: readonly string[]): Promise<string>;
  dirtyDocuments(): Promise<readonly RepoDocument[]>;
  searchSymbol(query: string, maxResults: number): Promise<SearchSymbolResult>;
  /** IDE-backed repository text search; optional for test/custom runtimes. */
  searchText?(
    query: string,
    maxResults: number,
    maxBytesPerHit: number
  ): Promise<SearchTextResult>;
  definition(params: SymbolPositionParams): Promise<GoToDefinitionResult>;
  references(params: SymbolPositionParams): Promise<FindReferencesResult>;
  implementations(params: SymbolPositionParams): Promise<FindImplementationsResult>;
  readDocument(pathRel: string, maxBytes: number): Promise<RepoDocument | null>;
  findSourceFiles(maxResults: number): Promise<readonly string[]>;
};
