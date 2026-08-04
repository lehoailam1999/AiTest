/**
 * Run Center presets — regression on Applied AItest outputs only.
 * Does NOT touch Generate / Verify / Apply pipelines.
 */
import type { Project } from "../api/types";
import { suggestWorkspaceVerifyCommands } from "../stackHints";
import { buildAitestDotnetTestCommand } from "../unitWorkspace/ensureAitestDotnet";
import { AITEST_ROOT, GENERATED_TEST_FOLDERS } from "../testOutputLayout";

export type RunLane = "unit" | "e2e" | "advanced";

export function e2eSuiteRel(packagePrefix?: string | null): string {
  const pkg = (packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
  const suite = `${AITEST_ROOT}/${GENERATED_TEST_FOLDERS.e2e}`;
  return pkg ? `${pkg}/${suite}` : suite;
}

/** Default Playwright regression over Applied E2E suite. */
export function resolveE2eRunCommand(packagePrefix?: string | null): string {
  const suite = e2eSuiteRel(packagePrefix);
  return `npx playwright test "${suite}" --reporter=line`;
}

/**
 * Unit command for Applied AItest — prefer stack verify hint, force AItest.UnitTests for C#.
 */
export function resolveUnitRunCommand(
  project?: Project | null,
  packagePrefix?: string | null
): string {
  if (!project) return "";
  const lang = (project.language || "").toLowerCase();
  const fw = (project.framework || "").toLowerCase();
  const stacks = (project.meta?.stacks ?? []).map((s) => s.toLowerCase());
  const isCsharp =
    lang.includes("c#") ||
    fw.startsWith("net") ||
    stacks.some((s) => s.includes("asp.net") || s.includes(".net"));

  if (isCsharp) {
    return buildAitestDotnetTestCommand(packagePrefix);
  }

  const cmds = suggestWorkspaceVerifyCommands({
    language: project.language,
    framework: project.framework,
    meta: project.meta,
    targetRelPaths: [],
    packagePrefix,
  });
  return (cmds.test || "").trim();
}

/** Heuristic lane from stored Execution.command (for Reports). */
export function classifyExecutionLane(command: string): RunLane {
  const c = (command || "").toLowerCase();
  if (!c.trim()) return "advanced";
  if (
    c.includes("playwright") ||
    c.includes("e2etest") ||
    /\/e2e\b/.test(c) ||
    c.includes("e2e-test")
  ) {
    return "e2e";
  }
  if (
    c.includes("aitest.unittests") ||
    c.includes("aitest/jest") ||
    c.includes("unittest") ||
    c.includes("dotnet test") ||
    c.includes("npx jest") ||
    c.includes("vitest") ||
    c.includes("pytest")
  ) {
    return "unit";
  }
  return "advanced";
}

export function summarizeExecutions(
  items: Array<{ status: string; command: string; passed: number; failed: number; total: number }>
): {
  totalRuns: number;
  passedRuns: number;
  failedRuns: number;
  unitRuns: number;
  e2eRuns: number;
  testsPassed: number;
  testsFailed: number;
  testsTotal: number;
} {
  let passedRuns = 0;
  let failedRuns = 0;
  let unitRuns = 0;
  let e2eRuns = 0;
  let testsPassed = 0;
  let testsFailed = 0;
  let testsTotal = 0;
  for (const e of items) {
    const st = (e.status || "").toLowerCase();
    if (st === "passed") passedRuns += 1;
    else if (st === "failed" || st === "error") failedRuns += 1;
    const lane = classifyExecutionLane(e.command);
    if (lane === "unit") unitRuns += 1;
    else if (lane === "e2e") e2eRuns += 1;
    testsPassed += e.passed || 0;
    testsFailed += e.failed || 0;
    testsTotal += e.total || 0;
  }
  return {
    totalRuns: items.length,
    passedRuns,
    failedRuns,
    unitRuns,
    e2eRuns,
    testsPassed,
    testsFailed,
    testsTotal,
  };
}
