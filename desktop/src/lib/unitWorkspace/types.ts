export type WorkspaceFileOp = "new" | "modify" | "delete";

export type UnitWorkspaceStatus =
  | "draft"
  | "generated"
  | "verifying"
  | "pass"
  | "fail"
  | "applied"
  | "discarded";

export type ManifestFileEntry = {
  op: WorkspaceFileOp;
  /** Path relative to project root (Apply target). */
  targetRel: string;
  /** Path relative to project root (under overlay/). */
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
  /** unit (default) or api — Sprint 4 P5e */
  artifactKind?: "unit" | "api";
  /**
   * Package owning the SUT (e.g. backend, frontend). Empty = apply root is the package.
   * Staging lives under `{packagePrefix}/.ai-test/`; Apply under `{packagePrefix}/AItest/`.
   */
  packagePrefix?: string;
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

export type VerifyReport = {
  ranAt: string;
  overallPass: boolean;
  stages: VerifyStageResult[];
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
