export type FileRole = "primary" | "dependency";

export type IndexedFile = {
  pathRel: string;
  baseName: string;
  stem: string;
  ext: string;
};

export type ProjectFileIndex = {
  files: IndexedFile[];
  byStem: Map<string, IndexedFile[]>;
  byBaseName: Map<string, IndexedFile>;
};

export type ResolvedSeed = {
  pathRel: string;
  score: number;
  reason: string;
};

export type SeedCandidate = ResolvedSeed & { hits?: string[] };

export type DependencyClosureItem = {
  pathRel: string;
  role: FileRole;
  depth: number;
};

export type UnitContextFile = {
  pathRel: string;
  content: string;
  role: FileRole;
};

export type UnitContextPacket = {
  primaryPath: string;
  primaryContent: string;
  related: UnitContextFile[];
  seed: ResolvedSeed | null;
  /** Ứng viên khác khi auto-pick có thể sai — chọn trong UI (không lưu source lên DB) */
  candidates: SeedCandidate[];
  /** File được TC nhắc tới (đã resolve trên local) */
  mentionedPaths: string[];
  truncated: string[];
};

export type ContextBuildPolicy = {
  maxDependencyFiles: number;
  maxBytesPerFile: number;
  maxDependencyDepth: number;
  /** Đọc thêm file cùng module/folder (local) — không persist DB */
  broadLocalContext?: boolean;
  maxModuleRelatedFiles?: number;
};

export const DEFAULT_CONTEXT_POLICY: ContextBuildPolicy = {
  maxDependencyFiles: 10,
  maxBytesPerFile: 6_000,
  maxDependencyDepth: 3,
  broadLocalContext: false,
  maxModuleRelatedFiles: 24,
};

/** Policy khi bật «Đọc rộng source local theo module» */
export const BROAD_CONTEXT_POLICY: ContextBuildPolicy = {
  maxDependencyFiles: 18,
  maxBytesPerFile: 8_000,
  maxDependencyDepth: 4,
  broadLocalContext: true,
  maxModuleRelatedFiles: 40,
};
