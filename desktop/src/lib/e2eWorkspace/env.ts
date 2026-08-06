/**
 * E3 — resolve storageState + seed/teardown for Playwright E2E env.
 *
 * storageState path MUST be relative to the TC folder (playwright.config.ts cwd),
 * not the module AItest/... tree — otherwise Verify nests
 * `{TC}/AItest/E2ETest/{Module}/fixtures/storageState.json` → ENOENT.
 */

import { defaultE2EEnv, type E2EEnvConfig } from "./types";
import type { ProjectProfile } from "../projectProfile/types.js";

/** Canonical path relative to playwright.config.ts / TC work_cwd. */
export const E2E_STORAGE_STATE_REL = "./fixtures/storageState.json";

export type RoleCredential = { username: string; password: string };

export type BuildE2EEnvInput = {
  targetUrl?: string;
  module?: string | null;
  packagePrefix?: string | null;
  /** If true, set default fixtures/storageState.json path. */
  useStorageState?: boolean;
  storageStateRel?: string;
  seedCommand?: string;
  teardownCommand?: string;
  username?: string;
  password?: string;
  /** WHO role from TC authRole → E2E_ROLE */
  role?: string;
  /** Feature entry path → E2E_FEATURE_PATH (Phase 1) */
  featurePath?: string;
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, RoleCredential>;
  /** From project profile playwrightRun.testIdAttribute */
  testIdAttribute?: string;
};

function roleEnvSlug(role: string): string {
  const s = (role || "default")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return s || "DEFAULT";
}

/**
 * Normalize storageState for Playwright TC cwd.
 * Discovered AItest/... paths must not nest under TC folder — map to ./fixtures/...
 * (API resolve_storage_state_abs still finds the real artifact).
 */
export function normalizeE2eStorageStateRel(
  storageStateRel: string | null | undefined,
  useStorageState?: boolean
): string | undefined {
  const explicit = (storageStateRel || "").trim().replace(/\\/g, "/");
  const looksModuleNested =
    !!explicit &&
    /(?:^|\/)AItest\//i.test(explicit) &&
    !explicit.startsWith("./fixtures/");
  if (explicit && !looksModuleNested) return explicit;
  if (useStorageState || looksModuleNested) return E2E_STORAGE_STATE_REL;
  return undefined;
}

export function buildE2EEnvConfig(input: BuildE2EEnvInput): E2EEnvConfig {
  const storage = normalizeE2eStorageStateRel(
    input.storageStateRel,
    input.useStorageState
  );

  return defaultE2EEnv({
    targetUrl: input.targetUrl,
    storageStateRel: storage,
    seedCommand: input.seedCommand,
    teardownCommand: input.teardownCommand,
    username: input.username,
    password: input.password,
    role: input.role,
    featurePath: input.featurePath,
    roleCredentials: input.roleCredentials,
    testIdAttribute: input.testIdAttribute,
  });
}

/**
 * Merge project profile (Sprint 1) with UI/TC inputs — profile fills gaps only.
 */
export function buildE2EEnvWithProfile(
  profile: ProjectProfile | null | undefined,
  input: BuildE2EEnvInput
): E2EEnvConfig {
  const pw = profile?.playwrightRun;
  const authStrategy = profile?.auth?.strategy;
  const useStorage =
    input.useStorageState === true ||
    (input.useStorageState !== false && authStrategy === "storageState") ||
    Boolean(input.storageStateRel?.trim());

  const targetUrl =
    (input.targetUrl || "").trim() ||
    pw?.defaultBaseURL ||
    undefined;

  const storageStateRel =
    input.storageStateRel?.trim() ||
    pw?.storageState?.canonicalRel ||
    undefined;

  return buildE2EEnvConfig({
    ...input,
    targetUrl,
    useStorageState: useStorage,
    storageStateRel,
    seedCommand: input.seedCommand || pw?.seed?.seedCommand || undefined,
    teardownCommand: input.teardownCommand || pw?.seed?.teardownCommand || undefined,
    testIdAttribute: pw?.testIdAttribute || input.testIdAttribute,
  });
}

/** Env vars Desktop injects into Playwright via API (not written into SUT source). */
export function playwrightEnvFromConfig(env: E2EEnvConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.targetUrl) out.E2E_BASE_URL = env.targetUrl;
  if (env.storageStateRel) out.E2E_STORAGE_STATE = env.storageStateRel;
  if (env.username) out.E2E_USERNAME = env.username;
  if (env.password) out.E2E_PASSWORD = env.password;
  if (env.role) out.E2E_ROLE = env.role;
  if (env.featurePath) out.E2E_FEATURE_PATH = env.featurePath;
  if (env.testIdAttribute) out.E2E_TEST_ID_ATTRIBUTE = env.testIdAttribute;
  const roles = env.roleCredentials || {};
  for (const [role, cred] of Object.entries(roles)) {
    const u = (cred?.username || "").trim();
    const p = (cred?.password || "").trim();
    if (!u || !p) continue;
    const slug = roleEnvSlug(role);
    out[`E2E_${slug}_USERNAME`] = u;
    out[`E2E_${slug}_PASSWORD`] = p;
  }
  return out;
}
