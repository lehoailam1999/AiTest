/**
 * E3 — resolve storageState + seed/teardown for Playwright E2E env.
 */
import { e2eStorageStateRel } from "../testOutputLayout";
import { defaultE2EEnv, type E2EEnvConfig } from "./types";

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
};

export function buildE2EEnvConfig(input: BuildE2EEnvInput): E2EEnvConfig {
  const storage =
    input.storageStateRel?.trim() ||
    (input.useStorageState
      ? e2eStorageStateRel(input.module, { packagePrefix: input.packagePrefix })
      : undefined);
  return defaultE2EEnv({
    targetUrl: input.targetUrl,
    storageStateRel: storage,
    seedCommand: input.seedCommand,
    teardownCommand: input.teardownCommand,
    username: input.username,
    password: input.password,
  });
}

/** Env vars Desktop injects into Playwright via API (not written into SUT source). */
export function playwrightEnvFromConfig(env: E2EEnvConfig): Record<string, string> {
  const out: Record<string, string> = {};
  if (env.targetUrl) out.E2E_BASE_URL = env.targetUrl;
  if (env.storageStateRel) out.E2E_STORAGE_STATE = env.storageStateRel;
  if (env.username) out.E2E_USERNAME = env.username;
  if (env.password) out.E2E_PASSWORD = env.password;
  return out;
}
