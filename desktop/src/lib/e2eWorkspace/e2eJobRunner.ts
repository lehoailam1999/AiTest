/**
 * E2E job helpers — each phase is an independent function.
 * UI calls Inspect / Generate / Verify / Heal separately (no forced full pipeline).
 */
import { generateE2e, type E2EFileDto } from "../../api";
import type { TestCase } from "../../api/types";
import { createAsyncMutex, runPool } from "../runPool";
import { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env";
import {
  syncE2eModuleBatchCampaign,
  syncE2eVerifyReport,
  syncE2eWorkspaceRun,
} from "./auditSync";
import { newE2eRunId } from "./stagingApply";

/** Parallel oneshot / TC — mỗi request gắn testCaseId riêng; cap 3 để tránh overload Cursor. */
const E2E_GEN_CONCURRENCY = 3;

export type E2eBatchItemResult = {
  testCaseId: string;
  title: string;
  status: "ok" | "fail" | "pending" | "running" | "generated";
  runId?: string;
  error?: string;
  files?: number;
};

export type E2eBatchProgress = {
  phase: "inspect" | "generate" | "headless" | "heal" | "done";
  current: number;
  total: number;
  label: string;
};

export type E2eGenItem = {
  testCaseId: string;
  title: string;
  runId: string;
  primarySpecPath: string;
  files: E2EFileDto[];
};

export type E2eInspectResult = {
  domSnapshot: string;
  elementCount: number;
  routeCount: number;
  source: string;
};

function fileKindLabel(path: string): string {
  const p = path.replace(/\\/g, "/").toLowerCase();
  if (p.endsWith("playwright.config.ts")) return "config";
  if (p.includes("/pages/")) return "page";
  if (p.includes("/specs/")) return "spec";
  if (p.includes("/fixtures/")) return "fixture";
  return "file";
}

function summarizeFiles(
  files: E2EFileDto[],
  opts?: { baseline?: E2EFileDto[]; limit?: number; previewChars?: number }
): string {
  if (!files.length) return "  files=0\n";
  const baseline = new Map(
    (opts?.baseline || []).map((f) => [f.path.replace(/\\/g, "/"), f.content])
  );
  const rows: string[] = [];
  const limit = opts?.limit ?? 8;
  const previewChars = opts?.previewChars ?? 240;
  let add = 0;
  let mod = 0;
  const previews: string[] = [];
  for (const f of files) {
    const norm = f.path.replace(/\\/g, "/");
    const prev = baseline.get(norm);
    const action = prev == null ? "+" : prev === f.content ? "=" : "~";
    if (action === "+") add += 1;
    if (action === "~") mod += 1;
    if (rows.length < limit) {
      rows.push(`  ${action} [${fileKindLabel(norm)}] ${norm}`);
    }
    if ((action === "+" || action === "~") && previews.length < 3) {
      const compact = (f.content || "").replace(/\r/g, "").trim();
      if (compact) {
        const snippet =
          compact.length > previewChars
            ? `${compact.slice(0, previewChars)}…`
            : compact;
        previews.push(
          `  preview ${action} ${norm}\n` +
            "```ts\n" +
            `${snippet}\n` +
            "```\n"
        );
      }
    }
  }
  const unchanged = files.length - add - mod;
  const header = `  files=${files.length} (+${add} ~${mod} =${unchanged})\n`;
  const body = rows.map((r) => `${r}\n`).join("");
  const more =
    files.length > limit ? `  … +${files.length - limit} file(s) nữa\n` : "";
  const previewBlock = previews.length
    ? `  changed content preview:\n${previews.join("")}`
    : "";
  return header + body + more + previewBlock;
}

function mergeFiles(into: E2EFileDto[], add: E2EFileDto[]): E2EFileDto[] {
  const by = new Map(into.map((f) => [f.path.replace(/\\/g, "/"), f]));
  for (const f of add) {
    by.set(f.path.replace(/\\/g, "/"), f);
  }
  return [...by.values()];
}

function matchSpecToTc(
  specPath: string,
  items: { testCaseId: string; primarySpecPath: string; title: string }[]
): (typeof items)[0] | undefined {
  const norm = specPath.replace(/\\/g, "/");
  const base = norm.split("/").pop() || norm;
  return (
    items.find((i) => i.primarySpecPath.replace(/\\/g, "/") === norm) ||
    items.find((i) => i.primarySpecPath.replace(/\\/g, "/").endsWith(base)) ||
    items.find((i) => (i.primarySpecPath.split("/").pop() || "") === base)
  );
}

/** Step: Inspect DOM / Target URL only. */
export async function inspectE2eDom(opts: {
  targetUrl: string;
  projectRoot: string;
  usePlaywrightInspect?: boolean;
  onLog?: (line: string) => void;
}): Promise<E2eInspectResult> {
  const log = (line: string) => opts.onLog?.(line);
  log("→ Inspect Target URL…\n");
  const inspected = await generateE2e.inspect({
    targetUrl: opts.targetUrl,
    projectRoot: opts.projectRoot,
    usePlaywright: opts.usePlaywrightInspect,
  });
  const elementCount = inspected.elements?.length ?? 0;
  const routeCount = inspected.routes?.length ?? 0;
  log(`  elements=${elementCount} routes=${routeCount} source=${inspected.source}\n`);
  return {
    domSnapshot: inspected.promptJson || "",
    elementCount,
    routeCount,
    source: inspected.source || "",
  };
}

/** Step: Generate POM + Spec for one TC (no Playwright). */
export async function generateE2eForTestCase(opts: {
  projectId: string;
  projectRoot: string;
  testCase: TestCase;
  targetUrl: string;
  module?: string;
  requirementTitle?: string;
  domSnapshot?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  existingFiles?: E2EFileDto[];
  provider?: string | null;
  onLog?: (line: string) => void;
}): Promise<{
  runId: string;
  files: E2EFileDto[];
  primarySpecPath: string;
  provider?: string | null;
}> {
  const tc = opts.testCase;
  const runId = newE2eRunId(tc.id);
  const moduleName = opts.module || tc.module || undefined;
  const log = (line: string) => opts.onLog?.(line);
  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: moduleName,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
  });

  syncE2eWorkspaceRun({
    projectId: opts.projectId,
    localRunId: runId,
    testCaseId: tc.id,
    module: moduleName,
    status: "verifying",
    provider: opts.provider,
  });

  log(`→ Generate: ${tc.title}\n`);
  const gen = await generateE2e.run({
    projectId: opts.projectId,
    testCaseId: tc.id,
    targetUrl: env.targetUrl,
    domSnapshot: opts.domSnapshot || undefined,
    module: moduleName,
    requirementTitle: opts.requirementTitle || undefined,
    projectRoot: opts.projectRoot,
    storageStateRel: env.storageStateRel,
    seedCommand: env.seedCommand,
    teardownCommand: env.teardownCommand,
    existingFiles: opts.existingFiles,
  });
  const files = gen.files || [];
  const primarySpecPath =
    gen.primarySpecPath ||
    files.find((f) => f.kind === "spec" || /specs\//.test(f.path))?.path ||
    "";
  log(`  primary=${primarySpecPath}\n`);
  log(summarizeFiles(files));

  syncE2eWorkspaceRun({
    projectId: opts.projectId,
    localRunId: runId,
    testCaseId: tc.id,
    module: moduleName,
    status: "generated",
    provider: gen.runnerUsed || opts.provider,
  });

  return {
    runId,
    files,
    primarySpecPath,
    provider: gen.runnerUsed || opts.provider,
  };
}

