/**
 * Phase S5 — portable smoke set + G1–G7 gate evaluation.
 * No product/module hardcode; works on any attached project's Approved E2E TCs.
 */
import type { TestCase } from "../../api/types";
import {
  extractDomainTokens,
  isExcludedFromE2eRetrieve,
  modulePathTokenBonus,
} from "../retrieval/rankScore";
import { isUsableFeaturePath } from "./assertTcReadyForE2eGen";
import {
  classifyE2eFailure,
  toStandardTaxonomy,
  type E2eFailCategory,
  type E2eStandardTaxonomy,
} from "./e2eFailureMetrics";
import { isLikelyLoginTestCase } from "./inspectDomCache";

export const E2E_SMOKE_DEFAULT_SIZE = 10;
export const E2E_SMOKE_VERIFY_MAX = 3;

export type SmokeGateId = "G1" | "G2" | "G3" | "G4" | "G5" | "G6" | "G7";

export type SmokeGateResult = {
  id: SmokeGateId;
  label: string;
  pass: boolean;
  detail: string;
  /** null = not measured (skipped / no data) */
  measured: boolean;
};

export type SmokeTcOutcome = {
  testCaseId: string;
  title: string;
  module?: string | null;
  genOk: boolean;
  error?: string;
  failCategory?: E2eFailCategory;
  standardTaxonomy?: E2eStandardTaxonomy | "pass";
  featurePath?: string;
  sourceFileName?: string;
  /** Inspect cleared login-wall DOM for this feature TC */
  loginWallCleared?: boolean;
  verified?: boolean;
  verifyOk?: boolean;
  verifyError?: string;
};

export type SmokeTaxonomyReport = {
  total: number;
  genOk: number;
  genFail: number;
  genPassRatePct: number;
  byStandard: Partial<Record<E2eStandardTaxonomy, number>>;
  byCategory: Partial<Record<E2eFailCategory, number>>;
  summaryLine: string;
};

export type SmokeJobReport = {
  smokeSize: number;
  testCaseIds: string[];
  outcomes: SmokeTcOutcome[];
  taxonomy: SmokeTaxonomyReport;
  gates: SmokeGateResult[];
  allMeasuredGatesPass: boolean;
  /** True when G1–G6 pass (perf unlock). G7 may be skipped. */
  readyForPerfPlan: boolean;
  reportText: string;
};

/** Diversify HappyPath / Validation / Auth for smoke (portable heuristics). */
export function pickE2eSmokeSet(
  approvedE2e: TestCase[],
  size = E2E_SMOKE_DEFAULT_SIZE
): TestCase[] {
  const list = (approvedE2e || []).filter((t) => t.reviewStatus === "Approved");
  if (list.length <= size) return [...list];

  const buckets: { key: string; items: TestCase[] }[] = [
    { key: "auth", items: [] },
    { key: "validation", items: [] },
    { key: "happy", items: [] },
    { key: "other", items: [] },
  ];
  for (const tc of list) {
    const blob = `${tc.title}\n${tc.steps}\n${tc.type || ""}`.toLowerCase();
    if (isLikelyLoginTestCase(tc) || /auth|permission|đăng\s*nhập|login/.test(blob)) {
      buckets[0].items.push(tc);
    } else if (
      /validat|invalid|empty|thiếu|sai|error|boundary|negative|bắt\s*buộc/.test(blob)
    ) {
      buckets[1].items.push(tc);
    } else if (/happy|success|tạo|create|thêm|add|lưu|save|upload|submit/.test(blob)) {
      buckets[2].items.push(tc);
    } else {
      buckets[3].items.push(tc);
    }
  }

  const out: TestCase[] = [];
  const seen = new Set<string>();
  let guard = 0;
  while (out.length < size && guard < size * 8) {
    guard += 1;
    let added = false;
    for (const b of buckets) {
      if (out.length >= size) break;
      const next = b.items.find((t) => !seen.has(t.id));
      if (!next) continue;
      seen.add(next.id);
      out.push(next);
      added = true;
    }
    if (!added) break;
  }
  if (out.length < size) {
    for (const tc of [...list].sort((a, b) => a.title.localeCompare(b.title))) {
      if (out.length >= size) break;
      if (seen.has(tc.id)) continue;
      out.push(tc);
    }
  }
  return out;
}

