/**
 * Orchestrate retrieve by TestPlan.testType.
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";
import type { PlannerTestCaseInput, TestPlan } from "../testPlanner/types";
import { retrieveBusinessContext, type BusinessRetrieveOptions } from "./businessRetriever";
import { retrieveE2eSources } from "./e2eRetriever";
import { retrieveUnitSources } from "./unitRetriever";
import type {
  BusinessRetrieveResult,
  RetrieveFilesResult,
  RetrieveOptions,
} from "./types";

export type RetrieveForPlanResult = {
  files: RetrieveFilesResult;
  business: BusinessRetrieveResult;
};

/**
 * Pick Unit vs E2E (vs API≈unit-shaped) retriever from plan; always attach TC-first business.
 */
export function retrieveForPlan(
  snapshot: CodeIndexSnapshot,
  plan: TestPlan,
  tc: PlannerTestCaseInput,
  opts?: RetrieveOptions & { business?: BusinessRetrieveOptions }
): RetrieveForPlanResult {
  let files: RetrieveFilesResult;
  if (plan.testType === "E2E") {
    files = retrieveE2eSources(snapshot, plan, opts);
  } else {
    // Unit, Integration, API → code index unit-style for now
    files = retrieveUnitSources(snapshot, plan, opts);
  }
  const business = retrieveBusinessContext(plan, tc, opts?.business);
  return { files, business };
}