/** Step: Generate N TCs in parallel (bounded). Each call is scoped to one testCaseId. */
export async function generateE2eBatch(opts: {
  projectId: string;
  projectRoot: string;
  testCases: TestCase[];
  targetUrl: string;
  module: string;
  requirementTitle?: string;
  domSnapshot?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  provider?: string | null;
  onLog?: (line: string) => void;
  onProgress?: (p: E2eBatchProgress) => void;
  waitIfPaused?: () => Promise<void>;
}): Promise<{
  rows: E2eBatchItemResult[];
  files: E2EFileDto[];
  genItems: E2eGenItem[];
}> {
  const cases = opts.testCases;
  const total = cases.length;
  const log = (line: string) => opts.onLog?.(line);
  const progress = (p: E2eBatchProgress) => opts.onProgress?.(p);
  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: opts.module,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
  });

  const rows: E2eBatchItemResult[] = cases.map((t) => ({
    testCaseId: t.id,
    title: t.title,
    status: "pending",
  }));
  let allFiles: E2EFileDto[] = [];
  const genItemsSlot: (E2eGenItem | null)[] = cases.map(() => null);
  const mergeLock = createAsyncMutex();
  let done = 0;

  log(
    `→ Generate batch parallel ×${Math.min(E2E_GEN_CONCURRENCY, total)} · ${total} TC (mỗi TC 1 request riêng)\n`
  );

  await runPool(
    cases,
    E2E_GEN_CONCURRENCY,
    async (tc, i) => {
      await mergeLock.run(() => {
        rows[i] = { ...rows[i], status: "running" };
        progress({
          phase: "generate",
          current: done,
          total,
          label: `Generate: ${tc.title}`,
        });
      });

      // Snapshot POM pages under lock so parallel workers don't race merge;
      // each generate still binds API to this tc.id → files map về đúng TC.
      const existingPages = await mergeLock.run(() =>
        allFiles.filter((f) => f.kind === "page" || /\/pages\//.test(f.path))
      );

      try {
        const gen = await generateE2eForTestCase({
          projectId: opts.projectId,
          projectRoot: opts.projectRoot,
          testCase: tc,
          targetUrl: env.targetUrl,
          module: opts.module,
          requirementTitle: opts.requirementTitle,
          domSnapshot: opts.domSnapshot,
          useStorageState: opts.useStorageState,
          username: opts.username,
          password: opts.password,
          seedCommand: opts.seedCommand,
          teardownCommand: opts.teardownCommand,
          existingFiles: existingPages,
          provider: opts.provider,
          onLog: log,
        });
        // Paths đã resolve theo Requirement/TC trên BE; giữ đúng file của request này.
        const ownedFiles = gen.files;
        await mergeLock.run(() => {
          allFiles = mergeFiles(allFiles, ownedFiles);
          genItemsSlot[i] = {
            testCaseId: tc.id,
            title: tc.title,
            runId: gen.runId,
            primarySpecPath: gen.primarySpecPath,
            files: ownedFiles,
          };
          rows[i] = {
            ...rows[i],
            status: "generated",
            files: ownedFiles.length,
            runId: gen.runId,
          };
          done += 1;
          progress({
            phase: "generate",
            current: done,
            total,
            label: `Generate ${done}/${total}`,
          });
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await mergeLock.run(() => {
          rows[i] = { ...rows[i], status: "fail", error: msg };
          done += 1;
          progress({
            phase: "generate",
            current: done,
            total,
            label: `Generate ${done}/${total}`,
          });
        });
        log(`  generate fail [${tc.testCaseId || tc.id}]: ${msg}\n`);
      }
    },
    { waitGate: opts.waitIfPaused }
  );

  const genItems = genItemsSlot.filter((x): x is E2eGenItem => Boolean(x));
  progress({
    phase: "done",
    current: total,
    total,
    label: `Generate xong ${genItems.length}/${total}`,
  });
  log(`→ Generate batch xong: ${genItems.length}/${total} TC có file\n`);
  return { rows, files: allFiles, genItems };
}

type VerifyOpts = {
  projectId: string;
  projectRoot: string;
  module: string;
  targetUrl: string;
  files: E2EFileDto[];
  genItems: E2eGenItem[];
  domSnapshot?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  showBrowser?: boolean;
  provider?: string | null;
  /** When true, AI heal failed specs (maxRetries ≥ 2). Default false for Verify-only. */
  healFailures?: boolean;
  maxRetries?: number;
  onLog?: (line: string) => void;
  onProgress?: (p: E2eBatchProgress) => void;
  waitIfPaused?: () => Promise<void>;
  /** Seed rows (e.g. from Generate). */
  priorRows?: E2eBatchItemResult[];
};

/** Step: Playwright module run. Heal only when healFailures=true. */
export async function verifyE2eModuleBatch(opts: VerifyOpts): Promise<{
  rows: E2eBatchItemResult[];
  okCount: number;
  files: E2EFileDto[];
  moduleStatus: string;
}> {
  const log = (line: string) => opts.onLog?.(line);
  const progress = (p: E2eBatchProgress) => opts.onProgress?.(p);
  const showBrowser = opts.showBrowser !== false;
  const healFailures = Boolean(opts.healFailures);
  // Heal needs attempt 1 fail + attempt 2 with AI — maxRetries must be ≥ 2
  const maxRetries = healFailures
    ? Math.max(2, opts.maxRetries ?? 2)
    : Math.max(1, opts.maxRetries ?? 1);
  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: opts.module,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
  });

  const generatedOk = opts.genItems.filter((g) => g.primarySpecPath);
  const total = Math.max(generatedOk.length, opts.priorRows?.length || 0, 1);
  const rows: E2eBatchItemResult[] = (opts.priorRows || []).map((r) => ({ ...r }));
  for (const g of generatedOk) {
    const idx = rows.findIndex((r) => r.testCaseId === g.testCaseId);
    const base: E2eBatchItemResult = {
      testCaseId: g.testCaseId,
      title: g.title,
      status: "running",
      runId: g.runId,
      files: g.files.length,
    };
    if (idx >= 0) rows[idx] = { ...rows[idx], ...base };
    else rows.push(base);
  }

  if (generatedOk.length === 0 || opts.files.length === 0) {
    return {
      rows: rows.map((r) =>
        r.status === "running" || r.status === "generated" || r.status === "pending"
          ? { ...r, status: "fail", error: "Chưa có file Generate" }
          : r
      ),
      okCount: 0,
      files: opts.files,
      moduleStatus: "FAILED",
    };
  }

  await opts.waitIfPaused?.();

  const phase: E2eBatchProgress["phase"] = healFailures ? "heal" : "headless";
  progress({
    phase,
    current: total,
    total,
    label: healFailures
      ? showBrowser
        ? "Heal + Chromium…"
        : "Heal failed specs…"
      : showBrowser
        ? "Verify — đang mở Chromium…"
        : "Verify Playwright (specs/)…",
  });
  log(
    healFailures
      ? `→ Heal failed specs (maxRetries=${maxRetries})…\n`
      : showBrowser
        ? `→ Verify module (${generatedOk.length} specs) — cửa sổ Chromium…\n`
        : `→ Verify module (${generatedOk.length} specs)…\n`
  );

  let allFiles = [...opts.files];
  let moduleStatus = "FAILED";

  try {
    const mod = await generateE2e.sandboxModule({
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      files: allFiles,
      module: opts.module,
      targetUrl: env.targetUrl,
      domSnapshot: opts.domSnapshot || undefined,
      storageStateRel: env.storageStateRel,
      seedCommand: env.seedCommand,
      teardownCommand: env.teardownCommand,
      maxRetries,
      writeFile: true,
      healFailures,
      headed: showBrowser,
      playwrightEnv: playwrightEnvFromConfig(env),
      e2eUsername: env.username,
      e2ePassword: env.password,
      healItems: generatedOk.map((g) => ({
        testCaseId: g.testCaseId,
        primarySpecPath: g.primarySpecPath,
      })),
    });
    moduleStatus = mod.status;
    log(`  module-status=${mod.status}\n`);
    const failSpecs = (mod.specs || []).filter((s) => !s.success);
    if (failSpecs.length > 0 || moduleStatus !== "PASSED") {
      log(`  --- Nguyên nhân Verify FAIL (${failSpecs.length} spec) ---\n`);
      for (const s of failSpecs) {
        const excerpt = (s.errorExcerpt || "").trim() || "(không có errorExcerpt)";
        log(`  ✗ ${s.specPath}\n`);
        log(
          excerpt
            .split("\n")
            .slice(0, 40)
            .map((line) => `    ${line}`)
            .join("\n") + "\n"
        );
      }
      const tail = (mod.log || "").trim();
      if (tail) {
        log(`  --- Playwright log (cuối) ---\n`);
        log(tail.slice(-3500) + (tail.length > 3500 ? "\n…\n" : "\n"));
      }
    }
    log(summarizeFiles(mod.files || [], { baseline: opts.files }));
    allFiles = mergeFiles(allFiles, mod.files || []);
    const healList = mod.heal || [];
    if (healFailures) {
      for (const h of healList) {
        log(`  heal ${h.specPath}: ${h.status}\n`);
        if (h.status !== "PASSED" && h.errorLog) {
          log(
            `    heal error: ${String(h.errorLog).slice(0, 800)}\n`
          );
        }
      }
      if (mod.healSkipped) log(`  heal skipped: ${mod.healSkipped}\n`);
    }

    const healedPass = new Set(
      healList
        .filter((h) => h.status === "PASSED")
        .map((h) => h.specPath.replace(/\\/g, "/"))
    );

    for (const g of generatedOk) {
      const idx = rows.findIndex((r) => r.testCaseId === g.testCaseId);
      if (idx < 0) continue;
      const direct = (mod.specs || []).find((s) => {
        const sp = s.specPath.replace(/\\/g, "/");
        const pp = g.primarySpecPath.replace(/\\/g, "/");
        return (
          sp === pp ||
          sp.endsWith(pp.split("/").pop() || "") ||
          pp.endsWith(sp.split("/").pop() || "")
        );
      });
      const specRow = (mod.specs || []).find((s) =>
        matchSpecToTc(s.specPath, [
          {
            testCaseId: g.testCaseId,
            primarySpecPath: g.primarySpecPath,
            title: g.title,
          },
        ])
      );
      const spec = direct || specRow;
      let passed = false;
      let err: string | undefined;
      if (spec) {
        const sp = spec.specPath.replace(/\\/g, "/");
        passed =
          spec.success ||
          healedPass.has(sp) ||
          healedPass.has(sp.split("/").pop() || "");
        if (!passed) {
          for (const h of healList) {
            const hp = h.specPath.replace(/\\/g, "/");
            if (
              (hp === sp || hp.endsWith(sp.split("/").pop() || "")) &&
              h.status === "PASSED"
            ) {
              passed = true;
              break;
            }
          }
        }
        err = passed
          ? undefined
          : spec.errorExcerpt?.slice(0, 1200) ||
            healList.find((h) => h.specPath.includes(sp.split("/").pop() || ""))
              ?.errorLog?.slice(0, 1200) ||
            (mod.log || "").slice(-800) ||
            "FAIL";
      } else {
        // Do not inherit whole-module log (often another TC's error) when unmapped.
        passed = false;
        err = "FAIL — không map được spec trong báo cáo Verify batch";
      }

      rows[idx] = {
        ...rows[idx],
        status: passed ? "ok" : "fail",
        error: err,
        files: g.files.length,
        runId: g.runId,
      };

      const stages = [
        { stage: "inspect", success: !!opts.domSnapshot },
        { stage: "generate", success: true },
        { stage: healFailures ? "heal" : "headless", success: passed },
      ];
      try {
        await generateE2e.artifactsSync({
          projectId: opts.projectId,
          projectRoot: opts.projectRoot,
          localRunId: g.runId,
          testCaseId: g.testCaseId,
          module: opts.module,
          status: passed ? "PASSED" : "FAILED",
          primarySpecPath: g.primarySpecPath,
        });
        stages.push({ stage: "artifacts", success: true });
      } catch {
        stages.push({ stage: "artifacts", success: false });
      }
      syncE2eVerifyReport({
        projectId: opts.projectId,
        localRunId: g.runId,
        testCaseId: g.testCaseId,
        module: opts.module,
        overallPass: passed,
        stages,
      });
      syncE2eWorkspaceRun({
        projectId: opts.projectId,
        localRunId: g.runId,
        testCaseId: g.testCaseId,
        module: opts.module,
        status: passed ? "pass" : "fail",
        provider: opts.provider,
      });
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    log(`  verify fail: ${msg}\n`);
    for (const g of generatedOk) {
      const idx = rows.findIndex((r) => r.testCaseId === g.testCaseId);
      if (idx >= 0) {
        rows[idx] = { ...rows[idx], status: "fail", error: msg };
      }
      syncE2eWorkspaceRun({
        projectId: opts.projectId,
        localRunId: g.runId,
        testCaseId: g.testCaseId,
        module: opts.module,
        status: "fail",
        provider: opts.provider,
      });
    }
  }

  for (let i = 0; i < rows.length; i++) {
    if (rows[i].status === "running" || rows[i].status === "pending") {
      rows[i] = {
        ...rows[i],
        status: "fail",
        error: rows[i].error || "Verify incomplete",
      };
    }
  }

  const okCount = rows.filter((r) => r.status === "ok").length;
  progress({
    phase: "done",
    current: total,
    total,
    label: `Done ${okCount}/${rows.length}`,
  });
  log(
    `→ ${healFailures ? "Heal" : "Verify"} done: ${okCount}/${rows.length} PASS (module=${moduleStatus})\n`
  );

  syncE2eModuleBatchCampaign({
    projectId: opts.projectId,
    module: opts.module,
    tasks: rows.map((r) => ({
      testCaseId: r.testCaseId,
      localRunId: r.runId || newE2eRunId(r.testCaseId),
      status: r.status === "ok" ? ("ok" as const) : ("fail" as const),
      error: r.error,
    })),
  });

  return { rows, okCount, files: allFiles, moduleStatus };
}

/** Step: Verify one TC via sandboxRepair (no AI heal unless maxRetries≥2). */
export async function verifyE2eForTestCase(opts: {
  projectId: string;
  projectRoot: string;
  testCase: TestCase;
  targetUrl: string;
  files: E2EFileDto[];
  primarySpecPath?: string;
  runId?: string;
  domSnapshot?: string;
  module?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  showBrowser?: boolean;
  provider?: string | null;
  healFailures?: boolean;
  maxRetries?: number;
  onLog?: (line: string) => void;
}): Promise<{
  passed: boolean;
  files: E2EFileDto[];
  error?: string;
  primarySpecPath?: string;
  attempts: number;
}> {
  const tc = opts.testCase;
  const runId = opts.runId || newE2eRunId(tc.id);
  const moduleName = opts.module || tc.module || undefined;
  const log = (line: string) => opts.onLog?.(line);
  const showBrowser = opts.showBrowser !== false;
  const healFailures = Boolean(opts.healFailures);
  const maxRetries = healFailures
    ? Math.max(2, opts.maxRetries ?? 2)
    : Math.max(1, opts.maxRetries ?? 1);
  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: moduleName,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
  });

  log(
    healFailures
      ? `→ Heal + Verify ${tc.title}…\n`
      : showBrowser
        ? `→ Verify ${tc.title} (Chromium)…\n`
        : `→ Verify ${tc.title}…\n`
  );

  const sandbox = await generateE2e.sandboxRepair({
    projectId: opts.projectId,
    testCaseId: tc.id,
    projectRoot: opts.projectRoot,
    files: opts.files,
    primarySpecPath: opts.primarySpecPath,
    targetUrl: env.targetUrl,
    domSnapshot: opts.domSnapshot || undefined,
    module: moduleName,
    storageStateRel: env.storageStateRel,
    seedCommand: env.seedCommand,
    teardownCommand: env.teardownCommand,
    maxRetries,
    writeFile: true,
    headed: showBrowser,
    playwrightEnv: playwrightEnvFromConfig(env),
    e2eUsername: env.username,
    e2ePassword: env.password,
  });
  const passed = sandbox.status === "PASSED";
  log(`  status=${sandbox.status} attempts=${sandbox.attempts}\n`);
  if (!passed) {
    log(`  --- Nguyên nhân Verify FAIL ---\n`);
    const errBody = (sandbox.errorLog || "").trim();
    if (errBody) {
      log(
        errBody
          .split("\n")
          .slice(0, 50)
          .map((line) => `  ${line}`)
          .join("\n") + "\n"
      );
    } else {
      log("  (không có errorLog từ sandbox)\n");
    }
  }
  log(summarizeFiles(sandbox.files || [], { baseline: opts.files }));

  try {
    await generateE2e.artifactsSync({
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      localRunId: runId,
      testCaseId: tc.id,
      module: moduleName,
      status: passed ? "PASSED" : "FAILED",
      primarySpecPath: sandbox.primarySpecPath || opts.primarySpecPath,
    });
  } catch {
    /* optional */
  }

  syncE2eVerifyReport({
    projectId: opts.projectId,
    localRunId: runId,
    testCaseId: tc.id,
    module: moduleName,
    overallPass: passed,
    stages: [
      { stage: "generate", success: opts.files.length > 0 },
      { stage: healFailures ? "heal" : "headless", success: passed },
    ],
  });
  syncE2eWorkspaceRun({
    projectId: opts.projectId,
    localRunId: runId,
    testCaseId: tc.id,
    module: moduleName,
    status: passed ? "pass" : "fail",
    provider: opts.provider,
  });

  return {
    passed,
    files: sandbox.files || opts.files,
    error: passed ? undefined : sandbox.errorLog?.slice(0, 400) || "FAIL",
    primarySpecPath: sandbox.primarySpecPath || opts.primarySpecPath,
    attempts: sandbox.attempts ?? maxRetries,
  };
}

