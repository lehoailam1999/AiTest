/**
 * E3 — resolve storageState + seed/teardown for Playwright E2E env.
 *
 * storageState path MUST be relative to the TC folder (playwright.config.ts cwd),
 * not the module AItest/... tree — otherwise Verify nests
 * `{TC}/AItest/E2ETest/{Module}/fixtures/storageState.json` → ENOENT.
 */

import { defaultE2EEnv, type E2EEnvConfig } from "./types";

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
};

function roleEnvSlug(role: string): string {
  const s = (role || "default")
    .trim()
    .replace(/[^a-zA-Z0-9]+/g, "_")
    .toUpperCase();
  return s || "DEFAULT";
}

export function buildE2EEnvConfig(input: BuildE2EEnvInput): E2EEnvConfig {
  const explicit = input.storageStateRel?.trim();
  // Prefer explicit only when already TC-relative (./fixtures/... or fixtures/...).
  // Module-level AItest/... paths from older Desktop builds nest under TC cwd — ignore.
  const looksModuleNested =
    !!explicit &&
    /(?:^|\/)AItest\//i.test(explicit.replace(/\\/g, "/")) &&
    !explicit.replace(/\\/g, "/").startsWith("./fixtures/");

  const storage =
    explicit && !looksModuleNested
      ? explicit
      : input.useStorageState
        ? E2E_STORAGE_STATE_REL
        : undefined;

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
