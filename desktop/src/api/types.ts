export type Project = {
  id: string;
  name: string;
  description?: string | null;
  code?: string | null;
  language?: string | null;
  framework?: string | null;
  meta?: ProjectMeta | null;
  isActive: boolean;
  requirementCount: number;
  testCaseCount: number;
  createdAt: string;
};

export type ProjectMeta = {
  syncedAt?: string;
  frameworks?: string[];
  testFrameworks?: string[];
  stacks?: string[];
  solutionCount?: number;
  csprojCount?: number;
  testProjectCount?: number;
  sdkVersion?: string | null;
  scanName?: string;
  scanLanguage?: string;
  modules?: {
    name: string;
    language?: string | null;
    frameworks?: string[];
    stacks?: string[];
  }[];
  /**
   * Alias VI/nhãn → token mã nguồn, theo từng dự án.
   * VD: { "chia sẻ vật chứng": ["EvidenceShare", "ShareEvidence"] }
   */
  codeAliases?: Record<string, string[]>;
  /**
   * 3-tier AI Rules — Project + User (System cố định trên BE).
   * Precedence khi xung đột: System > Project > User.
   */
  aiRules?: {
    /** Auto từ stack scan — regenerate khi sync trừ khi lockProjectAuto */
    projectAuto?: string;
    /** Ghi chú dự án bền (người dùng / team) */
    projectExtra?: string;
    /** Quy tắc cá nhân trên UI */
    user?: string;
    /** Không ghi đè projectAuto khi sync */
    lockProjectAuto?: boolean;
  };
  /** EX4.3 — E2E console env persisted per project */
  e2e?: {
    targetUrl?: string;
    useStorageState?: boolean;
    seedCommand?: string;
    teardownCommand?: string;
    usePlaywrightInspect?: boolean;
    /** Mở cửa sổ Chromium khi Headless (--headed). Default true trên console. */
    showBrowser?: boolean;
    /** Optional override — primary auth: AI seed → .ai-test/auth */
    username?: string;
    /** Optional override — primary auth: AI seed → .ai-test/auth */
    password?: string;
    /** @deprecated Manual UI removed — path derives from TC/FE/Inspect per generate */
    featurePath?: string;
  };
};

export type Connection = {
  id: string;
  projectId: string;
  modelName?: string | null;
  status: string;
  lastVerifiedAt?: string | null;
  lastError?: string | null;
  cliType?: string | null;
  cliPath?: string | null;
  cliArgsJson?: string | null;
};

export type RequirementTopicItem = {
  id: string;
  title: string;
  notes?: string;
};

export type RequirementTopic = {
  id: string;
  title: string;
  notes?: string;
  items: RequirementTopicItem[];
};

export type Requirement = {
  id: string;
  projectId: string;
  title: string;
  description?: string | null;
  inputType: string;
  status: string;
  version: number;
  contentHash?: string | null;
  contentVersion?: number;
  changeSummary?: string | null;
  hasUserStory?: boolean;
  hasSrs?: boolean;
  featureCount?: number;
  fileName?: string | null;
  topics?: RequirementTopic[];
  createdAt: string;
  updatedAt?: string;
};

export type RequirementSource = {
  sourceType: string;
  content: string;
  fileName?: string | null;
  title?: string | null;
  previewHtml?: string | null;
};

export type ParsedRequirementFile = {
  fileName: string;
  text: string;
  html?: string | null;
  parser: string;
  warning?: string;
  charCount: number;
};

/** R1 — Requirement Studio workspace (PG) */
export type RequirementStudioWorkspace = {
  id: string;
  projectId: string;
  title: string;
  status: string;
  legacySourceId?: string | null;
  fileCount?: number;
  knowledgeStatus?: string;
  knowledgeVersion?: number;
  snapshotCount?: number;
  tcTotal?: number;
  tcPending?: number;
  tcApproved?: number;
  createdAt?: string;
  updatedAt?: string;
};