/**
 * @deprecated Prefer step APIs (inspect / generate / verify / heal).
 * Kept for callers that still want one-shot pipeline.
 */
export async function runE2eJobForTestCase(opts: {
  projectId: string;
  projectRoot: string;
  testCase: TestCase;
  targetUrl: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  usePlaywrightInspect?: boolean;
  showBrowser?: boolean;
  provider?: string | null;
  onLog?: (line: string) => void;
  domSnapshot?: string;
  skipInspect?: boolean;
}): Promise<{
  passed: boolean;
  runId: string;
  files: E2EFileDto[];
  error?: string;
  primarySpecPath?: string;
  domSnapshot?: string;
}> {
  const log = (line: string) => opts.onLog?.(line);
  let domSnapshot = opts.domSnapshot || "";
  if (!opts.skipInspect) {
    try {
      const inspected = await inspectE2eDom({
        targetUrl: opts.targetUrl,
        projectRoot: opts.projectRoot,
        usePlaywrightInspect: opts.usePlaywrightInspect,
        onLog: log,
      });
      domSnapshot = inspected.domSnapshot;
    } catch (e) {
      log(`  inspect warn: ${String(e)}\n`);
    }
  } else {
    log("→ Inspect skipped\n");
  }

  const gen = await generateE2eForTestCase({
    ...opts,
    domSnapshot,
    onLog: log,
  });

  const verified = await verifyE2eForTestCase({
    ...opts,
    files: gen.files,
    primarySpecPath: gen.primarySpecPath,
    runId: gen.runId,
    domSnapshot,
    healFailures: false,
    maxRetries: 1,
    onLog: log,
  });

  return {
    passed: verified.passed,
    runId: gen.runId,
    files: verified.files,
    error: verified.error,
    primarySpecPath: verified.primarySpecPath,
    domSnapshot,
  };
}

