/**
 * Build TestPlan from Test Case (+ optional Requirement / Knowledge slice).
 * Phase 2 entry — Desktop gen Unit/E2E should call this before retrieve.
 */
import { analyzeIntent } from "./analyzeIntent";
import type {
  PlannerRequirementInput,
  PlannerTestCaseInput,
  TestPlan,
  TestPlanHints,
} from "./types";

function guessFramework(
  req?: PlannerRequirementInput | null,
  testType?: string
): TestPlanHints["framework"] | undefined {
  const lang = (req?.language || "").toLowerCase();
  const fws = (req?.frameworks || []).map((f) => f.toLowerCase());
  if (fws.some((f) => f.includes("vitest"))) return "vitest";
  if (fws.some((f) => f.includes("jest"))) return "jest";
  if (fws.some((f) => f.includes("pytest")) || lang.includes("python")) return "pytest";
  if (fws.some((f) => f.includes("xunit"))) return "xunit";
  if (fws.some((f) => f.includes("nunit"))) return "nunit";
  if (fws.some((f) => f.includes("mstest"))) return "mstest";
  if (fws.some((f) => f.includes("junit")) || lang.includes("java")) return "junit";
  if (testType === "E2E") return undefined;
  if (lang.includes("typescript") || lang.includes("javascript")) return "jest";
  return undefined;
}

export type PlanFromTestCaseOptions = {
  requirement?: PlannerRequirementInput | null;
  /** Override / force type (e.g. user chose Unit page) */
  forceTestType?: TestPlan["testType"];
};

export function planFromTestCase(
  tc: PlannerTestCaseInput,
  opts?: PlanFromTestCaseOptions
): TestPlan {
  const intent = analyzeIntent(tc, opts?.requirement);
  const testType = opts?.forceTestType || intent.testType;
  const module =
    (tc.module || "").trim() ||
    opts?.requirement?.featureNames?.[0]?.trim() ||
    intent.keywords[0] ||
    "Default";

  const hints: TestPlanHints = {
    confidence: intent.confidence,
    reasons: intent.reasons,
    featurePath: intent.featurePath,
    framework: guessFramework(opts?.requirement, testType),
    e2eStack: testType === "E2E" ? "playwright" : undefined,
  };

  return {
    testType,
    module,
    action: intent.actionHint || "Execute",
    keywords: intent.keywords,
    hints,
  };
}
