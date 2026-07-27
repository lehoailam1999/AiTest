/**
 * Parse structured test counts from Verify stage logs (Jest / Vitest / pytest / dotnet).
 */
import type { VerifyStageResult } from "./types";

export type TestRunSummary = {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  failedNames: string[];
  runnerLabel: string;
  /** True when at least one count was parsed from log or stage metadata */
  hasCounts: boolean;
};

function runnerLabelFrom(framework?: string | null, command?: string): string {
  const fw = (framework || "").toLowerCase();
  const cmd = (command || "").toLowerCase();
  if (fw.includes("vitest") || cmd.includes("vitest")) return "Vitest";
  if (fw.includes("pytest") || cmd.includes("pytest")) return "pytest";
  if (fw.includes("xunit") || fw.includes("nunit") || cmd.includes("dotnet test")) return ".NET";
  if (fw.includes("go") || cmd.includes("go test")) return "Go";
  if (fw.includes("jest") || cmd.includes("jest")) return "Jest";
  if (cmd.includes("npm test")) return "npm test";
  return fw || "Test";
}

function parseFailedNames(log: string): string[] {
  const names: string[] = [];
  const patterns = [
    /^\s*[×x✕]\s+(.+?)\s*(?:\(\d+\s*ms\))?$/gim,
    /^\s*FAIL\s+(.+)$/gim,
    /^\s*\d+\)\s+(.+)$/gm,
    /FAILED\s+([\w./\\:-]+::[\w\[\].-]+)/g,
    /Failed:\s+(.+)$/gim,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    const r = new RegExp(re.source, re.flags);
    while ((m = r.exec(log)) !== null) {
      const n = (m[1] || "").trim();
      if (n && n.length < 200 && !names.includes(n)) names.push(n);
      if (names.length >= 12) return names;
    }
  }
  return names;
}

function parseCountsFromLog(log: string): {
  passed: number;
  failed: number;
  skipped: number;
  total: number;
} | null {
  if (!log) return null;

  // Jest: Tests: 1 failed, 2 passed, 3 total
  let m = log.match(
    /Tests:\s*(?:(\d+)\s*failed,?\s*)?(?:(\d+)\s*skipped,?\s*)?(?:(\d+)\s*passed,?\s*)?(?:(\d+)\s*total)?/i
  );
  if (m && (m[1] || m[2] || m[3] || m[4])) {
    const failed = Number(m[1] || 0);
    const skipped = Number(m[2] || 0);
    const passed = Number(m[3] || 0);
    const total = Number(m[4] || passed + failed + skipped);
    return { passed, failed, skipped, total };
  }

  // Vitest: Tests  2 passed | 1 failed
  m = log.match(
    /Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+failed)?(?:\s*\|\s*(\d+)\s+skipped)?/i
  );
  if (m) {
    const passed = Number(m[1] || 0);
    const failed = Number(m[2] || 0);
    const skipped = Number(m[3] || 0);
    return { passed, failed, skipped, total: passed + failed + skipped };
  }

  // pytest: 2 passed, 1 failed, 1 skipped in 1.23s
  m = log.match(
    /(\d+)\s+passed(?:,\s*(\d+)\s+failed)?(?:,\s*(\d+)\s+skipped)?(?:(?:,\s*(\d+)\s+error))?/i
  );
  if (m && /passed|failed|skipped/i.test(log)) {
    const passed = Number(m[1] || 0);
    const failed = Number(m[2] || 0) + Number(m[4] || 0);
    const skipped = Number(m[3] || 0);
    return { passed, failed, skipped, total: passed + failed + skipped };
  }

  // dotnet: Passed: 5, Failed: 0, Skipped: 0, Total: 5
  m = log.match(
    /Failed:\s*(\d+).*?Passed:\s*(\d+).*?(?:Skipped:\s*(\d+).*?)?Total:\s*(\d+)/is
  );
  if (m) {
    return {
      failed: Number(m[1] || 0),
      passed: Number(m[2] || 0),
      skipped: Number(m[3] || 0),
      total: Number(m[4] || 0),
    };
  }

  // Go: ok / FAIL package
  const goFail = (log.match(/^FAIL\t/gm) || []).length;
  const goOk = (log.match(/^ok\t/gm) || []).length;
  if (goFail + goOk > 0) {
    return {
      passed: goOk,
      failed: goFail,
      skipped: 0,
      total: goOk + goFail,
    };
  }

  return null;
}

export function parseTestRunSummary(opts: {
  stages?: VerifyStageResult[] | null;
  framework?: string | null;
  language?: string | null;
}): TestRunSummary {
  const stages = opts.stages || [];
  const testStage = [...stages].reverse().find((s) => s.stage === "test") || stages[stages.length - 1];
  const log = testStage?.logExcerpt || "";
  const fromLog = parseCountsFromLog(log);
  const durationMs =
    stages.reduce((acc, s) => acc + (s.durationMs || 0), 0) || testStage?.durationMs || 0;

  const junitish = stages.length
    ? null
    : null;

  void junitish;

  if (fromLog) {
    return {
      ...fromLog,
      durationMs,
      failedNames: fromLog.failed > 0 ? parseFailedNames(log) : [],
      runnerLabel: runnerLabelFrom(opts.framework, testStage?.command),
      hasCounts: true,
    };
  }

  // Fallback: success → treat as opaque pass/fail without counts
  const success = testStage ? testStage.success : false;
  return {
    passed: success ? 1 : 0,
    failed: success ? 0 : 1,
    skipped: 0,
    total: 1,
    durationMs,
    failedNames: success ? [] : parseFailedNames(log).slice(0, 8),
    runnerLabel: runnerLabelFrom(opts.framework, testStage?.command),
    hasCounts: false,
  };
}

export function formatDurationMs(ms: number): string {
  if (!ms || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
