/**
 * Phase 6 — Unit verify failure taxonomy + aggregate metrics
 * (mirrors e2eFailureMetrics for Unit auto-repair loops).
 */

export type UnitFailClass =
  | "CompileError"
  | "ImportError"
  | "AssertionFailed"
  | "RuntimeError"
  | "Timeout"
  | "Other";

export const UNIT_FAIL_CLASS_LABELS: Record<UnitFailClass, string> = {
  CompileError: "Compile",
  ImportError: "Import / module",
  AssertionFailed: "Assert",
  RuntimeError: "Runtime",
  Timeout: "Timeout",
  Other: "Khác",
};

/** Phase 6 repair: failing test + Top-K deps */
export const UNIT_REPAIR_TOP_K = 3;
export const UNIT_AUTO_REPAIR_MAX_CAP = 5;

function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

const UNIT_RULES: { cls: UnitFailClass; re: RegExp }[] = [
  {
    cls: "CompileError",
    re: /TS\d{3,5}|error CS\d+|javac?:|cannot find symbol|SyntaxError|Unexpected token|failed to compile|Type error:|error\[E\d+\]/i,
  },
  {
    cls: "ImportError",
    re: /Cannot find module|ERR_MODULE_NOT_FOUND|ModuleNotFoundError|ImportError|Unable to resolve|Could not find a declaration|package .+ does not exist|CS0246/i,
  },
  {
    cls: "Timeout",
    re: /Timeout|timed?\s*out|Jest did not exit|async tests/i,
  },
  {
    cls: "AssertionFailed",
    re: /AssertionError|expect\(|Expected:|toEqual|toBe\(|assert\.|Xunit\.Sdk|NUnit\.Framework\.AssertionException|Failed:\s*/i,
  },
  {
    cls: "RuntimeError",
    re: /TypeError|ReferenceError|NullReferenceException|is not a function|Cannot read propert|Unhandled|RuntimeError/i,
  },
];

export function classifyUnitFailure(
  error: string | null | undefined
): UnitFailClass {
  const text = stripAnsi(error || "").trim();
  if (!text) return "Other";
  for (const { cls, re } of UNIT_RULES) {
    if (re.test(text)) return cls;
  }
  return "Other";
}

export type UnitMetricRow = {
  testCaseId: string;
  title?: string;
  status: "ok" | "fail" | string;
  error?: string;
  failClass?: UnitFailClass;
  attempts?: number;
};

export type UnitRunMetrics = {
  total: number;
  passed: number;
  failed: number;
  passRatePct: number;
  failByClass: Partial<Record<UnitFailClass, number>>;
  failSharePct: Partial<Record<UnitFailClass, number>>;
  rows: Array<UnitMetricRow & { failClass: UnitFailClass | "pass" }>;
  summaryLine: string;
};

export function aggregateUnitMetrics(rows: UnitMetricRow[]): UnitRunMetrics {
  const total = rows.length;
  let passed = 0;
  let failed = 0;
  const failByClass: Partial<Record<UnitFailClass, number>> = {};
  const outRows: UnitRunMetrics["rows"] = [];

  for (const r of rows) {
    const ok = r.status === "ok";
    if (ok) {
      passed += 1;
      outRows.push({ ...r, failClass: "pass" });
      continue;
    }
    failed += 1;
    const cls = r.failClass || classifyUnitFailure(r.error);
    failByClass[cls] = (failByClass[cls] || 0) + 1;
    outRows.push({ ...r, failClass: cls });
  }

  const passRatePct = total === 0 ? 0 : Math.round((passed / total) * 1000) / 10;
  const failSharePct: Partial<Record<UnitFailClass, number>> = {};
  for (const [k, n] of Object.entries(failByClass) as [UnitFailClass, number][]) {
    failSharePct[k] =
      failed === 0 ? 0 : Math.round((n / failed) * 1000) / 10;
  }

  const top = Object.entries(failByClass).sort((a, b) => b[1] - a[1])[0];
  const topHint =
    top && failed > 0
      ? ` · top fail: ${UNIT_FAIL_CLASS_LABELS[top[0] as UnitFailClass]} ${failSharePct[top[0] as UnitFailClass]}%`
      : "";
  const summaryLine = `Phase 6 unit metrics: ${passed}/${total} PASS (${passRatePct}%)${topHint}`;

  return {
    total,
    passed,
    failed,
    passRatePct,
    failByClass,
    failSharePct,
    rows: outRows,
    summaryLine,
  };
}

export function formatUnitMetricsReport(m: UnitRunMetrics): string {
  const lines = [m.summaryLine];
  const cats = Object.entries(m.failByClass).sort((a, b) => b[1] - a[1]) as [
    UnitFailClass,
    number,
  ][];
  for (const [cls, n] of cats) {
    lines.push(
      `  - ${UNIT_FAIL_CLASS_LABELS[cls]}: ${n} · ${m.failSharePct[cls]}% of fails`
    );
  }
  return lines.join("\n");
}

/** Build Phase 6 slim repairContext (+ taxonomy). */
export function buildUnitRepairContext(opts: {
  runId?: string;
  targetRel: string;
  errorLog: string;
  attempt?: number;
  maxAttempts?: number;
}): { repairContext: string; failClass: UnitFailClass } {
  const failClass = classifyUnitFailure(opts.errorLog);
  const attempt = opts.attempt ?? 1;
  const maxAttempts = opts.maxAttempts ?? 3;
  const repairContext = [
    opts.runId ? `Agent Staging run: ${opts.runId}` : null,
    `Target file: ${opts.targetRel}`,
    `Sandbox Auto-Repair attempt ${attempt}/${maxAttempts}`,
    `Failure taxonomy (Phase 6): ${failClass}`,
    "Fix ONLY the unit test file. Context is error + test + Top-K deps.",
    `Log lỗi (đuôi):\n${(opts.errorLog || "").slice(-2500)}`,
  ]
    .filter(Boolean)
    .join("\n\n");
  return { repairContext, failClass };
}
