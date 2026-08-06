/**
 * Phase 2 — Test Planner.
 *
 * From Requirement + Test Case → testType / module / action / keywords for retrieve.
 *
 *   import { planFromTestCase } from "./lib/testPlanner";
 *   const plan = planFromTestCase(tc, { requirement: { title, featureNames } });
 */
export type {
  AnalyzeIntentResult,
  PlannerRequirementInput,
  PlannerTestCaseInput,
  PlannerTestType,
  TestPlan,
  TestPlanHints,
} from "./types";
export { analyzeIntent, extractFeaturePath } from "./analyzeIntent";
export { planFromTestCase } from "./planFromTestCase";
export type { PlanFromTestCaseOptions } from "./planFromTestCase";
