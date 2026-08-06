/**
 * Phase S5 — run smoke Gen (sequential) + taxonomy + optional Verify subset.
 */
import type { E2EFileDto } from "../../api";
import type { TestCase } from "../../api/types";
import {
  classifyE2eFailure,
  toStandardTaxonomy,
} from "./e2eFailureMetrics";
import {
  generateE2eBatch,
  verifyE2eModuleBatch,
  type E2eBatchItemResult,
  type E2eGenItem,
} from "./e2eJobRunner";
import {
  buildSmokeJobReport,
  E2E_SMOKE_DEFAULT_SIZE,
  E2E_SMOKE_VERIFY_MAX,
  pickE2eSmokeSet,
  type SmokeJobReport,
  type SmokeTcOutcome,
} from "./e2eSmokeSet";
import { pickDiscoveredStorageStateRel } from "./pickDiscoveredStorageState";

export type RunE2eSmokeJobOpts = {
  projectId: string;
  projectRoot: string;
  /** Approved E2E pool — smoke set is picked from this */
  testCases: TestCase[];
  targetUrl: string;
  module: string;
  requirementTitle?: string;
  provider?: string | null;
  smokeSize?: number;
  verifyMax?: number;
  /** When true (default), Verify up to verifyMax genOk Specs */
  runVerify?: boolean;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  storageStateRel?: string;
  defaultAuthRole?: string;
  usePlaywrightInspect?: boolean;
  skipAuthSeed?: boolean;
  showBrowser?: boolean;
  authDiscovery?: {
    ready?: boolean;
    defaultRole?: string;
    roles?: Array<{
      role: string;
      storageStateRel?: string | null;
      storageStateValid?: boolean;
    }>;
  } | null;
  onLog?: (line: string) => void;
  onProgress?: (p: {
    phase: "generate" | "verify" | "done";
    current: number;
    total: number;
    label: string;
  }) => void;
  waitIfPaused?: () => Promise<void>;
};

export type RunE2eSmokeJobResult = {
  smokeCases: TestCase[];
  report: SmokeJobReport;
  rows: E2eBatchItemResult[];
  genItems: E2eGenItem[];
  files: E2EFileDto[];
};

