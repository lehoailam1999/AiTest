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

};



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

  return out;

}


