/**
 * E2E workspace types — Playwright TS MVP (mirror unitWorkspace, thinner).
 */

export type E2EFileKind = "page" | "spec" | "config" | "fixture";

export type E2EFileEntry = {
  path: string;
  content: string;
  kind: E2EFileKind | string;
};

export type E2EWorkspaceStatus =
  | "draft"
  | "inspected"
  | "generated"
  | "verifying"
  | "pass"
  | "fail"
  | "applied";

export type E2EEnvConfig = {
  targetUrl: string;
  /** Relative path to storageState.json under project (optional). */
  storageStateRel?: string;
  seedCommand?: string;
  teardownCommand?: string;
  /** Injected as E2E_USERNAME for ensureAuthenticated — from AITest UI, not SUT .env */
  username?: string;
  /** Injected as E2E_PASSWORD */
  password?: string;
  /** Injected as E2E_ROLE — from TC authRole / Analysis WHO */
  role?: string;
  /** Injected as E2E_FEATURE_PATH — Feature entry after auth (Phase 1) */
  featurePath?: string;
  /** Injected as E2E_<ROLE>_USERNAME|PASSWORD for multi-actor Specs */
  roleCredentials?: Record<string, { username: string; password: string }>;
};

export type E2EWorkspaceManifest = {
  version: 1;
  runId: string;
  projectId: string;
  testCaseId: string;
  createdAt: string;
  status: E2EWorkspaceStatus;
  files: E2EFileEntry[];
  primarySpecPath?: string;
  env: E2EEnvConfig;
  module?: string;
  packagePrefix?: string;
  autoHealAttempts?: number;
  inspectPromptJson?: string;
  artifactSync?: {
    reportId?: string | null;
    artifactCount?: number;
    artifacts?: { kind: string; path: string; sizeBytes?: number | null }[];
  } | null;
};

export function defaultE2EEnv(partial?: Partial<E2EEnvConfig>): E2EEnvConfig {
  return {
    targetUrl: partial?.targetUrl?.trim() || "http://localhost:3000",
    storageStateRel: partial?.storageStateRel?.trim() || undefined,
    seedCommand: partial?.seedCommand?.trim() || undefined,
    teardownCommand: partial?.teardownCommand?.trim() || undefined,
    username: partial?.username?.trim() || undefined,
    password: partial?.password?.trim() || undefined,
    role: partial?.role?.trim() || undefined,
    featurePath: partial?.featurePath?.trim() || undefined,
    roleCredentials: partial?.roleCredentials,
  };
}
