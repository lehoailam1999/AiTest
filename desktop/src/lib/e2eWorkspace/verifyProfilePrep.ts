/**
 * Sprint 1 — merge project profile into Verify/Inspect session.
 */
import type { E2EFileDto } from "../../api";
import {
  applyStorageStateToVerifyFiles,
  formatVerifyProfileLog,
  resolveProfileForVerify,
  resolveVerifyStorageStateRel,
  type VerifyProfileContext,
} from "../projectProfile/resolveForVerify.js";
import { buildE2EEnvWithProfile, type BuildE2EEnvInput } from "./env.js";
import type { E2EEnvConfig } from "./types.js";

export type PrepareVerifySessionInput = BuildE2EEnvInput & {
  projectRoot: string;
  files: E2EFileDto[];
};

export type PrepareVerifySessionResult = {
  env: E2EEnvConfig;
  files: E2EFileDto[];
  profileCtx: VerifyProfileContext;
  profileLog: string;
  preflightError?: string;
};

export async function prepareVerifySession(
  input: PrepareVerifySessionInput
): Promise<PrepareVerifySessionResult> {
  const profileCtx = await resolveProfileForVerify(input.projectRoot, {
    targetUrl: input.targetUrl,
    useStorageState: input.useStorageState,
    storageStateRel: input.storageStateRel,
    username: input.username,
    password: input.password,
    files: input.files,
  });

  const profileLog = formatVerifyProfileLog(profileCtx);

  if (profileCtx.preflightErrors.length) {
    const env = buildE2EEnvWithProfile(profileCtx.profile, {
      ...input,
      storageStateRel: resolveVerifyStorageStateRel(profileCtx, input.storageStateRel),
    });
    return {
      env,
      files: input.files,
      profileCtx,
      profileLog,
      preflightError: profileCtx.preflightErrors.join("; "),
    };
  }

  const files = applyStorageStateToVerifyFiles(input.files, profileCtx);
  const useUiLogin = profileCtx.authStrategy === "uiLogin";
  const storageStateRel = useUiLogin
    ? undefined
    : resolveVerifyStorageStateRel(profileCtx, input.storageStateRel);
  const env = buildE2EEnvWithProfile(profileCtx.profile, {
    ...input,
    username: input.username || profileCtx.resolvedUsername,
    password: input.password || profileCtx.resolvedPassword,
    storageStateRel,
    useStorageState: useUiLogin
      ? false
      : input.useStorageState ||
        profileCtx.authStrategy === "storageState" ||
        Boolean(storageStateRel),
  });

  return { env, files, profileCtx, profileLog };
}
