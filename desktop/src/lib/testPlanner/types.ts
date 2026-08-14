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

/** Phase 1 Implementation Planner — TC → entry + multi-layer deps (Desktop). */
export type UnitPlanLayerKind =
  | "handler"
  | "service"
  | "controller"
  | "usecase"
  | "other";

export type UnitPlanLayerRole =
  | "entry"
  | "dependency"
  | "contract"
  | "test_fixture";

export type UnitPlanEntry = {
  pathRel: string;
  symbol?: string;
  methodHints: string[];
  layer: UnitPlanLayerKind;
};

export type UnitPlanLayer = {
  pathRel: string;
  role: UnitPlanLayerRole;
  reason: string;
};

export type UnitImplementationPlanStatus =
  | "ready"
  | "needs_marker"
  | "misaligned_marker"
  | "unresolved";

export type UnitImplementationPlan = {
  entry: UnitPlanEntry | null;
  layers: UnitPlanLayer[];
  mocks: string[];
  existingTests: string[];
  framework?: string;
  confidence: number;
  markers: { paths: string[]; codes: string[] };
  status: UnitImplementationPlanStatus;
  notes: string[];
  /** Intent plan used as input */
  intent: TestPlan;
};
