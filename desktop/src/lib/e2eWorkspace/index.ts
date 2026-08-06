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
export { deriveAuthContextFromTestCase } from "./deriveAuthContextFromTc";
export {
  assertTcReadyForE2eGen,
  enrichTestDataWithFeaturePath,
  hasPathMarker,
  hasTestDataSeed,
  hasActionableStep,
  isUsableFeaturePath,
  mergeTcWithInferredFeaturePath,
} from "./assertTcReadyForE2eGen";
export {
  buildE2eRouteCatalog,
  matchFeaturePathFromCatalog,
} from "./e2eRouteCatalog";
export type { E2eRouteCatalog, RouteMatchResult } from "./e2eRouteCatalog";
export {
  createInspectDomCache,
  inspectCacheKey,
  isLikelyLoginWallDom,
  isLikelyLoginTestCase,
} from "./inspectDomCache";
export type { InspectDomCache, InspectCacheEntry } from "./inspectDomCache";
export { pickDiscoveredStorageStateRel } from "./pickDiscoveredStorageState";
export { resolveE2eFeSources, e2eFeRankBonus, createFeSourceListCache } from "./resolveE2eFeSources";
export type { E2eFeSourceBundle, FeSourceListCache } from "./resolveE2eFeSources";
export {
  classifyE2eFailure,
  aggregateE2eMetrics,
  formatE2eMetricsReport,
  toStandardTaxonomy,
  E2E_FAIL_CATEGORY_LABELS,
} from "./e2eFailureMetrics";
export type {
  E2eFailCategory,
  E2eStandardTaxonomy,
  E2eMetricRow,
  E2eRunMetrics,
} from "./e2eFailureMetrics";
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
  updateE2eStagedFileContent,
  deleteE2eStagedFile,
} from "./stagingApply";
export type { E2eStagingSession, E2eStagedFile, ApplyE2eResult } from "./stagingApply";
