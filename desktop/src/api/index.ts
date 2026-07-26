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
    body: { provider: string; modelName?: string; baseUrl?: string; apiKey?: string }
  ) =>
    authFetch<Connection>(`/projects/${projectId}/connection`, {
      method: "PUT",
      body: JSON.stringify(body),
    }),
  verify: (projectId: string) =>
    authFetch<Connection>(`/projects/${projectId}/connection/verify`, {
      method: "POST",
    }),
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
  }) => authFetch<UnitResult>("/generate-unit", { method: "POST", body: JSON.stringify(body) }),
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
  }) =>
    authFetch<UnitResult>("/generate-api-test", { method: "POST", body: JSON.stringify(body) }),
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
  listWorkspaceRuns: (projectId: string, page = 1, pageSize = 50) =>
    authFetch<Paged<import("./types").WorkspaceRunAudit>>(
      `/audit/workspace-runs${qs({ projectId, page, pageSize })}`
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
  listCampaigns: (projectId: string, page = 1, pageSize = 30) =>
    authFetch<Paged<import("./types").GenerationCampaignAudit>>(
      `/campaigns${qs({ projectId, page, pageSize })}`
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

/** R1–R2 — Requirement Studio: upload FileRef + DocumentChunk */
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
  rechunkWorkspace: (workspaceId: string) =>
    authFetch<{ filesUpdated: number; chunkCount: number }>(
      `/requirement-workspaces/${workspaceId}/rechunk`,
      { method: "POST", body: "{}" }
    ),
  getFile: (fileId: string) =>
    authFetch<import("./types").RequirementFileRef>(`/requirement-files/${fileId}`),
  listChunks: (fileId: string) =>
    authFetch<{ items: import("./types").DocumentChunk[] }>(
      `/requirement-files/${fileId}/chunks`
    ),
  rechunkFile: (fileId: string) =>
    authFetch<import("./types").RequirementFileRef>(`/requirement-files/${fileId}/rechunk`, {
      method: "POST",
      body: "{}",
    }),
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
  generateTcFromSnapshot: (snapshotId: string, mode: "append" | "replace" = "append") =>
    authFetch<{
      job: import("./types").Job;
      snapshotId: string;
      knowledgeVersion: number;
    }>(`/requirement-snapshots/${snapshotId}/generate-tc`, {
      method: "POST",
      body: JSON.stringify({ mode }),
    }),
  freezeAndGenerate: (
    workspaceId: string,
    opts?: {
      acknowledgeMissing?: boolean;
      note?: string;
      mode?: "append" | "replace";
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
