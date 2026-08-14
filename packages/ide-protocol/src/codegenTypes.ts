/**
 * Codegen command / callback types (IDE Extension Protocol — Unit & E2E).
 * Phase A: applyFiles + runTests. Phase B: generate*Batch.
 */

export type CodegenAction =
  | "APPLY_FILES"
  | "RUN_TESTS"
  | "GENERATE_UNIT_BATCH"
  | "GENERATE_E2E_BATCH"
  | "CANCEL";

export type CodegenFileKind =
  | "spec"
  | "page"
  | "fixture"
  | "config"
  | "unit"
  | "helper"
  | "other";

export type CodegenFileDto = {
  path: string;
  content: string;
  kind?: CodegenFileKind;
};

export type CodegenLayout = "unit" | "e2e";

export type CodegenProjectRulesSource =
  | "e2e-conventions"
  | "unit-conventions"
  | "none"
  | "body";

/** Common envelope for codegen commands */
export type CodegenCommandBase = {
  commandId: string;
  action: CodegenAction;
  projectId: string;
  projectRoot: string;
  packagePrefix?: string;
  projectRules?: string;
  projectRulesSource?: CodegenProjectRulesSource;
  profileExcerpt?: string;
  indexVersion?: string;
};

export type CodegenApplyFilesParams = CodegenCommandBase & {
  action: "APPLY_FILES";
  layout: CodegenLayout;
  files: CodegenFileDto[];
};

export type CodegenTestRunner =
  | "playwright"
  | "dotnet"
  | "jest"
  | "vitest"
  | "pytest"
  | "custom";

/** Only allowlisted E2E_* keys should be sent for Playwright. */
export type CodegenRunTestsParams = CodegenCommandBase & {
  action: "RUN_TESTS";
  runner: CodegenTestRunner;
  /** Working directory relative to projectRoot (or absolute under project) */
  cwd?: string;
  /** Spec/filter paths relative to projectRoot */
  specs?: string[];
  /** Full shell command when runner=custom */
  command?: string[];
  env?: Record<string, string>;
  headed?: boolean;
  timeoutMs?: number;
};

export type CodegenUnitItem = {
  testCaseId: string;
  title: string;
  module?: string;
  suggestedPath?: string;
  contextPacket?: unknown;
  existingFiles?: CodegenFileDto[];
  testData?: string;
  steps?: string;
  expectedOutcome?: string;
  /**
   * When set, Extension Gen is a Repair oneshot (same CLI engine as Gen).
   * AITest orchestrates; IDE AI CLI rewrites the failing test.
   */
  repairContext?: string;
};

export type CodegenE2eItem = {
  testCaseId: string;
  title: string;
  module?: string;
  requirementTitle?: string;
  featurePath?: string;
  authRole?: string;
  locatorContract: string;
  pomScaffold?: string;
  storageStateRel?: string;
  executionContext?: string;
  testData?: string;
  steps?: string;
  expectedOutcome?: string;
  /** FE primary for Agent CLI grounding */
  sourceFileName?: string;
  sourceCode?: string;
  relatedSources?: { path: string; content: string }[];
  /** Target spec under AItest/E2ETest/{Req}/{TC}/specs/ */
  suggestedSpecPath?: string;
  existingFiles?: CodegenFileDto[];
};

export type CodegenGenerateUnitBatchParams = CodegenCommandBase & {
  action: "GENERATE_UNIT_BATCH";
  items: CodegenUnitItem[];
  /** Phase 2 — reuse AI CLI session opened via codegen.openSession */
  sessionId?: string;
  /** Project VI→code aliases (meta.codeAliases) for SUT resolve */
  codeAliases?: Record<string, string[]>;
  /**
   * Desktop-resolved AI CLI executable on the user machine.
   * Extension must spawn this path — not a bare command name.
   */
  agentExecutable?: string;
};

export type CodegenGenerateE2eBatchParams = CodegenCommandBase & {
  action: "GENERATE_E2E_BATCH";
  items: CodegenE2eItem[];
  sessionId?: string;
  /** Desktop-resolved AI CLI executable on the user machine. */
  agentExecutable?: string;
};

export type CodegenOpenSessionParams = {
  projectRoot: string;
  projectId?: string;
  /** unit | e2e — which engine pool */
  kind?: "unit" | "e2e";
  /** Desktop-resolved AI CLI executable — bind once per session. */
  agentExecutable?: string;
};

export type CodegenOpenSessionResult = {
  ok: boolean;
  sessionId: string;
  workspaceRoot: string;
  capabilities?: string[];
};

export type CodegenCloseSessionParams = {
  sessionId: string;
};

export type CodegenCloseSessionResult = {
  ok: boolean;
  generateCount?: number;
};

export type CodegenCancelParams = {
  commandId: string;
  action: "CANCEL";
};

export type CodegenFileStatus =
  | "CREATED"
  | "UPDATED"
  | "SKIPPED"
  | "REJECTED_JAIL"
  | "ERROR";

export type CodegenGeneratedFileMeta = {
  path: string;
  size?: number;
  status: CodegenFileStatus;
  error?: string;
};

export type CodegenWorkspaceTree = {
  testRoot?: string;
  generatedFiles: CodegenGeneratedFileMeta[];
};

export type CodegenPerTcResult = {
  testCaseId: string;
  genOk?: boolean;
  guardErrors?: string[];
  filePaths?: string[];
  /** Production SUT used for grounding / import rewrite */
  sourceFileName?: string;
  runOk?: boolean;
  error?: string;
  /** Phase 3 — per-TC gen metrics from Extension */
  metrics?: import("./unitRuleEngine.js").UnitGenPhaseMetrics;
};

export type CodegenRunError = {
  testCaseId?: string;
  title?: string;
  stacktrace: string;
  screenshotPath?: string;
};

export type CodegenTestRunReport = {
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  errors: CodegenRunError[];
};

export type CodegenResultStatus =
  | "COMPLETED"
  | "PARTIAL"
  | "FAILED"
  | "CANCELLED"
  | "RUNNING";

export type CodegenResultCallback = {
  commandId: string;
  status: CodegenResultStatus;
  workspaceTree?: CodegenWorkspaceTree;
  perTc?: CodegenPerTcResult[];
  testRunReport?: CodegenTestRunReport;
  /**
   * Phase B Gen draft — file contents for Desktop staging (same shape as apply payload).
   * Prefer this over re-reading disk after Extension Gen.
   */
  files?: CodegenFileDto[];
  artifacts?: {
    logExcerpt?: string;
    junitPath?: string;
  };
  error?: string;
};

export type CodegenProgressPhase =
  | "queued"
  | "applying"
  | "generating"
  | "guarding"
  | "running"
  | "done";

export type CodegenProgressNotification = {
  commandId: string;
  phase: CodegenProgressPhase;
  current?: number;
  total?: number;
  message?: string;
};

/** Immediate RPC response for apply/run (full result also via notify). */
export type CodegenApplyFilesResult = {
  commandId: string;
  workspaceTree: CodegenWorkspaceTree;
  status: CodegenResultStatus;
};

export type CodegenRunTestsResult = {
  commandId: string;
  testRunReport: CodegenTestRunReport;
  status: CodegenResultStatus;
  artifacts?: CodegenResultCallback["artifacts"];
};