/**
 * @deprecated Prefer step APIs. Full pipeline kept for compatibility.
 */
export async function runE2eModuleBatch(opts: {
  projectId: string;
  projectRoot: string;
  testCases: TestCase[];
  targetUrl: string;
  module: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  seedCommand?: string;
  teardownCommand?: string;
  usePlaywrightInspect?: boolean;
  showBrowser?: boolean;
  provider?: string | null;
  onLog?: (line: string) => void;
  onProgress?: (p: E2eBatchProgress) => void;
  waitIfPaused?: () => Promise<void>;
  /** Pre-inspected DOM — skip Inspect when set. */
  domSnapshot?: string;
}): Promise<{
  rows: E2eBatchItemResult[];
  okCount: number;
  files: E2EFileDto[];
}> {
  const log = (line: string) => opts.onLog?.(line);
  const progress = (p: E2eBatchProgress) => opts.onProgress?.(p);
  let domSnapshot = opts.domSnapshot || "";

  if (!domSnapshot) {
    progress({
      phase: "inspect",
      current: 0,
      total: opts.testCases.length,
      label: "Inspect Target URL…",
    });
    try {
      const inspected = await inspectE2eDom({
        targetUrl: opts.targetUrl,
        projectRoot: opts.projectRoot,
        usePlaywrightInspect: opts.usePlaywrightInspect,
        onLog: log,
      });
      domSnapshot = inspected.domSnapshot;
    } catch (e) {
      log(`  inspect warn: ${String(e)}\n`);
    }
  }

  const gen = await generateE2eBatch({
    ...opts,
    domSnapshot,
  });

  return verifyE2eModuleBatch({
    ...opts,
    files: gen.files,
    genItems: gen.genItems,
    domSnapshot,
    priorRows: gen.rows,
    healFailures: false,
    maxRetries: 1,
  });
}
