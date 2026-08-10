/**
 * Phase 2 — Test Planner.
 *
 * From Requirement + Test Case → testType / module / action / keywords for retrieve.
 * Phase 1 Implementation Planner: TC → entry + multi-layer deps (fail-closed).
 *
 *   import { planFromTestCase, buildUnitImplementationPlan } from "./lib/testPlanner";
 */
export type {
  AnalyzeIntentResult,
  PlannerRequirementInput,
  PlannerTestCaseInput,
  PlannerTestType,
  TestPlan,
  TestPlanHints,
  UnitImplementationPlan,
  UnitImplementationPlanStatus,
  UnitPlanEntry,
  UnitPlanLayer,
  UnitPlanLayerKind,
  UnitPlanLayerRole,
} from "./types";
export { analyzeIntent, extractFeaturePath } from "./analyzeIntent";
export { planFromTestCase } from "./planFromTestCase";
export type { PlanFromTestCaseOptions } from "./planFromTestCase";
export {
  buildUnitImplementationPlan,
  isWeakClientAppAdmin,
} from "./buildUnitImplementationPlan";
export type { BuildUnitImplementationPlanInput } from "./buildUnitImplementationPlan";
export {
  clearUnitPlanCache,
  getOrBuildUnitImplementationPlan,
  planCacheKey,
  unitPlanCacheSize,
} from "./contextCache";
