import { authFetch, authUpload, type Paged } from "./client";
import type {
  Connection,
  Execution,
  Job,
  ParsedRequirementFile,
  Project,
  ProjectMeta,
  Requirement,
  RequirementDetail,
  RequirementSource,
  TestCase,
  UnitResult,
} from "./types";

function qs(params: Record<string, string | number | undefined>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== "");
  if (entries.length === 0) return "";
  return "?" + entries.map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`).join("&");
}

export const projects = {
  list: (page = 1, pageSize = 50) =>
    authFetch<Paged<Project>>(`/projects${qs({ page, pageSize })}`),
  get: (id: string) => authFetch<Project>(`/projects/${id}`),
  create: (body: {
    name: string;
    description?: string;
    code?: string;
    language?: string;
    framework?: string;
  }) => authFetch<Project>("/projects", { method: "POST", body: JSON.stringify(body) }),
  update: (
    id: string,
    body: {
      name?: string;
      description?: string;
      code?: string;
      language?: string | null;
      framework?: string | null;
      meta?: ProjectMeta | null;
    }
  ) => authFetch<Project>(`/projects/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) => authFetch<unknown>(`/projects/${id}`, { method: "DELETE" }),
};

export const connection = {
  get: (projectId: string) =>
    authFetch<Connection>(`/projects/${projectId}/connection`),
  save: (
    projectId: string,
    body: {
      provider: string;
      modelName?: string | null;
      baseUrl?: string;
      apiKey?: string;
      runnerMode?: string;
      cliType?: string;
      cliPath?: string;
      cliArgsJson?: string;
    }
  ) =>
    authFetch<Connection>(`/projects/${projectId}/connection`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  verify: (projectId: string) =>
    authFetch<Connection>(`/projects/${projectId}/connection/verify`, {
      method: "POST",
    }),
  cliSessions: (projectId: string) =>
    authFetch<{ items: { sessionKey: string; status: string; alive: boolean; idleSeconds: number }[] }>(
      `/projects/${projectId}/connection/cli-sessions`
    ),
};

export const requirements = {
  list: (projectId: string, page = 1, pageSize = 50) =>
    authFetch<Paged<Requirement>>(`/requirements${qs({ projectId, page, pageSize })}`),
  create: (body: {
    projectId: string;
    title: string;
    description?: string;
    content?: string;
    inputType?: string;
    sources?: RequirementSource[];
  }) => authFetch<Requirement>("/requirements", { method: "POST", body: JSON.stringify(body) }),
  get: (id: string) => authFetch<RequirementDetail>(`/requirements/${id}`),
  update: (
    id: string,
    body: {
      title?: string;
      description?: string;
      content?: string;
      sources?: RequirementSource[];
      changeSummary?: string;
      clearDocuments?: boolean;
    }
  ) => authFetch<Requirement>(`/requirements/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) =>
    authFetch<{ status: string; deletedTestCases?: number; deletedTopics?: number }>(
      `/requirements/${id}`,
      { method: "DELETE" }
    ),
  parseFile: (file: File) => {
    const form = new FormData();
    form.append("file", file);
    return authUpload<ParsedRequirementFile>("/requirements/parse-file", form);
  },
  getTopics: (id: string) =>
    authFetch<{ topics: import("./types").RequirementTopic[] }>(`/requirements/${id}/topics`),
  putTopics: (id: string, topics: import("./types").RequirementTopic[]) =>
    authFetch<{ topics: import("./types").RequirementTopic[] }>(`/requirements/${id}/topics`, {
      method: "PUT",
      body: JSON.stringify({ topics }),
    }),
};

export const jobs = {
  list: (projectId: string, page = 1, pageSize = 50) =>
    authFetch<Paged<Job>>(`/jobs${qs({ projectId, page, pageSize })}`),
  get: (id: string) => authFetch<Job>(`/jobs/${id}`),
  create: (body: {
    projectId: string;
    sourceId?: string;
    mode?: "append" | "replace";
    useSourceContext?: boolean;
    contextPacket?: Record<string, unknown>;
    topicScope?: Record<string, unknown>;
  }) => authFetch<Job>("/jobs", { method: "POST", body: JSON.stringify(body) }),
  /** Cooperative pause — giữ TC đã lưu; module còn lại chờ resume. */
  pause: (id: string) =>
    authFetch<Job>(`/jobs/${id}/pause`, { method: "POST", body: "{}" }),
  /** Tiếp tục job Paused — chỉ sinh bổ sung module còn lại. */
  resume: (id: string) =>
    authFetch<Job>(`/jobs/${id}/resume`, { method: "POST", body: "{}" }),
};

export type TestCaseInput = {
  projectId: string;
  sourceId?: string;
  title: string;
  module?: string;
  type?: string;
  priority?: string;
  severity?: string;
  precondition?: string;
  steps: string;
  expectedResult: string;
  testData?: string;
};

export const testcases = {
  list: (
    params: {
      projectId?: string;
      sourceId?: string;
      jobId?: string;
      reviewStatus?: string;
    },
    page = 1,
    pageSize = 100
  ) =>
    authFetch<Paged<TestCase>>(`/testcases${qs({ ...params, page, pageSize })}`),
  /** Page through API (cap 100/page) until all items for filters are loaded. */
  listAll: async (
    params: {
      projectId?: string;
      sourceId?: string;
      jobId?: string;
      reviewStatus?: string;
    },
    pageSize = 100
  ) => {
    const size = Math.min(Math.max(pageSize, 1), 100);
    const all: TestCase[] = [];
    let page = 1;
    for (;;) {
      const res = await authFetch<Paged<TestCase>>(
        `/testcases${qs({ ...params, page, pageSize: size })}`
      );
      all.push(...res.items);
      if (!res.hasNext || res.items.length === 0) break;
      page += 1;
      if (page > 200) break;
    }
    return all;
  },
  get: (id: string) => authFetch<TestCase>(`/testcases/${id}`),
  create: (body: TestCaseInput) =>
    authFetch<TestCase>("/testcases", { method: "POST", body: JSON.stringify(body) }),
  update: (id: string, body: Partial<TestCaseInput>) =>
    authFetch<TestCase>(`/testcases/${id}`, { method: "PUT", body: JSON.stringify(body) }),
  remove: (id: string) =>
    authFetch<{ status: string; deleted?: boolean }>(`/testcases/${id}`, { method: "DELETE" }),
  submit: (id: string) =>
    authFetch<TestCase>(`/testcases/${id}/submit`, { method: "POST" }),
  approve: (id: string) =>
    authFetch<TestCase>(`/testcases/${id}/approve`, { method: "POST" }),
  reject: (id: string, comment?: string) =>
    authFetch<TestCase>(`/testcases/${id}/reject`, {
      method: "POST",
      body: JSON.stringify({ comment }),
    }),
};

export const generateUnit = {
  run: (body: {
    projectId: string;
    testCaseId: string;
    sourceFileName?: string;
    /** Optional when workspaceId set — BE reads disk */
    sourceCode?: string;
    workspaceId?: string;
    relatedPaths?: string[];
    className?: string;
    methodName?: string;
    framework?: string;
    language?: string;
    relatedSources?: { path: string; content: string; role?: string }[];
    contextPacket?: Record<string, unknown>;
    repairContext?: string;
    agentConfidence?: number;
    agentEnough?: boolean;
    agentOverride?: boolean;
    contextSource?: string;
    /** Step 2 — absolute local project root for ProjectInspector */
    projectRoot?: string;
    packagePrefix?: string | null;
    module?: string;
    /** Phase 5 — optional TestPlan (Mock→Arrange→Act→Assert hint) */
    planner?: Record<string, unknown>;
    /** Phase 5 — optional file list; packet still preferred when present */
    contextFiles?: { path: string; content: string }[];
    /** Phase 5 — code index schema stamp */
    indexVersion?: string;
    /** Sprint 3 — conventions from .ai-test/unit-conventions.md */
    projectRules?: string;
    projectRulesSource?: "unit-conventions" | "none";
  }) => authFetch<UnitResult>("/generate-unit", { method: "POST", body: JSON.stringify(body) }),
  /** Step 2 — inspect stack without generating */
  inspect: (body: {
    projectRoot: string;
    sourceFileName?: string;
    module?: string;
    packagePrefix?: string | null;
  }) => authFetch<import("./types").StackInspect>("/project-inspect", { method: "POST", body: JSON.stringify(body) }),
};

/** P9 — Business Analyzer (TC → BusinessIntent, no source) */
export type BusinessIntentDto = {
  action: string;
  entity: string;
  expectedResults: string[];
  businessRules: string[];
  validationRules: string[];
  externalDeps: string[];
  domainTerms: string[];
  searchHints: string[];
  source?: "llm" | "heuristic";
  testCaseId?: string;
  testCaseKey?: string;
  fallbackReason?: string;
};

export const agentApi = {
  analyzeIntent: (body: {
    projectId: string;
    testCaseId: string;
    preferHeuristic?: boolean;
  }) =>
    authFetch<BusinessIntentDto>("/agent/analyze-intent", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pickUnitPrimary: (body: {
    projectId: string;
    requirementTitle?: string;
    module?: string;
    title?: string;
    steps?: string;
    expectedResult?: string;
    candidates: Array<{ path: string; code?: string; score?: number }>;
  }) =>
    authFetch<{
      path?: string | null;
      code?: string | null;
      confidence?: number | null;
      source?: string;
    }>("/agent/pick-unit-primary", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  pickUnitField: (body: {
    projectId: string;
    fieldLabel: string;
    inputKeys?: string[];
    title?: string;
    steps?: string;
    primaryPath?: string;
    candidates: Array<{ property: string } | string>;
  }) =>
    authFetch<{
      property?: string | null;
      confidence?: number | null;
      source?: string;
    }>("/agent/pick-unit-field", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const generateApiTest = {
  run: (body: {
    projectId: string;
    testCaseId: string;
    sourceFileName?: string;
    /** Optional when workspaceId set — BE reads disk */
    sourceCode?: string;
    workspaceId?: string;
    relatedPaths?: string[];
    openApiSpec?: string;
    className?: string;
    methodName?: string;
    framework?: string;
    language?: string;
    relatedSources?: { path: string; content: string; role?: string }[];
    contextPacket?: Record<string, unknown>;
    repairContext?: string;
    /** Sprint 3 alignment — conventions payload from Desktop */
    projectRules?: string;
    projectRulesSource?: "unit-conventions" | "e2e-conventions" | "none";
  }) =>
    authFetch<UnitResult>("/generate-api-test", { method: "POST", body: JSON.stringify(body) }),
};

export type E2EFileDto = {
  path: string;
  content: string;
  kind: string;
};

export type E2EGenerateResult = {
  files: E2EFileDto[];
  suggestedPaths: string[];
  primarySpecPath: string;
  testCaseId: string;
  projectId: string;
  provider?: string;
  runnerUsed?: string;
  cliSessionKey?: string | null;
  playwrightConfigScaffold?: string;
};

export type E2EInspectResult = {
  targetUrl?: string | null;
  source: string;
  routes: string[];
  elements: {
    tag: string;
    role?: string | null;
    name?: string | null;
    testId?: string | null;
    ariaLabel?: string | null;
    placeholder?: string | null;
    type?: string | null;
    href?: string | null;
    selectorCandidates: string[];
  }[];
  promptJson: string;
  rawSnippet?: string | null;
};

export type E2ESandboxResult = {
  status: "PASSED" | "FAILED" | string;
  attempts: number;
  primarySpecPath: string;
  files: E2EFileDto[];
  errorLog?: string | null;
  workCwd?: string | null;
  history: {
    attempt: number;
    exitCode: number;
    success: boolean;
    logExcerpt: string;
  }[];
  runCommand?: string[];
};

export type E2EModuleSandboxResult = {
  status: "PASSED" | "FAILED" | string;
  files: E2EFileDto[];
  workCwd?: string | null;
  log?: string;
  runCommand?: string[];
  specs: {
    specPath: string;
    success: boolean;
    title?: string;
    errorExcerpt?: string;
  }[];
  heal?: {
    specPath: string;
    status: string;
    attempts?: number;
    errorLog?: string | null;
    primarySpecPath?: string;
  }[];
  healSkipped?: string;
};

export type E2EArtifactsSyncResult = {
  reportId?: string | null;
  artifactCount: number;
  artifacts: { kind: string; path: string; sizeBytes?: number | null }[];
  packagePrefix?: string | null;
  status?: string | null;
};

export const generateE2e = {
  run: (body: {
    projectId: string;
    testCaseId: string;
    targetUrl?: string;
    domSnapshot?: string;
    sourceFileName?: string;
    sourceCode?: string;
    module?: string;
    requirementTitle?: string;
    packagePrefix?: string | null;
    projectRoot?: string;
    storageStateRel?: string;
    seedCommand?: string;
    teardownCommand?: string;
    framework?: string;
    language?: string;
    relatedSources?: { path: string; content: string }[];
    existingFiles?: { path: string; content: string; kind?: string }[];
    /** WHO from Analysis/TC — actor/authRequired/authRole (not login mechanism) */
    executionContext?: string;
    /**
     * Optional in-memory enriched testData (path/authRole strip+append).
     * When set, API prefers this over DB TC.test_data for Gen gates/prompts.
     */
    testData?: string;
    /** Feature entry path — baked into Spec at Generate (Phase wire) */
    featurePath?: string;
    /** Grounding allow-list built from FE/DOM hooks */
    locatorContract?: string;
    /** Deterministic Page Object scaffold (method contract) */
    pomScaffold?: string;
    /** Sprint 2 — excerpt from .ai-test/e2e-conventions.md */
    projectRules?: string;
    /** Sprint 2.4 — telemetry source for rule resolution */
    projectRulesSource?: "e2e-conventions" | "none";
    /** Skip ensure_auth_seed_roles after LLM when Desktop already has artifact */
    skipAuthSeed?: boolean;
    /** Desktop already inspected — do not API auto-inspect */
    skipAutoInspect?: boolean;
    /** Phase 5 — optional TestPlan (Fixture→Locator→Action→Assertion→Cleanup) */
    planner?: Record<string, unknown>;
    /** Phase 5 — optional file list when relatedSources empty */
    contextFiles?: { path: string; content: string }[];
    /** Phase 5 — code index schema stamp */
    indexVersion?: string;
  }) =>
    authFetch<E2EGenerateResult>("/generate-e2e", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  inspect: (body: {
    targetUrl?: string;
    sourceCode?: string;
    projectRoot?: string;
    sourcePaths?: string[] | { path: string; content: string }[];
    /** EX4.2 — Chromium render for SPA */
    usePlaywright?: boolean;
    /** Phase 1 — post-auth DOM */
    featurePath?: string;
    storageStatePath?: string;
    storageStateRel?: string;
    username?: string;
    password?: string;
    /** Help API find AItest/.../fixtures/storageState.json */
    module?: string;
    role?: string;
    packagePrefix?: string | null;
  }) =>
    authFetch<E2EInspectResult>("/e2e-inspect", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Gate — @playwright/test + npx under project root */
  playwrightCheck: (body: { projectRoot: string }) =>
    authFetch<{
      ok: boolean;
      message: string;
      hasPackage: boolean;
      hasNpx: boolean;
      checkedRoot?: string;
      packageRoot?: string | null;
      source?: "project" | "aitest" | "none";
      installHint: string;
    }>("/e2e-playwright-check", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Cài Chromium dùng chung vào ~/.aitest/playwright-runner */
  playwrightEnsure: (body?: { force?: boolean }) =>
    authFetch<{
      ok: boolean;
      message: string;
      runnerDir: string;
      installed: boolean;
      source: string;
    }>("/e2e-playwright-ensure", {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  /** Discover auth from project .ai-test/auth / storageState / .env fallback. */
  authDiscover: (body: {
    projectRoot: string;
    module?: string;
    packagePrefix?: string | null;
    role?: string;
  }) =>
    authFetch<{
      ready: boolean;
      defaultRole: string;
      notes: string[];
      envFilesRead: string[];
      roles: {
        role: string;
        hasUsername: boolean;
        hasPassword: boolean;
        storageStateRel?: string | null;
        storageStateValid: boolean;
        source: string;
        skippedSeed: boolean;
      }[];
    }>("/e2e-auth-discover", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** AI analyze source → seed auth artifact under .ai-test/auth (idempotent). */
  authEnsure: (body: {
    projectId: string;
    projectRoot: string;
    testCaseId?: string;
    role?: string;
    targetUrl?: string;
    sourceCode?: string;
    domSnapshot?: string;
    sourceFileName?: string;
    module?: string;
    force?: boolean;
  }) =>
    authFetch<{
      ok: boolean;
      skipped: boolean;
      role: string;
      authRel?: string | null;
      hasUsername: boolean;
      message: string;
      seedRel?: string | null;
    }>("/e2e-auth-ensure", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  sandboxRepair: (body: {
    projectId: string;
    testCaseId: string;
    projectRoot: string;
    files: E2EFileDto[];
    primarySpecPath?: string;
    targetUrl?: string;
    domSnapshot?: string;
    module?: string;
    packagePrefix?: string | null;
    storageStateRel?: string;
    seedCommand?: string;
    teardownCommand?: string;
    maxRetries?: number;
    writeFile?: boolean;
    runCommand?: string[];
    /** Mở cửa sổ Chromium (--headed) */
    headed?: boolean;
    showBrowser?: boolean;
    /** Inject E2E_* into Playwright process (credentials từ AITest UI) */
    playwrightEnv?: Record<string, string>;
    e2eUsername?: string;
    e2ePassword?: string;
  }) =>
    authFetch<E2ESandboxResult>("/e2e-sandbox-repair", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Batch: one Playwright run for specs/ + optional selective heal */
  sandboxModule: (body: {
    projectId: string;
    projectRoot: string;
    files: E2EFileDto[];
    module?: string;
    packagePrefix?: string | null;
    targetUrl?: string;
    domSnapshot?: string;
    storageStateRel?: string;
    seedCommand?: string;
    teardownCommand?: string;
    maxRetries?: number;
    writeFile?: boolean;
    healFailures?: boolean;
    healItems?: {
      testCaseId: string;
      primarySpecPath: string;
      domSnapshot?: string;
      featurePath?: string;
      sourceFileName?: string;
      sourceCode?: string;
      relatedSources?: { path: string; content: string }[];
      locatorContract?: string;
    }[];
    /** Desktop already inspected — API must not auto-refill login-wall DOM */
    skipAutoInspect?: boolean;
    testCaseId?: string;
    runCommand?: string[];
    headed?: boolean;
    showBrowser?: boolean;
    playwrightEnv?: Record<string, string>;
    e2eUsername?: string;
    e2ePassword?: string;
  }) =>
    authFetch<E2EModuleSandboxResult>("/e2e-sandbox-module", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Phase B — guard-only (no LLM) for Extension-local drafts */
  codegenGuard: (body: {
    projectId: string;
    files: E2EFileDto[];
    featurePath?: string;
    locatorContract?: string;
    executionContext?: string;
    authHints?: string;
    authMode?: string;
    useStorageState?: boolean;
    title?: string;
    testData?: string;
  }) =>
    authFetch<{ status: string; files: E2EFileDto[] }>("/e2e-codegen-guard", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  artifactsSync: (body: {
    projectId: string;
    projectRoot: string;
    packagePrefix?: string;
    localRunId?: string;
    testCaseId?: string;
    module?: string;
    status?: string;
    durationMs?: number;
    primarySpecPath?: string;
  }) =>
    authFetch<E2EArtifactsSyncResult>("/e2e-artifacts-sync", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** AI xếp hạng path theo TC — chỉ gửi path, không gửi source */
export const resolveSourceScope = {
  run: (body: { projectId: string; testCaseId: string; candidates: string[] }) =>
    authFetch<{ primary: string; related: string[]; reason: string }>("/resolve-source-scope", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** AI map TC VI → token EN/code để FE lọc file (không gửi source) */
export const resolveSourceTokens = {
  run: (body: { projectId: string; testCaseId: string }) =>
    authFetch<{ tokens: string[]; reason: string }>("/resolve-source-tokens", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export type WorkspaceSessionDto = {
  workspaceId: string;
  projectId: string;
  rootPath: string;
  status: "indexing" | "ready" | "error" | "closed";
  openedAt?: string;
  fileCount: number;
  progress: number;
  errorMessage?: string | null;
  scanGeneration?: number;
};

export type WorkspaceFileMeta = {
  workspaceId: string;
  path: string;
  relativePath: string;
  extension: string;
  language: string;
  size: number;
  lastModified: number;
  hash: string;
};

/** Backend Workspace Manager — scan/search/read trên disk local (metadata only). */
export const workspaceApi = {
  open: (body: { projectId: string; rootPath: string }) =>
    authFetch<WorkspaceSessionDto>("/workspace/open", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  get: (workspaceId: string) =>
    authFetch<WorkspaceSessionDto>(`/workspace/${workspaceId}`),
  status: (workspaceId: string) =>
    authFetch<{
      workspaceId: string;
      status: string;
      fileCount: number;
      progress: number;
      errorMessage?: string | null;
    }>(`/workspace/${workspaceId}/status`),
  refresh: (workspaceId: string, body?: { full?: boolean }) =>
    authFetch<WorkspaceSessionDto>(`/workspace/${workspaceId}/refresh`, {
      method: "POST",
      body: JSON.stringify(body ?? {}),
    }),
  close: (workspaceId: string) =>
    authFetch<{ status: string; workspaceId: string }>(`/workspace/${workspaceId}/close`, {
      method: "POST",
    }),
  files: (
    workspaceId: string,
    params?: { ext?: string; q?: string; limit?: number; cursor?: number }
  ) =>
    authFetch<{
      items: WorkspaceFileMeta[];
      totalCount: number;
      limit: number;
      cursor: number;
    }>(
      `/workspace/${workspaceId}/files${qs({
        ext: params?.ext,
        q: params?.q,
        limit: params?.limit,
        cursor: params?.cursor,
      })}`
    ),
  search: (
    workspaceId: string,
    body: { by?: string; query: string; limit?: number }
  ) =>
    authFetch<{ items: WorkspaceFileMeta[] }>(`/workspace/${workspaceId}/search`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  read: (
    workspaceId: string,
    body: { paths: string[]; maxBytesPerFile?: number }
  ) =>
    authFetch<{
      files: Array<{
        relativePath: string;
        content: string;
        truncated: boolean;
        size: number;
        error?: string | null;
      }>;
    }>(`/workspace/${workspaceId}/read`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  resolveScope: (
    workspaceId: string,
    body: { testCaseId?: string; tokens?: string[]; useAiTokens?: boolean }
  ) =>
    authFetch<{
      primary: string | null;
      related: string[];
      reason: string;
      candidates: string[];
      tokens: string[];
      workspaceId: string;
    }>(`/workspace/${workspaceId}/resolve-scope`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

export const audit = {
  upsertWorkspaceRun: (body: {
    projectId: string;
    localRunId: string;
    testType?: string;
    testCaseId?: string;
    module?: string;
    status?: string;
    provider?: string;
    contextSource?: string;
    agentConfidence?: number;
    agentOverride?: boolean;
  }) =>
    authFetch<import("./types").WorkspaceRunAudit>("/audit/workspace-run", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  postVerifyReport: (body: Record<string, unknown>) =>
    authFetch<unknown>("/audit/verify-report", { method: "POST", body: JSON.stringify(body) }),
  postApplyAudit: (body: Record<string, unknown>) =>
    authFetch<unknown>("/audit/apply", { method: "POST", body: JSON.stringify(body) }),
  listWorkspaceRuns: (
    projectId: string,
    page = 1,
    pageSize = 50,
    opts?: { testType?: "unit" | "e2e" | "api" | string }
  ) =>
    authFetch<{
      items: import("./types").WorkspaceRunAudit[];
      page: number;
      pageSize: number;
      total: number;
    }>(
      `/audit/workspace-runs${qs({
        projectId,
        page,
        pageSize,
        testType: opts?.testType,
      })}`
    ),
  getWorkspaceRunDetail: (projectId: string, runKey: string) =>
    authFetch<import("./types").WorkspaceRunDetail>(
      `/audit/workspace-runs/${encodeURIComponent(runKey)}${qs({ projectId })}`
    ),
  createCampaign: (body: {
    projectId: string;
    kind: string;
    scopeLevel?: string;
    scopeLabel?: string;
  }) =>
    authFetch<import("./types").GenerationCampaignAudit>("/campaigns", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  finishCampaign: (campaignId: string, status: string) =>
    authFetch<import("./types").GenerationCampaignAudit>(`/campaigns/${campaignId}`, {
      method: "PATCH",
      body: JSON.stringify({ status, finished: true }),
    }),
  addCampaignTasks: (
    campaignId: string,
    tasks: {
      testCaseId?: string;
      localRunId?: string;
      status: string;
      error?: string;
      sortOrder?: number;
    }[]
  ) =>
    authFetch<{ tasks: import("./types").GenerationTaskAudit[] }>(
      `/campaigns/${campaignId}/tasks`,
      { method: "POST", body: JSON.stringify({ tasks }) }
    ),
  listCampaigns: (
    projectId: string,
    page = 1,
    pageSize = 30,
    opts?: { kind?: string }
  ) =>
    authFetch<Paged<import("./types").GenerationCampaignAudit>>(
      `/campaigns${qs({ projectId, page, pageSize, kind: opts?.kind })}`
    ),
};

export const executions = {
  list: (projectId: string, page = 1, pageSize = 50) =>
    authFetch<Paged<Execution>>(`/executions${qs({ projectId, page, pageSize })}`),
  create: (body: Record<string, unknown>) =>
    authFetch<Execution>("/executions", { method: "POST", body: JSON.stringify(body) }),
};

export type JourneyStatusDto = {
  projectId: string;
  projectName: string;
  aiReady: boolean;
  requirementCount: number;
  testCaseTotal: number;
  draftCount: number;
  approvedCount: number;
  specDone: boolean;
  genTcDone: boolean;
  reviewDone: boolean;
  currentStep: string;
  nextStep: string;
  nextLabel: string;
  nextPath: string;
  /** null when client did not send both paths */
  rootsAligned?: boolean | null;
};

export const journey = {
  status: (
    projectId: string,
    opts?: { ideRoot?: string | null; localPath?: string | null }
  ) => {
    const q = new URLSearchParams();
    if (opts?.ideRoot) q.set("ide_root", opts.ideRoot);
    if (opts?.localPath) q.set("local_path", opts.localPath);
    const qs = q.toString();
    return authFetch<JourneyStatusDto>(
      `/projects/${projectId}/journey-status${qs ? `?${qs}` : ""}`
    );
  },
};

export const coverageBoard = {
  get: (
    projectId: string,
    opts?: {
      page?: number;
      pageSize?: number;
      module?: string;
      hasLocalPath?: boolean;
    }
  ) => {
    const page = opts?.page ?? 1;
    const pageSize = opts?.pageSize ?? 50;
    return authFetch<import("../features/coverage/model/coverageTypes").CoverageBoard>(
      `/projects/${projectId}/coverage-board${qs({
        page,
        pageSize,
        module: opts?.module,
        hasLocalPath: opts?.hasLocalPath ? "true" : "false",
      })}`
    );
  },
};

export const reporting = {
  listCoverage: (projectId: string, page = 1, pageSize = 20) =>
    authFetch<
      Paged<{
        id: string;
        format: string;
        linePct: number;
        branchPct?: number | null;
        fileName?: string | null;
        uploadedAt?: string | null;
      }>
    >(`/projects/${projectId}/coverage${qs({ page, pageSize })}`),
  uploadCoverage: (
    projectId: string,
    body: {
      format?: string;
      content?: string;
      summary?: Record<string, unknown>;
      fileName?: string;
      executionId?: string;
    }
  ) =>
    authFetch<{ id: string; linePct: number }>(`/projects/${projectId}/coverage`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  /** Step 4 — quét coverage/junit trên disk → PostgreSQL */
  syncCoverageFromDisk: (
    projectId: string,
    body: {
      projectRoot: string;
      packagePrefix?: string;
      packageName?: string;
      localRunId?: string;
      testCaseId?: string;
      module?: string;
      createReport?: boolean;
    }
  ) =>
    authFetch<{
      uploaded: number;
      uploads?: Array<{
        id: string;
        format: string;
        linePct: number;
        branchPct?: number | null;
        fileName?: string;
        kind?: string;
      }>;
      coverage?: {
        linePct?: number;
        branchPct?: number | null;
        format?: string;
      } | null;
      junit?: {
        tests?: number;
        passed?: number;
        failed?: number;
        format?: string;
      } | null;
      reportId?: string | null;
      candidatesChecked?: number;
      packageName?: string | null;
    }>(`/projects/${projectId}/coverage/sync-from-disk`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
  listReports: (projectId: string, page = 1, pageSize = 20) =>
    authFetch<Paged<{ id: string; title: string; format: string; createdAt?: string }>>(
      `/projects/${projectId}/reports${qs({ page, pageSize })}`
    ),
  createReport: (projectId: string, body: { title: string; format?: string; meta?: unknown }) =>
    authFetch<{ id: string }>(`/projects/${projectId}/reports`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};

/** Requirement Studio: upload FileRef + Knowledge */
export const requirementStudio = {
  listWorkspaces: (projectId: string) =>
    authFetch<{ items: import("./types").RequirementStudioWorkspace[] }>(
      `/projects/${projectId}/requirement-workspaces`
    ),
  ensureWorkspace: (projectId: string) =>
    authFetch<import("./types").RequirementStudioWorkspace>(
      `/projects/${projectId}/requirement-workspaces/ensure`,
      { method: "POST", body: "{}" }
    ),
  createWorkspace: (projectId: string, title?: string) =>
    authFetch<import("./types").RequirementStudioWorkspace>(
      `/projects/${projectId}/requirement-workspaces`,
      { method: "POST", body: JSON.stringify({ title: title ?? null }) }
    ),
  getWorkspace: (workspaceId: string) =>
    authFetch<import("./types").RequirementStudioWorkspace>(
      `/requirement-workspaces/${workspaceId}`
    ),
  updateWorkspace: (workspaceId: string, body: { title: string }) =>
    authFetch<import("./types").RequirementStudioWorkspace>(
      `/requirement-workspaces/${workspaceId}`,
      { method: "PUT", body: JSON.stringify(body) }
    ),
  deleteWorkspace: (workspaceId: string) =>
    authFetch<{
      status: string;
      id: string;
      deletedTestCases: number;
      deletedJobs: number;
      deletedSnapshots: number;
      deletedChatMessages: number;
      deletedChatSessions: number;
      deletedFiles: number;
      deletedKnowledge: number;
    }>(`/requirement-workspaces/${workspaceId}`, { method: "DELETE" }),
  listFiles: (workspaceId: string) =>
    authFetch<{ items: import("./types").RequirementFileRef[] }>(
      `/requirement-workspaces/${workspaceId}/files`
    ),
  uploadFiles: (workspaceId: string, files: File[]) => {
    const form = new FormData();
    for (const f of files) form.append("files", f);
    return authUpload<{ items: import("./types").RequirementFileRef[] }>(
      `/requirement-workspaces/${workspaceId}/files`,
      form
    );
  },
  getFile: (fileId: string) =>
    authFetch<import("./types").RequirementFileRef>(`/requirement-files/${fileId}`),
  deleteFile: (fileId: string) =>
    authFetch<{ status: string; id: string }>(`/requirement-files/${fileId}`, {
      method: "DELETE",
    }),
  getKnowledge: (workspaceId: string) =>
    authFetch<import("./types").KnowledgeWorkspaceView>(
      `/requirement-workspaces/${workspaceId}/knowledge`
    ),
  buildKnowledge: (workspaceId: string, useLlm = true) =>
    authFetch<import("./types").KnowledgeWorkspaceView>(
      `/requirement-workspaces/${workspaceId}/knowledge/build`,
      { method: "POST", body: JSON.stringify({ useLlm }) }
    ),
  listSnapshots: (workspaceId: string) =>
    authFetch<{ items: import("./types").RequirementSnapshot[] }>(
      `/requirement-workspaces/${workspaceId}/snapshots`
    ),
  getSnapshot: (snapshotId: string) =>
    authFetch<import("./types").RequirementSnapshot>(
      `/requirement-snapshots/${snapshotId}`
    ),
  freeze: (
    workspaceId: string,
    opts?: { acknowledgeMissing?: boolean; note?: string }
  ) =>
    authFetch<import("./types").FreezeResult>(
      `/requirement-workspaces/${workspaceId}/freeze`,
      {
        method: "POST",
        body: JSON.stringify({
          acknowledgeMissing: opts?.acknowledgeMissing ?? false,
          note: opts?.note ?? null,
        }),
      }
    ),
  generateTcFromSnapshot: (
    snapshotId: string,
    opts?: {
      mode?: "append" | "replace";
      preferredEngine?: "unit" | "e2e";
      targetUrl?: string;
      authHint?: string;
      focusModules?: string;
      speed?: "fast" | "full";
      maxPerModule?: number;
    }
  ) =>
    authFetch<{
      job: import("./types").Job;
      snapshotId: string;
      knowledgeVersion: number;
    }>(`/requirement-snapshots/${snapshotId}/generate-tc`, {
      method: "POST",
      body: JSON.stringify({
        mode: opts?.mode ?? "append",
        preferredEngine: opts?.preferredEngine,
        targetUrl: opts?.targetUrl,
        authHint: opts?.authHint,
        focusModules: opts?.focusModules,
        speed: opts?.speed,
        maxPerModule: opts?.maxPerModule,
      }),
    }),
  freezeAndGenerate: (
    workspaceId: string,
    opts?: {
      acknowledgeMissing?: boolean;
      note?: string;
      mode?: "append" | "replace";
      preferredEngine?: "unit" | "e2e";
      targetUrl?: string;
      authHint?: string;
      focusModules?: string;
      speed?: "fast" | "full";
      maxPerModule?: number;
    }
  ) =>
    authFetch<import("./types").FreezeAndGenerateResult>(
      `/requirement-workspaces/${workspaceId}/freeze-and-generate`,
      {
        method: "POST",
        body: JSON.stringify({
          acknowledgeMissing: opts?.acknowledgeMissing ?? false,
          note: opts?.note ?? null,
          mode: opts?.mode ?? "append",
          preferredEngine: opts?.preferredEngine,
          targetUrl: opts?.targetUrl,
          authHint: opts?.authHint,
          focusModules: opts?.focusModules,
          speed: opts?.speed,
          maxPerModule: opts?.maxPerModule,
        }),
      }
    ),
};

export const generateIntegration = {
  create: (body: Record<string, unknown>) =>
    authFetch<UnitResult>("/generate-integration-test", {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
