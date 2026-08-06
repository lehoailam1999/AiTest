/**
 * Phase 3 — Retrieval Engine.
 *
 * Flow: TestPlan (Phase 2) + CodeIndex (Phase 1) → Top-K files
 *        + BusinessRetriever (TC-first; Knowledge optional)
 *
 *   const plan = planFromTestCase(tc);
 *   const { files, business } = retrieveForPlan(snapshot, plan, tc);
 */
export type {
  BusinessRetrieveResult,
  BusinessSnippet,
  KnowledgeSliceInput,
  RankedFileHit,
  RetrieveFilesResult,
  RetrieveOptions,
} from "./types";
export {
  clampTopK,
  e2ePathBonus,
  featurePathTokenBonus,
  isExcludedFromUnitRetrieve,
  isExcludedFromE2eRetrieve,
  isUnsuitableUnitPrimary,
  isUnsuitableE2ePrimary,
  normalizeKeywords,
  pathKeywordScore,
  symbolKeywordScore,
  unitPathBonus,
} from "./rankScore";
export { retrieveUnitSources } from "./unitRetriever";
export { retrieveE2eSources } from "./e2eRetriever";
export { retrieveBusinessContext } from "./businessRetriever";
export type { BusinessRetrieveOptions } from "./businessRetriever";
export { retrieveForPlan } from "./retrieveForPlan";
export type { RetrieveForPlanResult } from "./retrieveForPlan";
