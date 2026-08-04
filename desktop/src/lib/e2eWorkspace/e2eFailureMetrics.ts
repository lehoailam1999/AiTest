/**
 * Phase 4 — classify Verify failures and aggregate pass/% by error type.
 * Project-agnostic heuristics from Playwright / guard / auth excerpts.
 */

export type E2eFailCategory =
  | "auth"
  | "feature_entry"
  | "locator"
  | "stub"
  | "crash"
  | "assert"
  | "timeout"
  | "codegen"
  | "other";

export const E2E_FAIL_CATEGORY_LABELS: Record<E2eFailCategory, string> = {
  auth: "Auth / login",
  feature_entry: "Feature entry",
  locator: "Locator / DOM",
  stub: "Stub / Promise",
  crash: "Crash / load",
  assert: "Assert",
  timeout: "Timeout",
  codegen: "Codegen gate",
  other: "Khác",
};

/** Strip Playwright ANSI so classifiers see plain text. */
function stripAnsi(text: string): string {
  return text.replace(/\u001b\[[0-9;]*m/g, "").replace(/\x1b\[[0-9;]*m/g, "");
}

/** Ordered for priority when multiple patterns match (first wins). */
const CATEGORY_RULES: { cat: E2eFailCategory; re: RegExp }[] = [
  {
    cat: "codegen",
    re: /Phase\s*[23]\s*(?:journey|stub)|E2ECodegen(?:Journey|Stub)Error|empty fake-pass|Auth → Feature entry → Act|không map được spec|not present in Playwright report/i,
  },
  {
    cat: "stub",
    re: /ungrounded POM stub|Phase 3:\s*ungrounded|\[object Promise\]|generated\.bin|undefined\.or|Cannot read propert(?:y|ies) of undefined \(reading 'or'\)|fixtures[/\\].*\.(?:bin|pdf)/i,
  },
  {
    cat: "auth",
    re: /login wall|password still visible|E2E_USERNAME|E2E_PASSWORD|storageState|ENOENT.*storage|credentials?|401|Unauthorized|Đăng nhập|sign[\s-]*in failed|Login did not leave|ensureAuthenticated\s*\(/i,
  },
  {
    cat: "feature_entry",
    re: /Feature entry|E2E_FEATURE_PATH|gotoFeature|still on (?:the )?login|màn chức năng|feature screen/i,
  },
  {
    cat: "crash",
    re: /No tests found|SyntaxError|is not a function|Cannot find module|ERR_MODULE_NOT_FOUND|ReferenceError|TypeError(?!.*Timeout)/i,
  },
  {
    cat: "timeout",
    re: /Test timeout|Timeout \d+ms exceeded|timed?\s*out|waiting for (?:locator|selector|page)/i,
  },
  {
    cat: "locator",
    re: /strict mode violation|getBy(?:Role|Text|Label|TestId|Placeholder)|locator\(|toBeVisible|not visible|resolved to \d+ elements|Unable to find|element\(s\) not found/i,
  },
  {
    cat: "assert",
    re: /expect\(|AssertionError|toHave(?:Text|Count|Value|URL)|toContainText|toBe(?:Checked|Disabled|Enabled|Hidden)/i,
  },
];

export function classifyE2eFailure(
  error: string | null | undefined
): E2eFailCategory {
  const text = stripAnsi(error || "").trim();
  if (!text) return "other";
  for (const { cat, re } of CATEGORY_RULES) {
    if (re.test(text)) return cat;
  }
  return "other";
}

export type E2eMetricRow = {
  testCaseId: string;
  title?: string;
  status: "ok" | "fail" | string;
  error?: string;
  failCategory?: E2eFailCategory;
};

export type E2eRunMetrics = {
  total: number;
  passed: number;
  failed: number;
  passRatePct: number;
  /** Counts among failed rows only */
  failByCategory: Partial<Record<E2eFailCategory, number>>;
  /** % of failures in each category (sums ~100 when failed>0) */
  failSharePct: Partial<Record<E2eFailCategory, number>>;
  /** % of total suite in each fail category */
  suiteSharePct: Partial<Record<E2eFailCategory, number>>;
  rows: Array<E2eMetricRow & { failCategory: E2eFailCategory | "pass" }>;
  summaryLine: string;
};

export function aggregateE2eMetrics(rows: E2eMetricRow[]): E2eRunMetrics {
  const total = rows.length;
  let passed = 0;
  let failed = 0;
  const failByCategory: Partial<Record<E2eFailCategory, number>> = {};
  const outRows: E2eRunMetrics["rows"] = [];

  for (const r of rows) {
    const ok = r.status === "ok";
    if (ok) {
      passed += 1;
      outRows.push({ ...r, failCategory: "pass" });
      continue;
    }
    failed += 1;
    const cat = r.failCategory || classifyE2eFailure(r.error);
    failByCategory[cat] = (failByCategory[cat] || 0) + 1;
    outRows.push({ ...r, failCategory: cat });
  }

  const passRatePct = total === 0 ? 0 : Math.round((passed / total) * 1000) / 10;
  const failSharePct: Partial<Record<E2eFailCategory, number>> = {};
  const suiteSharePct: Partial<Record<E2eFailCategory, number>> = {};
  for (const [k, n] of Object.entries(failByCategory) as [E2eFailCategory, number][]) {
    failSharePct[k] =
      failed === 0 ? 0 : Math.round((n / failed) * 1000) / 10;
    suiteSharePct[k] =
      total === 0 ? 0 : Math.round((n / total) * 1000) / 10;
  }

  const top = Object.entries(failByCategory).sort((a, b) => b[1] - a[1])[0];
  const topHint =
    top && failed > 0
      ? ` · top fail: ${E2E_FAIL_CATEGORY_LABELS[top[0] as E2eFailCategory]} ${failSharePct[top[0] as E2eFailCategory]}%`
      : "";
  const summaryLine = `Phase 4 metrics: ${passed}/${total} PASS (${passRatePct}%)${topHint}`;

  return {
    total,
    passed,
    failed,
    passRatePct,
    failByCategory,
    failSharePct,
    suiteSharePct,
    rows: outRows,
    summaryLine,
  };
}

/** Human-readable multi-line breakdown for logs / UI. */
export function formatE2eMetricsReport(m: E2eRunMetrics): string {
  const lines = [
    m.summaryLine,
    `  suite fail share: ${m.failed}/${m.total} (${m.total ? Math.round((m.failed / m.total) * 1000) / 10 : 0}%)`,
  ];
  const cats = Object.entries(m.failByCategory).sort((a, b) => b[1] - a[1]) as [
    E2eFailCategory,
    number,
  ][];
  for (const [cat, n] of cats) {
    lines.push(
      `  - ${E2E_FAIL_CATEGORY_LABELS[cat]}: ${n} · ${m.failSharePct[cat]}% of fails · ${m.suiteSharePct[cat]}% of suite`
    );
  }
  return lines.join("\n");
}
