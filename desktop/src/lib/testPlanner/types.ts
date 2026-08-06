/** Phase 2 — Test Planner shapes (Desktop + mirror API). */

export type PlannerTestType = "Unit" | "Integration" | "E2E" | "API";

export type TestPlanHints = {
  /** Unit/API test runner hint when known */
  framework?: "jest" | "vitest" | "pytest" | "xunit" | "nunit" | "mstest" | "junit" | string;
  /** E2E stack */
  e2eStack?: "playwright" | "cypress" | string;
  /** Route path from TC (`path: /orders`) when present */
  featurePath?: string;
  /** Confidence 0–1 for testType decision */
  confidence?: number;
  /** Why this type was chosen (debug / UI) */
  reasons?: string[];
};

export type TestPlan = {
  testType: PlannerTestType;
  module: string;
  action: string;
  keywords: string[];
  hints: TestPlanHints;
};

/** Minimal TC fields the planner needs (matches desktop TestCase). */
export type PlannerTestCaseInput = {
  title?: string | null;
  type?: string | null;
  module?: string | null;
  precondition?: string | null;
  steps?: string | null;
  expectedResult?: string | null;
  testData?: string | null;
  testCaseId?: string | null;
};

export type PlannerRequirementInput = {
  title?: string | null;
  summary?: string | null;
  /** Feature / module names from Knowledge or freeze */
  featureNames?: string[];
  /** Optional language / stack from project meta */
  language?: string | null;
  frameworks?: string[];
};

export type AnalyzeIntentResult = {
  testType: PlannerTestType;
  confidence: number;
  reasons: string[];
  featurePath?: string;
  keywords: string[];
  actionHint?: string;
};