export type RequirementFileRef = {
  id: string;
  workspaceId: string;
  fileName: string;
  mimeType?: string | null;
  byteSize: number;
  contentSha256: string;
  parseStatus: "pending" | "ready" | "error" | string;
  parseError?: string | null;
  parser?: string | null;
  parseWarning?: string | null;
  storageKind: string;
  charCount: number;
  hasPreview: boolean;
  extractedText?: string | null;
  previewHtml?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type KnowledgePayload = {
  summary?: string;
  features?: { name: string; description?: string }[];
  actors?: { name: string; description?: string; permissions?: string }[];
  useCases?: { name: string; steps?: string; /** flowchart TD — Analysis UI; steps vẫn nuôi Sinh TC */ mermaid?: string }[];
  /** WHO for E2E: actor/auth/roles per scenario — not login mechanism */
  executionContexts?: {
    name: string;
    actor?: string;
    authRequired?: boolean;
    roles?: string[];
    permissions?: string;
    sessionHint?: string;
    notes?: string;
  }[];
  businessRules?: { id?: string; text: string; priority?: string }[];
  validationRules?: { field?: string; rule: string; module?: string }[];
  apiSummary?: { method?: string; path: string; note?: string }[];
  exceptions?: { text: string }[];
  acceptanceCriteria?: { text: string }[];
  constraints?: { text: string }[];
  /** Merged open questions + missing — blocks accurate TC gen */
  gaps?: { text: string }[];
  /** Legacy dual-write (folded into gaps / validation on normalize) */
  glossary?: { term: string; definition?: string }[];
  databaseSummary?: { entity: string; note?: string }[];
  openQuestions?: { text: string }[];
  missingInformation?: { text: string }[];
};

export type CoverageDimensionStatus = "complete" | "partial" | "missing" | string;

export type RequirementCoverageDimension = {
  dimension: string;
  status: CoverageDimensionStatus;
  notes?: string;
  signals?: string[];
};

export type RequirementCoverage = {
  analyzer?: string;
  analyzedAt?: string;
  dimensions: RequirementCoverageDimension[];
  totals: { complete: number; partial: number; missing: number };
  missingDimensions?: string[];
  partialDimensions?: string[];
};

export type KnowledgeWorkspaceView = {
  id?: string;
  workspaceId?: string;
  projectId?: string;
  status: "empty" | "building" | "ready" | "stale" | "updating" | string;
  version: number;
  builder?: string | null;
  summary?: string | null;
  payload?: KnowledgePayload | null;
  coverage?: RequirementCoverage | null;
  sourceFileCount: number;
  sourceChunkCount: number;
  error?: string | null;
  builtAt?: string | null;
  updatedAt?: string;
  /** True while background Cursor/LLM enrich is running after heuristic ready */
  enrichPending?: boolean;
  enrichError?: string | null;
  /** Phase timing from last enrich (prepare/llm/persist ms, prompt_chars, …) */
  enrichTiming?: Record<string, number | string> | null;
  enrichCacheHit?: boolean;
};

export type FreezeWarning = {
  code?: string;
  message?: string;
  missingDimensions?: string[];
};

export type RequirementSnapshot = {
  id: string;
  workspaceId: string;
  projectId: string;
  knowledgeId?: string | null;
  knowledgeVersion: number;
  title: string;
  summary?: string | null;
  payload?: KnowledgePayload | null;
  coverage?: RequirementCoverage | null;
  sourceFileCount?: number;
  sourceChunkCount?: number;
  frozenBy?: string | null;
  freezeNote?: string | null;
  createdAt?: string;
  updatedAt?: string;
};

export type FreezeResult = {
  snapshot: RequirementSnapshot;
  warnings: FreezeWarning[];
  acknowledgedMissing?: boolean;
};

export type RequirementDetail = Requirement & {
  sources: RequirementSource[];
};

export type Job = {
  id: string;
  projectId: string;
  sourceId?: string | null;
  requirementSnapshotId?: string | null;
  status: string;
  backendType?: string | null;
  generateStrategy?: "append" | "replace" | null;
  requirementVersion?: number | null;
  runnerUsed?: string | null;
  cliSessionKey?: string | null;
  progressMessage?: string | null;
  /** Live transcript từ AI CLI (stream-json / phase logs) */
  progressLog?: string[] | null;
  error?: string | null;
  startedAt?: string | null;
  completedAt?: string | null;
  createdAt: string;
};

export type FreezeAndGenerateResult = {
  snapshot: RequirementSnapshot;
  warnings: FreezeWarning[];
  job: Job;
  preferredEngine?: "unit" | "e2e" | null;
};

export type TestCase = {
  id: string;
  projectId: string;
  sourceId?: string | null;
  requirementSnapshotId?: string | null;
  jobId?: string | null;
  testCaseId: string;
  title: string;
  module?: string | null;
  type: string;
  priority: string;
  severity: string;
  precondition?: string | null;
  steps: string;
  expectedResult: string;
  actualResult?: string | null;
  testData?: string | null;
  automationReady: boolean;
  isAiGenerated: boolean;
  reviewStatus: "Draft" | "InReview" | "Approved" | "Rejected";
  reviewComment?: string | null;
  reviewedAt?: string | null;
  executionStatus: string;
  generatedFromHash?: string | null;
  generatedFromVersion?: number | null;
  isStale?: boolean;
  needsReview?: boolean;
  createdAt: string;
};

export type Execution = {
  id: string;
  projectId: string;
  command: string;
  exitCode: number;
  status: string;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  logExcerpt: string;
  startedAt: string;
  finishedAt: string;
};

export type UnitResult = {
  code: string;
  suggestedPath: string;
  fileName: string;
  testCaseId: string;
  projectId: string;
  provider: string;
  /** AI_CLI — Step 1 unit CLI workflow */
  runnerUsed?: string;
  cliSessionKey?: string | null;
  /** Step 2 — ProjectInspector snapshot */
  stackInspect?: StackInspect | null;
};

export type StackInspect = {
  language: string;
  framework: string;
  test_dir: string;
  native_test_dir: string;
  run_command: string[];
  file_extension: string;
  manifest?: string;
  package_root?: string;
  package_name?: string;
  is_monorepo_package?: boolean;
  /** Step 5 — pnpm|turbo|nx|maven|… */
  workspace_kind?: string;
  coverage_command?: string[];
  compile_command?: string[];
  suggested_unit_path?: string | null;
  suggested_file_name?: string | null;
};

export type WorkspaceRunVerifySnapshot = {
  overallPass: boolean;
  compileStatus?: string | null;
  testStatus?: string | null;
  coverageStatus?: string | null;
  summaryJson?: string | null;
};

export type WorkspaceRunAudit = {
  id: string;
  projectId: string;
  localRunId: string;
  testType: string;
  testCaseId?: string | null;
  module?: string | null;
  status: string;
  provider?: string | null;
  contextSource?: string | null;
  agentConfidence?: number | null;
  agentOverride?: boolean;
  startedAt?: string | null;
  finishedAt?: string | null;
  createdAt: string;
  /** Phase U2 — latest verify snapshot on list */
  latestVerify?: WorkspaceRunVerifySnapshot | null;
};

export type WorkspaceRunDetail = {
  run: WorkspaceRunAudit;
  verifies: Array<{
    id: string;
    workspaceRunId: string;
    localRunId: string;
    compileStatus?: string | null;
    testStatus?: string | null;
    coverageStatus?: string | null;
    overallPass: boolean;
    summaryJson?: string | null;
    createdAt: string;
  }>;
  applies: Array<{
    id: string;
    workspaceRunId: string;
    localRunId: string;
    filesApplied: string[];
    success: boolean;
    rollbackUsed?: boolean;
    appliedAt?: string | null;
    createdAt: string;
  }>;
};

export type GenerationTaskAudit = {
  id: string;
  campaignId: string;
  testCaseId?: string | null;
  localRunId?: string | null;
  status: string;
  error?: string | null;
  sortOrder: number;
  createdAt: string;
};

export type GenerationCampaignAudit = {
  id: string;
  projectId: string;
  kind: string;
  scopeLevel?: string | null;
  scopeLabel?: string | null;
  status: string;
  startedAt: string;
  finishedAt?: string | null;
  tasks: GenerationTaskAudit[];
  createdAt: string;
};
