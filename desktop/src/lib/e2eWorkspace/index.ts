export type { E2EEnvConfig, E2EFileEntry, E2EWorkspaceManifest } from "./types";
export { defaultE2EEnv } from "./types";
export { runE2EWithAutoHeal, E2E_AUTO_HEAL_MAX_ATTEMPTS } from "./autoHealLoop";
export { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env";
export {
  syncE2eWorkspaceRun,
  syncE2eVerifyReport,
  syncE2eModuleCampaign,
  syncE2eModuleBatchCampaign,
} from "./auditSync";
export {
  inspectE2eDom,
  generateE2eForTestCase,
  generateE2eBatch,
  verifyE2eModuleBatch,
  verifyE2eForTestCase,
  runE2eJobForTestCase,
  runE2eModuleBatch,
} from "./e2eJobRunner";
export type {
  E2eBatchItemResult,
  E2eGenItem,
  E2eInspectResult,
  E2eBatchProgress,
  E2eGenerateItemDone,
} from "./e2eJobRunner";
export { resolveE2eFeSources } from "./resolveE2eFeSources";
export type { E2eFeSourceBundle } from "./resolveE2eFeSources";
export {
  e2eSpecPathsMatch,
  findSpecReportForPrimary,
  normalizeE2eSpecPath,
} from "./e2eSpecPathMatch";
export {
  newE2eRunId,
  buildE2eStagedFiles,
  writeE2eOverlay,
  writeE2eOverlayReplacingPrevious,
  captureE2eBackups,
  rollbackE2eTargets,
  refreshE2eOverlayFromFiles,
  applyE2eStaging,
  stagingDirHint,
} from "./stagingApply";
export type { E2eStagingSession, E2eStagedFile, ApplyE2eResult } from "./stagingApply";