function pathSharesDomainToken(
  primary: string | undefined,
  tc: Pick<TestCase, "module" | "title" | "testData" | "steps">,
  featurePath?: string
): boolean {
  if (!primary) return false;
  const tokens = extractDomainTokens(
    tc.module,
    featurePath,
    (tc.testData || "")
      .split(/\r?\n/)
      .filter((l) => /^(?:\s*)(?:path|route|featurePath)\s*[:=]/i.test(l))
      .join("\n")
  );
  if (!tokens.length) {
    const mod = (tc.module || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
    if (
      mod.length >= 3 &&
      primary.toLowerCase().includes(mod.slice(0, Math.min(6, mod.length)))
    ) {
      return true;
    }
    return false;
  }
  return modulePathTokenBonus(primary, tokens) > 0;
}

export function buildSmokeTaxonomy(outcomes: SmokeTcOutcome[]): SmokeTaxonomyReport {
  const total = outcomes.length;
  let genOk = 0;
  let genFail = 0;
  const byStandard: Partial<Record<E2eStandardTaxonomy, number>> = {};
  const byCategory: Partial<Record<E2eFailCategory, number>> = {};
  for (const o of outcomes) {
    if (o.genOk) {
      genOk += 1;
      continue;
    }
    genFail += 1;
    const cat = o.failCategory || classifyE2eFailure(o.error);
    const tax =
      o.standardTaxonomy && o.standardTaxonomy !== "pass"
        ? o.standardTaxonomy
        : toStandardTaxonomy(cat);
    byCategory[cat] = (byCategory[cat] || 0) + 1;
    if (tax !== "pass") {
      byStandard[tax] = (byStandard[tax] || 0) + 1;
    }
  }
  const genPassRatePct = total === 0 ? 0 : Math.round((genOk / total) * 1000) / 10;
  const top = Object.entries(byStandard).sort((a, b) => b[1] - a[1])[0];
  const summaryLine =
    `S5 smoke taxonomy: Gen ${genOk}/${total} OK (${genPassRatePct}%)` +
    (top ? ` · top fail: ${top[0]}×${top[1]}` : "");
  return {
    total,
    genOk,
    genFail,
    genPassRatePct,
    byStandard,
    byCategory,
    summaryLine,
  };
}

export type EvaluateSmokeGatesInput = {
  outcomes: SmokeTcOutcome[];
  taxonomy: SmokeTaxonomyReport;
  authAvailable?: boolean;
  journeySyntheticOk?: boolean;
};

export function evaluateSmokeGates(input: EvaluateSmokeGatesInput): SmokeGateResult[] {
  const { outcomes, taxonomy, authAvailable, journeySyntheticOk = true } = input;
  const featureOutcomes = outcomes.filter((o) => !isLikelyLoginTestCase({ title: o.title }));
  const withPrimary = featureOutcomes.filter((o) => (o.sourceFileName || "").trim());

  let g1Pass = true;
  let g1Measured = withPrimary.length > 0;
  let g1Detail = "no FE primary recorded";
  if (withPrimary.length) {
    const ok = withPrimary.filter((o) =>
      pathSharesDomainToken(
        o.sourceFileName,
        { module: o.module, title: o.title, testData: "", steps: "" },
        o.featurePath
      )
    ).length;
    const pct = Math.round((ok / withPrimary.length) * 1000) / 10;
    g1Pass = pct >= 90;
    g1Detail = `${ok}/${withPrimary.length} primaries share module/path token (${pct}%)`;
  }

  const noise = withPrimary.filter((o) =>
    isExcludedFromE2eRetrieve(o.sourceFileName || "")
  );
  const g2Pass = noise.length === 0;
  const g2Measured = withPrimary.length > 0 || featureOutcomes.length > 0;
  const g2Detail =
    noise.length === 0
      ? "0 exclude-shape primaries"
      : `noise: ${noise
          .map((n) => n.sourceFileName)
          .slice(0, 3)
          .join(", ")}`;

  const featureGenOk = featureOutcomes.filter((o) => o.genOk);
  let g3Pass = true;
  let g3Measured = featureGenOk.length > 0;
  let g3Detail = "no successful feature Gen";
  if (featureGenOk.length) {
    const ok = featureGenOk.filter((o) => isUsableFeaturePath(o.featurePath)).length;
    g3Pass = ok === featureGenOk.length;
    g3Detail = `${ok}/${featureGenOk.length} genOk feature TCs have usable featurePath`;
  }

  let g4Pass = true;
  let g4Measured = false;
  let g4Detail = "auth not available — skip";
  if (authAvailable) {
    const walls = featureOutcomes.filter((o) => o.loginWallCleared);
    g4Measured = true;
    g4Pass = walls.length === 0;
    g4Detail =
      walls.length === 0
        ? "no login-wall Inspect on feature TCs"
        : `${walls.length} feature TC(s) still hit login-wall Inspect`;
  }

  const g5Pass = taxonomy.total > 0 && taxonomy.genPassRatePct >= 80;
  const g5Measured = taxonomy.total > 0;
  const g5Detail = `Gen ${taxonomy.genOk}/${taxonomy.total} (${taxonomy.genPassRatePct}%)`;

  const journeyFails = outcomes.filter(
    (o) =>
      !o.genOk &&
      (/order:\s*Auth|Feature entry must come|journey enforce|Auth → Feature/i.test(
        o.error || ""
      ) ||
        o.failCategory === "codegen")
  );
  const g6Pass = journeySyntheticOk && journeyFails.length === 0;
  const g6Measured = true;
  const g6Detail =
    journeyFails.length === 0
      ? `0 journey-order fails · synthetic=${journeySyntheticOk ? "ok" : "fail"}`
      : `${journeyFails.length} journey-order fail(s)`;

  const verified = outcomes.filter((o) => o.verified);
  let g7Pass = true;
  let g7Measured = verified.length > 0;
  let g7Detail = "Verify not run";
  if (verified.length) {
    const crash = verified.filter((o) => {
      const err = o.verifyError || "";
      return (
        !o.verifyOk &&
        (/ENOENT.*storage|No tests found|Cannot find module|ERR_MODULE|crash/i.test(err) ||
          classifyE2eFailure(err) === "crash")
      );
    });
    const okN = verified.filter((o) => o.verifyOk).length;
    g7Pass = crash.length === 0;
    g7Detail = `Verify ${okN}/${verified.length} PASS · env crash=${crash.length}`;
  }

  return [
    {
      id: "G1",
      label: "FE seed token overlap ≥90%",
      pass: g1Pass,
      detail: g1Detail,
      measured: g1Measured,
    },
    {
      id: "G2",
      label: "0 Index/FE exclude primary",
      pass: g2Pass,
      detail: g2Detail,
      measured: g2Measured,
    },
    {
      id: "G3",
      label: "100% usable featurePath on genOk",
      pass: g3Pass,
      detail: g3Detail,
      measured: g3Measured,
    },
    {
      id: "G4",
      label: "Auth Inspect not login-wall",
      pass: g4Pass,
      detail: g4Detail,
      measured: g4Measured,
    },
    {
      id: "G5",
      label: "Gen ≥80% smoke",
      pass: g5Pass,
      detail: g5Detail,
      measured: g5Measured,
    },
    {
      id: "G6",
      label: "0 journey order fails",
      pass: g6Pass,
      detail: g6Detail,
      measured: g6Measured,
    },
    {
      id: "G7",
      label: "Verify no env crash",
      pass: g7Pass,
      detail: g7Detail,
      measured: g7Measured,
    },
  ];
}

export function formatSmokeReport(report: Omit<SmokeJobReport, "reportText">): string {
  const lines: string[] = [
    `=== E2E Smoke S5 (${report.smokeSize} TC) ===`,
    report.taxonomy.summaryLine,
  ];
  const taxEntries = Object.entries(report.taxonomy.byStandard).sort(
    (a, b) => b[1] - a[1]
  );
  for (const [k, n] of taxEntries) {
    lines.push(`  taxonomy ${k}: ${n}`);
  }
  lines.push("Gates:");
  for (const g of report.gates) {
    const mark = !g.measured ? "—" : g.pass ? "PASS" : "FAIL";
    lines.push(`  ${g.id} ${mark}: ${g.label} — ${g.detail}`);
  }
  lines.push(
    report.readyForPerfPlan
      ? "→ G1–G6 PASS — có thể mở CODEGEN_PERF plan"
      : "→ Chưa đủ G1–G6 — chưa mở Performance plan"
  );
  for (const o of report.outcomes) {
    const st = o.genOk
      ? "GEN_OK"
      : `GEN_FAIL/${o.standardTaxonomy || o.failCategory || "other"}`;
    const v =
      o.verified == null ? "" : o.verifyOk ? " · VERIFY_OK" : " · VERIFY_FAIL";
    lines.push(
      `  • ${st}${v}: ${o.title}${o.featurePath ? ` [${o.featurePath}]` : ""}`
    );
  }
  return lines.join("\n");
}

export function buildSmokeJobReport(
  outcomes: SmokeTcOutcome[],
  opts?: { authAvailable?: boolean; journeySyntheticOk?: boolean }
): SmokeJobReport {
  const taxonomy = buildSmokeTaxonomy(outcomes);
  const gates = evaluateSmokeGates({
    outcomes,
    taxonomy,
    authAvailable: opts?.authAvailable,
    journeySyntheticOk: opts?.journeySyntheticOk,
  });
  const readyForPerfPlan = gates
    .filter((g) => g.id !== "G7")
    .every((g) => !g.measured || g.pass);
  const allMeasuredGatesPass = gates.every((g) => !g.measured || g.pass);
  const base = {
    smokeSize: outcomes.length,
    testCaseIds: outcomes.map((o) => o.testCaseId),
    outcomes,
    taxonomy,
    gates,
    allMeasuredGatesPass,
    readyForPerfPlan,
  };
  return { ...base, reportText: formatSmokeReport(base) };
}