export async function runE2eSmokeJob(
  opts: RunE2eSmokeJobOpts
): Promise<RunE2eSmokeJobResult> {
  const log = (line: string) => opts.onLog?.(line);
  const size = opts.smokeSize ?? E2E_SMOKE_DEFAULT_SIZE;
  const verifyMax = opts.verifyMax ?? E2E_SMOKE_VERIFY_MAX;
  const runVerify = opts.runVerify !== false;

  const smokeCases = pickE2eSmokeSet(opts.testCases, size);
  if (!smokeCases.length) {
    throw new Error("E2E Smoke: không có TC E2E Approved để chạy smoke set");
  }

  log(
    `→ S5 Smoke: ${smokeCases.length} TC (sequential Gen)` +
      `${runVerify ? ` · Verify ≤${verifyMax}` : ""}\n`
  );
  for (const tc of smokeCases) {
    log(`  · ${tc.title}\n`);
  }

  const storageStateRel =
    opts.storageStateRel?.trim() ||
    pickDiscoveredStorageStateRel(opts.authDiscovery) ||
    undefined;
  const authAvailable = Boolean(
    storageStateRel ||
      (opts.username?.trim() && opts.password?.trim()) ||
      opts.useStorageState ||
      opts.authDiscovery?.ready
  );

  // waitIfPaused forces sequential concurrency in generateE2eBatch
  const waitGate =
    opts.waitIfPaused ||
    (async () => {
      /* sequential gate */
    });

  const { rows, files, genItems } = await generateE2eBatch({
    projectId: opts.projectId,
    projectRoot: opts.projectRoot,
    testCases: smokeCases,
    targetUrl: opts.targetUrl,
    module: opts.module,
    requirementTitle: opts.requirementTitle,
    provider: opts.provider,
    useStorageState: opts.useStorageState || Boolean(storageStateRel),
    username: opts.username,
    password: opts.password,
    storageStateRel,
    defaultAuthRole: opts.defaultAuthRole || opts.authDiscovery?.defaultRole,
    inspectPerTc: true,
    usePlaywrightInspect: opts.usePlaywrightInspect,
    skipAuthSeed: opts.skipAuthSeed ?? Boolean(storageStateRel),
    waitIfPaused: waitGate,
    onLog: log,
    onProgress: (p) =>
      opts.onProgress?.({
        phase: "generate",
        current: p.current,
        total: p.total,
        label: p.label,
      }),
  });

  const byId = new Map(rows.map((r) => [r.testCaseId, r]));
  const genById = new Map(genItems.map((g) => [g.testCaseId, g]));

  const outcomes: SmokeTcOutcome[] = smokeCases.map((tc) => {
    const row = byId.get(tc.id);
    const gen = genById.get(tc.id);
    const genOk = row?.status === "generated" || Boolean(gen?.primarySpecPath);
    const error = row?.error;
    const failCategory = genOk ? undefined : classifyE2eFailure(error);
    const loginWallCleared = /login wall|DOM cleared|Gen chỉ dựa FE hooks/i.test(
      error || ""
    );
    return {
      testCaseId: tc.id,
      title: tc.title,
      module: tc.module,
      genOk,
      error: genOk ? undefined : error,
      failCategory,
      standardTaxonomy: genOk ? "pass" : toStandardTaxonomy(failCategory),
      featurePath: gen?.featurePath,
      sourceFileName: gen?.sourceFileName,
      loginWallCleared: loginWallCleared || undefined,
    };
  });

  // Optional Verify on first N genOk items
  if (runVerify) {
    const okItems = genItems
      .filter((g) => g.primarySpecPath)
      .slice(0, verifyMax);
    if (okItems.length) {
      log(`→ S5 Smoke Verify: ${okItems.length} Spec\n`);
      opts.onProgress?.({
        phase: "verify",
        current: 0,
        total: okItems.length,
        label: "Verify smoke…",
      });
      const verifyFiles = okItems.flatMap((g) => g.files);
      try {
        const verified = await verifyE2eModuleBatch({
          projectId: opts.projectId,
          projectRoot: opts.projectRoot,
          module: opts.module,
          targetUrl: opts.targetUrl,
          files: verifyFiles.length ? verifyFiles : files,
          genItems: okItems,
          showBrowser: opts.showBrowser !== false,
          provider: opts.provider,
          healFailures: false,
          maxRetries: 1,
          useStorageState: opts.useStorageState || Boolean(storageStateRel),
          username: opts.username,
          password: opts.password,
          storageStateRel,
          defaultAuthRole: opts.defaultAuthRole || opts.authDiscovery?.defaultRole,
          onLog: log,
        });
        const vById = new Map(verified.rows.map((r) => [r.testCaseId, r]));
        for (const o of outcomes) {
          const vr = vById.get(o.testCaseId);
          if (!vr) continue;
          o.verified = true;
          o.verifyOk = vr.status === "ok";
          o.verifyError = vr.error;
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        log(`  smoke verify ERROR: ${msg}\n`);
        for (const g of okItems) {
          const o = outcomes.find((x) => x.testCaseId === g.testCaseId);
          if (!o) continue;
          o.verified = true;
          o.verifyOk = false;
          o.verifyError = msg;
        }
      }
    } else {
      log("→ S5 Smoke Verify: skip (0 Gen OK)\n");
    }
  }

  const report = buildSmokeJobReport(outcomes, {
    authAvailable,
    journeySyntheticOk: true,
  });
  log(`${report.reportText}\n`);
  opts.onProgress?.({
    phase: "done",
    current: smokeCases.length,
    total: smokeCases.length,
    label: report.taxonomy.summaryLine,
  });

  return { smokeCases, report, rows, genItems, files };
}
