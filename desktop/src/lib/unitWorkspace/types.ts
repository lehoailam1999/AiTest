import type {
  UnitGenVia,
  UnitJobTimelineEntry,
  UnitTransformName,
} from "./unitJobEvents";

export type { UnitGenVia, UnitJobTimelineEntry, UnitTransformName };

export type WorkspaceFileOp = "new" | "modify" | "delete";

export type UnitWorkspaceStatus =
  | "draft"
  | "generating"
  | "generated"
  | "gen_with_gap"
  | "gen_failed"
  | "verifying"
  | "pass"
  | "fail"
  | "applied"
  | "discarded";

export type ManifestFileEntry = {
  op: WorkspaceFileOp;
  /** Path relative to project root (Apply target). */
  targetRel: string;
  /** Opaque Tool-draft key (OS temp), never a source-tree path. */
  workspaceRel: string;
};

export type UnitWorkspaceManifest = {
  version: 1;
  runId: string;
  projectId: string;
  testCaseId: string;
  createdAt: string;
  status: UnitWorkspaceStatus;
  files: ManifestFileEntry[];
  provider?: string;
  sourceFileName?: string;
  verify?: VerifyReport;
  appliedAt?: string;
  repairAttempts?: number;
  /** Step 3 — số lần verify trong auto-repair loop */
  autoRepairAttempts?: number;
  /** unit (default) or api — Sprint 4 P5e */
  artifactKind?: "unit" | "api";
  /**
   * Package owning the SUT (e.g. backend, frontend). Empty = apply root is the package.
   * Tool draft lives in OS temp; Apply writes under `{packagePrefix}/AItest/`.
   */
  packagePrefix?: string;
  /** Step 5 — npm scope / gradle project name for coverage tagging */
  packageName?: string;
  /** Correlation id for Gen → Verify → Apply */
  jobId?: string;
  /** IDE RPC command id when via ide-extension */
  commandId?: string;
  via?: UnitGenVia;
  transforms?: UnitTransformName[];
  timeline?: UnitJobTimelineEntry[];
  failReason?: string;
};

export type VerifyStageName = "compile" | "test" | "coverage";

export type VerifyStageResult = {
  stage: VerifyStageName;
  success: boolean;
  command: string;
  exitCode: number;
  durationMs: number;
  logExcerpt: string;
};

/** Step 4 — snapshot sau khi sync coverage/junit → PostgreSQL */
export type CoverageSyncSnapshot = {
  uploaded: number;
  linePct?: number | null;
  format?: string | null;
  reportId?: string | null;
  junit?: { tests?: number; passed?: number; failed?: number } | null;
};

export type VerifyReport = {
  ranAt: string;
  overallPass: boolean;
  stages: VerifyStageResult[];
  coverageSync?: CoverageSyncSnapshot | null;
};

export type StagingBackup = {
  targetRel: string;
  /** null = file did not exist before staging */
  previousContent: string | null;
};

export type WorkspacePreviewFile = {
  entry: ManifestFileEntry;
  content: string;
  /** Source content before change (modify only). */
  baseContent?: string | null;
};
