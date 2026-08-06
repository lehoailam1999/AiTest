/**
 * E2E job helpers — each phase is an independent function.
 * UI calls Inspect / Generate / Verify / Heal separately (no forced full pipeline).
 */
import { generateE2e, type E2EFileDto } from "../../api";
import type { TestCase } from "../../api/types";
import { createAsyncMutex, runPool } from "../runPool";
import { isTauri, readTextFile } from "../../tauri/bridge";
import { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env";
import {
  resolveE2eFeSources,
  createFeSourceListCache,
  hasFeGroundingHooks,
  attachSiblingFeTemplates,
  type FeSourceListCache,
} from "./resolveE2eFeSources";
import {
  e2eSpecPathsMatch,
  findSpecReportForPrimary,
} from "./e2eSpecPathMatch";
import { deriveAuthContextFromTestCase } from "./deriveAuthContextFromTc";
import { deriveFeaturePathFromTc } from "./deriveFeaturePathFromTc";
import { derivePomScaffoldFromTc } from "./derivePomScaffoldFromTc";
import {
  assertTcReadyForE2eGen,
  hasPathMarker,
  isUsableFeaturePath,
  mergeTcWithInferredFeaturePath,
} from "./assertTcReadyForE2eGen";
import {
  buildE2eRouteCatalog,
  matchFeaturePathFromCatalog,
  type E2eRouteCatalog,
} from "./e2eRouteCatalog";
import {
  createInspectDomCache,
  inspectCacheKey,
  isLikelyLoginTestCase,
  isLikelyLoginWallDom,
  type InspectDomCache,
} from "./inspectDomCache";
import {
  aggregateE2eMetrics,
  classifyE2eFailure,
  formatE2eMetricsReport,
  type E2eFailCategory,
  type E2eRunMetrics,
} from "./e2eFailureMetrics";
import {
  syncE2eModuleBatchCampaign,
  syncE2eVerifyReport,
  syncE2eWorkspaceRun,
} from "./auditSync";
import { newE2eRunId } from "./stagingApply";
import { enforceExecutionGateFailure } from "./executionGate";

/** Parallel oneshot / TC — default pool 3 (was 4) to cut Cursor/API wall-clock contention. */
const E2E_GEN_CONCURRENCY = 3;
/** Cursor oneshot is wall-clock heavy — keep pool smaller to cut stream timeouts. */
const E2E_GEN_CONCURRENCY_CURSOR = 2;

function e2eGenConcurrency(provider?: string | null): number {
  const p = (provider || "").toLowerCase();
  if (p.includes("cursor")) return E2E_GEN_CONCURRENCY_CURSOR;
  return E2E_GEN_CONCURRENCY;
}

function isLikelyPublicTestCase(tc: {
  title?: string | null;
  precondition?: string | null;
  steps?: string | null;
  testData?: string | null;
}): boolean {
  const blob = `${tc.title || ""}\n${tc.precondition || ""}\n${tc.steps || ""}\n${tc.testData || ""}`;
  return /public|guest|anonymous|không cần đăng nhập|không đăng nhập|without auth|no auth/i.test(
    blob
  );
}

function _collectAll(re: RegExp, text: string): string[] {
  const out: string[] = [];
  const local = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
  let m: RegExpExecArray | null;
  while ((m = local.exec(text)) !== null) {
    const v = (m[1] || "").trim();
    if (v) out.push(v);
  }
  return out;
}

function buildLocatorContract(opts: {
  sourceCode?: string;
  relatedSources?: { path: string; content: string }[];
  domSnapshot?: string;
  featurePath?: string;
  testCaseTitle?: string;
}): string {
  const feBlob = [opts.sourceCode || "", ...(opts.relatedSources || []).map((r) => r.content)].join(
    "\n"
  );
  const dataCy = _collectAll(/data-cy\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob);
  const dataTid = _collectAll(/data-testid\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob);
  const ids = _collectAll(/\sid\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob);
  const names = _collectAll(/\sname\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob);
  const formControls = [
    ..._collectAll(/formControlName\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob),
    ..._collectAll(/\[formControl(?:Name)?\]\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob),
    ..._collectAll(/formControlName\s*:\s*["'`]([^"'`]+)["'`]/gi, feBlob),
  ];
  const placeholders = _collectAll(/placeholder\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob);
  const matLabels = _collectAll(/<mat-label[^>]*>([^<]{1,80})<\/mat-label>/gi, feBlob);
  const routerLinks = [
    ..._collectAll(/routerLink\s*=\s*["'`]([^"'`]+)["'`]/gi, feBlob),
    // Angular: [routerLink]="['/admin/x']" or [routerLink]="['/admin/x', id, 'view']"
    ..._collectAll(/\[routerLink\]\s*=\s*\[["']([^"']+)["']/gi, feBlob),
  ].map((v) => (v.startsWith("/") ? v : `/${v}`));

  const domSelectors: string[] = [];
  const domNames: string[] = [];
  const domRoles: string[] = [];
  const domLabels: string[] = [];
  const domPlaceholders: string[] = [];
  try {
    const parsed = JSON.parse((opts.domSnapshot || "").trim() || "{}") as {
      elements?: Array<{
        name?: string;
        role?: string;
        label?: string;
        placeholder?: string;
        selector_candidates?: string[];
        test_id?: string;
        testId?: string;
        "data-cy"?: string;
        dataCy?: string;
      }>;
    };
    for (const el of parsed.elements || []) {
      if (typeof el.name === "string" && el.name.trim()) domNames.push(el.name.trim());
      if (typeof el.role === "string" && el.role.trim()) domRoles.push(el.role.trim());
      if (typeof el.label === "string" && el.label.trim()) domLabels.push(el.label.trim());
      if (typeof el.placeholder === "string" && el.placeholder.trim()) {
        domPlaceholders.push(el.placeholder.trim());
      }
      const tid = (el.test_id || el.testId || "").trim();
      if (tid) dataTid.push(tid);
      const cy = (el["data-cy"] || el.dataCy || "").trim();
      if (cy) dataCy.push(cy);
      for (const c of el.selector_candidates || []) {
        if (typeof c !== "string" || !c.trim()) continue;
        const s = c.trim();
        domSelectors.push(s);
        const cyM = s.match(/\[data-cy=["']([^"']+)["']\]/i);
        if (cyM?.[1]) dataCy.push(cyM[1]);
        const tidM = s.match(/\[data-testid=["']([^"']+)["']\]/i);
        if (tidM?.[1]) dataTid.push(tidM[1]);
        // Promote #id / formControlName from DOM candidates into hard allowlist buckets
        // (guard only validates those keys — not domCandidates lines).
        for (const idM of s.matchAll(/#([A-Za-z_][\w-]*)/g)) {
          if (idM[1]) ids.push(idM[1]);
        }
        const fcnM =
          s.match(/\[formControlName=["']([^"']+)["']\]/i) ||
          s.match(/formControlName=["']([^"']+)["']/i) ||
          s.match(/\[formControlName=([A-Za-z_][\w-]*)\]/i);
        if (fcnM?.[1]) formControls.push(fcnM[1]);
      }
    }
  } catch {
    // keep FE-only contract
  }

  const uniq = (arr: string[], limit: number) =>
    [...new Set(arr.map((s) => s.trim()).filter(Boolean))].slice(0, limit);

  const lines: string[] = [];
  if (opts.testCaseTitle) lines.push(`# TC: ${opts.testCaseTitle}`);
  if (opts.featurePath) lines.push(`featurePath: ${opts.featurePath}`);
  lines.push(`routes: ${uniq(routerLinks, 20).join(", ") || "(none)"}`);
  lines.push(`data-cy: ${uniq(dataCy, 40).join(", ") || "(none)"}`);
  lines.push(`data-testid: ${uniq(dataTid, 40).join(", ") || "(none)"}`);
  lines.push(`id: ${uniq(ids, 40).join(", ") || "(none)"}`);
  lines.push(`name: ${uniq(names, 30).join(", ") || "(none)"}`);
  lines.push(`formControlName: ${uniq(formControls, 30).join(", ") || "(none)"}`);
  lines.push(`placeholders: ${uniq(placeholders, 20).join(", ") || "(none)"}`);
  lines.push(`matLabels: ${uniq(matLabels, 20).join(", ") || "(none)"}`);
  lines.push(`domCandidates: ${uniq(domSelectors, 40).join(" | ") || "(none)"}`);
  lines.push(`domNames: ${uniq(domNames, 25).join(", ") || "(none)"}`);
  lines.push(`domRoles: ${uniq(domRoles, 20).join(", ") || "(none)"}`);
  lines.push(`domLabels: ${uniq(domLabels, 25).join(", ") || "(none)"}`);
  lines.push(`domPlaceholders: ${uniq(domPlaceholders, 20).join(", ") || "(none)"}`);
  return lines.join("\n");
}

/** True when contract has usable FE hooks or live DOM candidates (not all-none). */
export function locatorContractHasGrounding(contract: string): boolean {
  const text = contract || "";
  if (/data-(?:cy|testid):\s*(?!\(none\))\S/i.test(text)) return true;
  if (/formControlName:\s*(?!\(none\))\S/i.test(text)) return true;
  if (/^(?:id|name|placeholders|matLabels):\s*(?!\(none\))\S/im.test(text)) return true;
  if (/domCandidates:\s*(?!\(none\))\S/i.test(text)) return true;
  if (/domNames:\s*(?!\(none\))\S/i.test(text)) return true;
  if (/domLabels:\s*(?!\(none\))\S/i.test(text)) return true;
  if (/domPlaceholders:\s*(?!\(none\))\S/i.test(text)) return true;
  if (/routes:\s*(?!\(none\))\/\S/i.test(text)) return true;
  return false;
}

export type E2eBatchItemResult = {
  testCaseId: string;
  title: string;
  status: "ok" | "fail" | "pending" | "running" | "generated";
  runId?: string;
  error?: string;
  files?: number;
  /** Phase 4 — classified Verify failure */
  failCategory?: E2eFailCategory;
};

export type E2eBatchProgress = {
  phase: "inspect" | "generate" | "headless" | "heal" | "done";
  current: number;
  total: number;
  label: string;
  /** Row identity for parallel generate UI updates */
  testCaseId?: string;
  itemStatus?: "running" | "generated" | "fail";
};

export type E2eGenItem = {
  testCaseId: string;
  title: string;
  runId: string;
  primarySpecPath: string;
  files: E2EFileDto[];
  /** WHO role from TC authRole — injected as E2E_ROLE on Verify */
  authRole?: string;
  /** Feature entry path — injected as E2E_FEATURE_PATH on Verify */
  featurePath?: string;
  /** Inspect DOM used at Generate — prefer over warm-up cache on Verify/Heal */
  domSnapshot?: string;
  /** Phase 6 heal grounding — FE seed used at Generate */
  sourceFileName?: string;
  sourceCode?: string;
  relatedSources?: { path: string; content: string }[];
  locatorContract?: string;
};

/** Fired as soon as one TC finishes generate (success or fail) — enables live UI + pause→verify. */
export type E2eGenerateItemDone = {
  testCaseId: string;
  title: string;
  status: "generated" | "fail";
  row: E2eBatchItemResult;
  genItem?: E2eGenItem;
  filesSoFar: E2EFileDto[];
  done: number;
  total: number;
};

export type E2eInspectResult = {
  domSnapshot: string;
  elementCount: number;
  routeCount: number;
  source: string;
  routes?: string[];
  featurePath?: string;
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

/** Prefer Phase-3 / Error lines; drop Playwright JSON report noise for Phase 4. */
function _cleanVerifyErrorExcerpt(raw: string): string {
  let text = (raw || "")
    .replace(/\u001b\[[0-9;]*m/g, "")
    .replace(/\x1b\[[0-9;]*m/g, "")
    .replace(/\\u001b\[[0-9;]*m/g, "")
    .trim();
  if (!text) return "";
  // Unescape common JSON string fragments
  text = text.replace(/\\n/g, "\n").replace(/\\"/g, '"');
  const hit =
    text.match(/Phase 3: ungrounded POM stub[`'’\s\w.-]+/i) ||
    text.match(/Error:\s*Phase 3:[^\n"]+/i) ||
    text.match(/Error:\s*[^\n"]{10,200}/) ||
    text.match(/SyntaxError:[^\n"]+/i) ||
    text.match(/Cannot find module[^\n"]+/i) ||
    text.match(/expect\([^\n"]+/);
  if (hit) return hit[0].replace(/\s+/g, " ").trim().slice(0, 600);
  if (
    text.includes('"attachments"') ||
    text.includes('"errorLocation"') ||
    text.includes('"startTime"') ||
    text.includes('"threshold"') ||
    text.includes('"updateSnapshots"') ||
    text.includes('"config"') && text.includes('"projects"')
  ) {
    const buried =
      text.match(/Phase 3:[^"\\]+/i) ||
      text.match(/SyntaxError:[^"\\]+/i) ||
      text.match(/Cannot find module[^"\\]+/i) ||
      text.match(/Error:[^"\\]{10,180}/);
    if (buried) return buried[0].trim().slice(0, 600);
    return "Playwright FAIL (JSON report noise — mở error-context.md trong test-results)";
  }
  // Auth metadata comments are not the failure
  if (/^authRequired=/i.test(text) && text.length < 200) {
    return "FAIL (xem Log Verify — excerpt chỉ là auth metadata)";
  }
  return text.slice(-500);
}

function mergeFiles(into: E2EFileDto[], add: E2EFileDto[]): E2EFileDto[] {
  const by = new Map(into.map((f) => [f.path.replace(/\\/g, "/"), f]));
  for (const f of add) {
    by.set(f.path.replace(/\\/g, "/"), f);
  }
  return [...by.values()];
}

/** Step: Inspect DOM / Target URL + FE sources (Phase 1). Optional post-auth. */
export async function inspectE2eDom(opts: {
  targetUrl: string;
  projectRoot: string;
  usePlaywrightInspect?: boolean;
  /** Optional FE template to enrich selector_candidates when URL is login-wall only. */
  sourceCode?: string;
  sourcePaths?: string[] | { path: string; content: string }[];
  featurePath?: string;
  /** Project-relative or absolute; API falls back under AItest/E2ETest fixtures when missing */
  storageStateRel?: string;
  username?: string;
  password?: string;
  module?: string;
  role?: string;
  packagePrefix?: string | null;
  onLog?: (line: string) => void;
}): Promise<E2eInspectResult> {
  const log = (line: string) => opts.onLog?.(line);
  const post =
    opts.featurePath || opts.storageStateRel || (opts.username && opts.password);
  log(
    post
      ? `→ Inspect Target URL + FE${opts.featurePath ? ` → ${opts.featurePath}` : ""} (post-auth)…\n`
      : "→ Inspect Target URL + FE…\n"
  );
  const inspected = await generateE2e.inspect({
    targetUrl: opts.targetUrl,
    projectRoot: opts.projectRoot,
    usePlaywright: opts.usePlaywrightInspect,
    sourceCode: opts.sourceCode,
    sourcePaths: opts.sourcePaths,
    featurePath: opts.featurePath,
    storageStateRel: opts.storageStateRel,
    username: opts.username,
    password: opts.password,
    module: opts.module,
    role: opts.role,
    packagePrefix: opts.packagePrefix,
  });
  const elementCount = inspected.elements?.length ?? 0;
  const routeCount = inspected.routes?.length ?? 0;
  const storageUsed =
    (inspected as { storageStateUsed?: boolean }).storageStateUsed === true;
  log(
    `  elements=${elementCount} routes=${routeCount} source=${inspected.source}` +
      `${storageUsed ? " storageState=yes" : ""}\n`
  );
  return {
    domSnapshot: inspected.promptJson || "",
    elementCount,
    routeCount,
    source: inspected.source || "",
    routes: inspected.routes || [],
  };
}

/** Step: Generate POM + Spec for one TC (no Playwright Verify). */
export async function generateE2eForTestCase(opts: {
  projectId: string;
  projectRoot: string;
  testCase: TestCase;
  targetUrl: string;
  module?: string;
  requirementTitle?: string;
  /** Optional shared DOM — ignored when inspectPerTc is true */
  domSnapshot?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
  seedCommand?: string;
  teardownCommand?: string;
  existingFiles?: E2EFileDto[];
  provider?: string | null;
  /** Explicit Feature path override */
  featurePath?: string;
  /**
   * Project-relative storageState for Inspect. Prefer discovered AItest path;
   * API also searches when ``./fixtures/storageState.json`` is missing at root.
   */
  storageStateRel?: string;
  /**
   * Step 2 — Inspect for THIS TC (FE + featurePath) instead of a batch-shared DOM.
   * Default true. Same route/FE seed reuses opts.inspectCache.
   */
  inspectPerTc?: boolean;
  usePlaywrightInspect?: boolean;
  inspectCache?: InspectDomCache;
  /** Batch-shared FE listSourceFiles cache */
  feListCache?: FeSourceListCache;
  /**
   * Skip post-LLM ensure_auth_seed_roles on API when storage/artifact already ready.
   */
  skipAuthSeed?: boolean;
  /** Shared batch route catalog (routing files scanned once) */
  routeCatalog?: E2eRouteCatalog;
  onLog?: (line: string) => void;
}): Promise<{
  runId: string;
  files: E2EFileDto[];
  primarySpecPath: string;
  provider?: string | null;
  authRole?: string;
  featurePath?: string;
  domSnapshot?: string;
  sourceFileName?: string;
  sourceCode?: string;
  relatedSources?: { path: string; content: string }[];
  locatorContract?: string;
}> {
  const tc = opts.testCase;
  const runId = newE2eRunId(tc.id);
  // requirementTitle is the E2E {Req} segment; module is legacy fallback only
  const requirementTitle =
    opts.requirementTitle?.trim() || opts.module?.trim() || undefined;
  const moduleName = requirementTitle || tc.module || undefined;
  const log = (line: string) => opts.onLog?.(line);
  const authCtx = deriveAuthContextFromTestCase(tc);
  let sourceFileName: string | undefined;
  let sourceCode: string | undefined;
  let relatedSources: { path: string; content: string }[] | undefined;
  let phase5Planner: Record<string, unknown> | undefined;
  let phase5IndexVersion: string | undefined;
  let phase5FeaturePathHint: string | undefined;
  // Phase 4: prefer Code Index → Retrieve → budgeted FE context
  try {
    if (isTauri()) {
      const { createTauriCodeIndexIo } = await import("../codeIndex/tauriIo");
      const { buildIndexBackedContext } = await import("../contextBuilder");
      const { isUnsuitableE2ePrimary } = await import("../retrieval/rankScore");
      const built = await buildIndexBackedContext({
        projectRoot: opts.projectRoot,
        testCase: tc,
        io: createTauriCodeIndexIo(),
        // Sync index when missing so Gen maps TC→FE without manual Index step
        syncIfMissing: true,
        forceTestType: "E2E",
      });
      phase5Planner = built.plan as unknown as Record<string, unknown>;
      phase5IndexVersion = built.snapshot.meta.schema;
      phase5FeaturePathHint = isUsableFeaturePath(built.plan.hints.featurePath)
        ? built.plan.hints.featurePath!.trim()
        : undefined;
      if (built.plan.hints.featurePath && !phase5FeaturePathHint) {
        log(
          `  fe-context(index): ignore unusable plan.featurePath=${built.plan.hints.featurePath}\n`
        );
      }
      const primaryOk =
        built.e2eFe?.sourceFileName &&
        built.e2eFe?.sourceCode &&
        !isUnsuitableE2ePrimary(built.e2eFe.sourceFileName);
      if (primaryOk && built.e2eFe) {
        sourceFileName = built.e2eFe.sourceFileName;
        sourceCode = built.e2eFe.sourceCode;
        relatedSources = built.e2eFe.relatedSources;
        for (const n of built.e2eFe.notes) log(`  fe-context(index): ${n}\n`);
        if (built.plan.hints.featurePath) {
          log(`  plan.featurePath=${built.plan.hints.featurePath}\n`);
        }
      } else if (built.e2eFe?.sourceFileName) {
        log(
          `  fe-context(index): unsuitable primary=${built.e2eFe.sourceFileName} — fallback legacy FE resolve\n`
        );
      } else {
        log("  fe-context(index): empty — fallback legacy FE resolve\n");
      }
    }
  } catch (e) {
    log(`  fe-context(index) warn: ${String(e)}\n`);
  }
  if (!sourceCode) {
    try {
      const fe = await resolveE2eFeSources({
        projectRoot: opts.projectRoot,
        testCase: tc,
        listCache: opts.feListCache,
      });
      if (fe) {
        sourceFileName = fe.sourceFileName;
        sourceCode = fe.sourceCode;
        relatedSources = fe.relatedSources;
        for (const n of fe.notes) log(`  fe-context: ${n}\n`);
      } else {
        log("  fe-context: (none — DOM/TC only)\n");
      }
    } catch (e) {
      log(`  fe-context warn: ${String(e)}\n`);
    }
  }

  // Angular: locators live in .component.html — attach sibling when primary is .ts
  if (sourceFileName && isTauri()) {
    try {
      const withTpl = await attachSiblingFeTemplates({
        projectRoot: opts.projectRoot,
        sourceFileName,
        relatedSources: relatedSources || [],
        actionHint: [tc.title, tc.module, tc.steps, tc.testData].filter(Boolean).join("\n"),
      });
      relatedSources = withTpl.relatedSources;
      for (const n of withTpl.notes) log(`  ${n}\n`);
    } catch (e) {
      log(`  fe-template sibling warn: ${String(e)}\n`);
    }
  }

  const fePaths = [
    sourceFileName || "",
    ...(relatedSources || []).map((r) => r.path),
  ].filter(Boolean);
  let featurePath =
    (isUsableFeaturePath(opts.featurePath) ? opts.featurePath!.trim() : undefined) ||
    phase5FeaturePathHint ||
    deriveFeaturePathFromTc({
      title: tc.title,
      precondition: tc.precondition,
      testData: tc.testData,
      steps: tc.steps,
      feSource: [sourceCode || "", ...(relatedSources || []).map((r) => r.content)].join(
        "\n"
      ),
      feFilePaths: fePaths,
    }) ||
    undefined;
  if (featurePath && !isUsableFeaturePath(featurePath)) {
    log(`  featurePath ignored (placeholder/invalid)=${featurePath}\n`);
    featurePath = undefined;
  }
  // Soft path: single routerLink from FE when TC forgot path:
  if (!featurePath && sourceCode) {
    const links = [
      ..._collectAll(/routerLink\s*=\s*["'`]([^"'`]+)["'`]/gi, sourceCode),
      ..._collectAll(/path:\s*['"`]([^'"`]+)['"`]/gi, sourceCode),
    ]
      .map((v) => (v.startsWith("/") ? v : `/${v}`).replace(/\/{2,}/g, "/"))
      .filter((v) => v.length > 1 && !/^\/(login|signin|auth|register)$/i.test(v));
    const uniqLinks = [...new Set(links)];
    if (uniqLinks.length === 1) {
      featurePath = uniqLinks[0];
      log(`  featurePath(from FE routerLink)=${featurePath}\n`);
    }
  }
  let catalogMatched = false;
  if (!featurePath && opts.routeCatalog?.routes.length) {
    const match = matchFeaturePathFromCatalog(tc, opts.routeCatalog);
    if (match.ambiguous) {
      const optsList = match.candidates
        .map((c) => `${c.path} (score=${c.score})`)
        .join(", ");
      throw new Error(
        "E2E_GROUNDING: ambiguous featurePath — chọn 1 route trong testData `path:`: " +
          optsList
      );
    }
    if (match.path) {
      featurePath = match.path;
      catalogMatched = true;
      log(
        `  featurePath(from route-catalog score=${match.score})=${featurePath}\n`
      );
    }
  }
  if (featurePath) log(`  featurePath=${featurePath}\n`);
  else log(`  featurePath=(none yet — guard may bake from Spec comments)\n`);
  const loginTc = isLikelyLoginTestCase(tc);
  const publicTc = isLikelyPublicTestCase(tc);
  const hasFeHooks = hasFeGroundingHooks(sourceCode, relatedSources);

  // DoR after source resolve: any usable featurePath satisfies path requirement.
  const inferredPathSource = phase5FeaturePathHint
    ? "code-index"
    : catalogMatched
      ? "route-catalog"
      : featurePath
        ? "fe-source"
        : opts.featurePath?.trim()
          ? "override"
          : undefined;
  if (featurePath && !hasPathMarker(tc) && inferredPathSource) {
    log(
      `  testData enrich: featurePath=${featurePath} (from ${inferredPathSource})\n`
    );
  }
  const tcForGate = mergeTcWithInferredFeaturePath(
    tc,
    featurePath,
    inferredPathSource || "FE source"
  );
  assertTcReadyForE2eGen(tcForGate, {
    inferredFeaturePath: featurePath,
    // Path inferred from FE/index/catalog is enough — do not require testData marker first.
    allowInferredPath: Boolean(featurePath),
  });

  // Step-1 gate: avoid blind codegen from TC text only.
  if (!sourceCode && !loginTc && !publicTc) {
    throw new Error(
      "E2E_GROUNDING: skip codegen — không resolve được FE source từ TC/path. " +
        "Hãy thêm `path: /...` vào testData hoặc mở đúng projectRoot để auto-map file."
    );
  }
  if (!featurePath && !hasFeHooks && !loginTc && !publicTc) {
    throw new Error(
      "E2E_GROUNDING: skip codegen — thiếu featurePath và FE hook (data-cy/testid/route). " +
        "Bổ sung `path: /...` hoặc tăng quality FE seed trước khi Generate."
    );
  }

  const inspectPerTc = opts.inspectPerTc !== false;
  let domSnapshot = inspectPerTc ? "" : opts.domSnapshot || "";

  if (inspectPerTc) {
    const cache = opts.inspectCache || createInspectDomCache();
    const key = inspectCacheKey({
      targetUrl: opts.targetUrl,
      featurePath,
      feSeed: sourceFileName,
    });
    try {
      const { entry, fromCache } = await cache.getOrFetch(key, async () => {
        const sourcePaths = sourceCode
          ? [
              { path: sourceFileName || "fe", content: sourceCode },
              ...(relatedSources || []),
            ]
          : undefined;
        const inspected = await inspectE2eDom({
          targetUrl: opts.targetUrl,
          projectRoot: opts.projectRoot,
          usePlaywrightInspect: opts.usePlaywrightInspect,
          sourceCode,
          sourcePaths,
          featurePath,
          username: opts.username,
          password: opts.password,
          storageStateRel:
            opts.storageStateRel?.trim() ||
            (opts.useStorageState ? "./fixtures/storageState.json" : undefined),
          module: moduleName,
          role: authCtx.role,
          onLog: log,
        });
        return {
          domSnapshot: inspected.domSnapshot,
          elementCount: inspected.elementCount,
          routeCount: inspected.routeCount,
          source: inspected.source,
          routes: inspected.routes || [],
          loginWall: isLikelyLoginWallDom(inspected.domSnapshot),
        };
      });
      if (fromCache) {
        log(
          `  inspect cache hit path=${featurePath || "(none)"} fe=${sourceFileName || "—"} elements=${entry.elementCount}\n`
        );
      }
      domSnapshot = entry.domSnapshot;
      if (
        entry.loginWall &&
        featurePath &&
        !loginTc &&
        !publicTc
      ) {
        log(
          `  inspect warn: DOM still looks like login wall for feature TC «${tc.title}» ` +
            `(path=${featurePath}) — auth/storage may be wrong\n`
        );
        // Do not ship login-wall as grounding for feature controls
        domSnapshot = "";
        const hasAuth =
          Boolean(opts.storageStateRel?.trim()) ||
          Boolean((opts.username || "").trim() && (opts.password || "").trim()) ||
          Boolean(opts.useStorageState);
        // Gen may proceed from FE hooks alone (data-cy / formControl / routerLink).
        // Auth is required for Inspect DOM + Verify — not a hard block on Generate.
        if (!hasFeHooks) {
          throw new Error(
            "E2E_GROUNDING: Inspect vẫn là màn login và FE không có data-cy/testid/route. " +
              (hasAuth
                ? "Sửa storageState/role hoặc thêm hooks trên FE — không Gen mù."
                : "Chạy Auth Discover / nhập E2E_USERNAME+PASSWORD, hoặc đảm bảo FE seed có data-cy (sibling .html).")
          );
        }
        log(
          hasAuth
            ? "  inspect: Gen chỉ dựa FE hooks (DOM cleared) — Verify cần auth đúng để pass\n"
            : "  inspect: chưa auth — Gen FE-only (DOM cleared). Verify sẽ cần Auth Discover / credentials\n"
        );
      }
      // E2E_GROUNDING: login wall + no path + thin FE → fail early (no blind Spec).
      if (
        entry.loginWall &&
        !loginTc &&
        !featurePath &&
        !hasFeHooks
      ) {
        throw new Error(
          "E2E_GROUNDING: skip codegen — Inspect hit login wall, no featurePath, " +
            "and FE has no data-cy/testid/route hooks. Add `path: /…` on TC testData " +
            "or fix auth/storageState before Generate."
        );
      }
    } catch (e) {
      log(`  inspect-per-tc warn: ${String(e)}\n`);
      // Re-throw grounding skips so batch marks FAIL with actionable message.
      if (String(e).includes("E2E_GROUNDING:")) throw e;
      domSnapshot = opts.domSnapshot || "";
    }
  }

  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: moduleName,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    roleCredentials: opts.roleCredentials,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
    role: authCtx.role,
    featurePath,
  });
  const locatorContract = buildLocatorContract({
    sourceCode,
    relatedSources,
    domSnapshot,
    featurePath,
    testCaseTitle: tc.title,
  });
  if (
    !loginTc &&
    !publicTc &&
    !locatorContractHasGrounding(locatorContract)
  ) {
    throw new Error(
      "E2E_GROUNDING: locator contract trống (không testid/data-cy/DOM candidates). " +
        "Thêm data-testid trên FE, hoặc sửa auth để Inspect lấy được DOM feature, " +
        "hoặc bổ sung `path: /…` + FE có routerLink."
    );
  }
  // Soft scaffold only when FE hooks exist — avoid inventing verbs from TC prose alone
  const pomScaffold = hasFeHooks
    ? derivePomScaffoldFromTc({
        testCase: tc,
        featurePath,
      })
    : "";
  log(
    `  locator-contract: hooks=${hasFeHooks ? "yes" : "no"} ` +
      `grounded=${locatorContractHasGrounding(locatorContract) ? "yes" : "no"} ` +
      `chars=${locatorContract.length}\n`
  );
  log(
    `  pom-scaffold: ${pomScaffold ? `chars=${pomScaffold.length}` : "skipped (no FE hooks)"}\n`
  );

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
    domSnapshot: domSnapshot || undefined,
    sourceFileName,
    sourceCode,
    relatedSources,
    module: moduleName,
    requirementTitle: requirementTitle || undefined,
    projectRoot: opts.projectRoot,
    storageStateRel: env.storageStateRel,
    seedCommand: env.seedCommand,
    teardownCommand: env.teardownCommand,
    existingFiles: opts.existingFiles,
    executionContext: authCtx.executionContext || undefined,
    featurePath: featurePath || undefined,
    locatorContract,
    pomScaffold: pomScaffold || undefined,
    skipAuthSeed: opts.skipAuthSeed,
    // Desktop already inspected (may have cleared login-wall) — API must not refill
    skipAutoInspect: true,
    ...(phase5Planner ? { planner: phase5Planner } : {}),
    ...(phase5IndexVersion ? { indexVersion: phase5IndexVersion } : {}),
  });
  const files = gen.files || [];
  const primarySpecPath =
    gen.primarySpecPath ||
    files.find((f) => f.kind === "spec" || /specs\//.test(f.path))?.path ||
    "";
  // Refine from Spec comments after Generate (AI often writes Feature entry: /admin/…)
  let resolvedFeaturePath = featurePath;
  if (!resolvedFeaturePath && files.length) {
    resolvedFeaturePath = deriveFeaturePathFromTc({
      title: tc.title,
      precondition: tc.precondition,
      testData: tc.testData,
      steps: tc.steps,
      specSource: files.map((f) => `${f.path}\n${f.content || ""}`).join("\n"),
      feSource: [sourceCode || "", ...(relatedSources || []).map((r) => r.content)].join(
        "\n"
      ),
      feFilePaths: fePaths,
    });
    if (resolvedFeaturePath) {
      log(`  featurePath(from Spec/FE)=${resolvedFeaturePath}\n`);
    }
  }
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
    authRole: authCtx.role,
    featurePath: resolvedFeaturePath || undefined,
    domSnapshot: domSnapshot || undefined,
    sourceFileName,
    sourceCode,
    relatedSources,
    locatorContract,
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
  /** @deprecated Step 2 — ignored when inspectPerTc (default). Kept for single-call callers. */
  domSnapshot?: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
  seedCommand?: string;
  teardownCommand?: string;
  provider?: string | null;
  /** Explicit Feature path override for all TCs — leave empty for per-TC derive */
  featurePath?: string;
  /** Discovered storageState under AItest (Inspect post-auth) */
  storageStateRel?: string;
  /** Step 2 — default true: Inspect per TC/route (shared cache by path+FE) */
  inspectPerTc?: boolean;
  usePlaywrightInspect?: boolean;
  /** Skip API auth-seed when Desktop already has storage/artifact */
  skipAuthSeed?: boolean;
  onLog?: (line: string) => void;
  onProgress?: (p: E2eBatchProgress) => void;
  /** Called under merge lock after each TC — flush rows/files to UI immediately. */
  onItemDone?: (payload: E2eGenerateItemDone) => void;
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
    roleCredentials: opts.roleCredentials,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
    role: deriveAuthContextFromTestCase(cases[0] || {}).role,
    featurePath: opts.featurePath,
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
  const inspectPerTc = opts.inspectPerTc !== false;
  const inspectCache = createInspectDomCache();
  const feListCache = createFeSourceListCache();
  // Pause control is cooperative between items. To keep semantics predictable
  // ("current TC finishes, next TC waits"), force sequential mode when a
  // pause gate is provided by UI.
  const concurrency = opts.waitIfPaused ? 1 : e2eGenConcurrency(opts.provider);

  // Parallel codegen: auth seed is serialized server-side (per-role locks).
  // Each TC still gets its own chat/request; POM API snapshot is merge-locked below.
  log(
    inspectPerTc
      ? `→ Generate batch parallel ×${Math.min(concurrency, total)} · ${total} TC · Inspect per route/FE (cache shared)` +
        `${opts.waitIfPaused ? " · pause-safe sequential gate" : ""}\n`
      : `→ Generate batch parallel ×${Math.min(concurrency, total)} · ${total} TC (shared DOM)` +
        `${opts.waitIfPaused ? " · pause-safe sequential gate" : ""}\n`
  );

  let routeCatalog: E2eRouteCatalog | undefined;
  try {
    const { paths, fromCache } = await feListCache.getPaths(opts.projectRoot);
    routeCatalog = await buildE2eRouteCatalog({
      paths,
      readFile: async (pathRel) =>
        readTextFile(opts.projectRoot, pathRel.replace(/\\/g, "/")),
    });
    log(
      `  route-catalog: ${routeCatalog.routes.length} routes from ${routeCatalog.sources.length} files` +
        `${fromCache ? " (path list cache)" : ""}\n`
    );
  } catch (e) {
    log(`  route-catalog warn: ${String(e)}\n`);
  }

  await runPool(
    cases,
    concurrency,
    async (tc, i) => {
      await mergeLock.run(() => {
        rows[i] = { ...rows[i], status: "running" };
        progress({
          phase: "generate",
          current: done,
          total,
          label: `Generate: ${tc.title}`,
          testCaseId: tc.id,
          itemStatus: "running",
        });
      });

      // Snapshot POM pages under lock so parallel workers don't race merge;
      // each generate still binds API to this tc.id → files map về đúng TC.
      const existingPages = await mergeLock.run(() =>
        allFiles
          .filter((f) => f.kind === "page" || /\/pages\//.test(f.path))
          .slice(0, 6)
      );

      try {
        const gen = await generateE2eForTestCase({
          projectId: opts.projectId,
          projectRoot: opts.projectRoot,
          testCase: tc,
          targetUrl: env.targetUrl,
          module: opts.module,
          requirementTitle: opts.requirementTitle,
          domSnapshot: inspectPerTc ? undefined : opts.domSnapshot,
          useStorageState: opts.useStorageState,
          username: opts.username,
          password: opts.password,
          seedCommand: opts.seedCommand,
          teardownCommand: opts.teardownCommand,
          existingFiles: existingPages,
          provider: opts.provider,
          featurePath: opts.featurePath,
          storageStateRel: opts.storageStateRel,
          inspectPerTc,
          usePlaywrightInspect: opts.usePlaywrightInspect,
          inspectCache,
          feListCache,
          skipAuthSeed: opts.skipAuthSeed,
          routeCatalog,
          onLog: log,
        });
        // Paths đã resolve theo Requirement/TC trên BE; giữ đúng file của request này.
        const ownedFiles = gen.files;
        await mergeLock.run(() => {
          allFiles = mergeFiles(allFiles, ownedFiles);
          const genItem: E2eGenItem = {
            testCaseId: tc.id,
            title: tc.title,
            runId: gen.runId,
            primarySpecPath: gen.primarySpecPath,
            files: ownedFiles,
            authRole: gen.authRole,
            featurePath: gen.featurePath,
            domSnapshot: gen.domSnapshot,
            sourceFileName: gen.sourceFileName,
            sourceCode: gen.sourceCode,
            relatedSources: gen.relatedSources,
            locatorContract: gen.locatorContract,
          };
          genItemsSlot[i] = genItem;
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
            label: `Đã gen «${tc.title}» (${done}/${total})`,
            testCaseId: tc.id,
            itemStatus: "generated",
          });
          opts.onItemDone?.({
            testCaseId: tc.id,
            title: tc.title,
            status: "generated",
            row: rows[i],
            genItem,
            filesSoFar: [...allFiles],
            done,
            total,
          });
        });
        log(`  ✓ gen OK [${tc.title}] · ${ownedFiles.length} file · ${done}/${total}\n`);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await mergeLock.run(() => {
          rows[i] = { ...rows[i], status: "fail", error: msg };
          done += 1;
          progress({
            phase: "generate",
            current: done,
            total,
            label: `Gen lỗi «${tc.title}» (${done}/${total})`,
            testCaseId: tc.id,
            itemStatus: "fail",
          });
          opts.onItemDone?.({
            testCaseId: tc.id,
            title: tc.title,
            status: "fail",
            row: rows[i],
            filesSoFar: [...allFiles],
            done,
            total,
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
  /** Project-relative storageState for Inspect heal re-inspect */
  storageStateRel?: string;
  username?: string;
  password?: string;
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
  seedCommand?: string;
  teardownCommand?: string;
  showBrowser?: boolean;
  provider?: string | null;
  /** When true, AI heal failed specs (maxRetries ≥ 2). Default false for Verify-only. */
  healFailures?: boolean;
  maxRetries?: number;
  featurePath?: string;
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
  /** Phase 4 — pass rate + fail % by category */
  metrics: E2eRunMetrics;
}> {
  const log = (line: string) => opts.onLog?.(line);
  const progress = (p: E2eBatchProgress) => opts.onProgress?.(p);
  const showBrowser = opts.showBrowser !== false;
  const healFailures = Boolean(opts.healFailures);
  // Heal needs attempt 1 fail + attempt 2 with AI — maxRetries must be ≥ 2
  const maxRetries = healFailures
    ? Math.max(2, opts.maxRetries ?? 2)
    : Math.max(1, opts.maxRetries ?? 1);
  const generatedOk = opts.genItems.filter((g) => g.primarySpecPath);
  // Prefer per-TC Inspect from Generate over a shared warm-up cache
  const perTcDom = generatedOk.find((g) => (g.domSnapshot || "").trim())?.domSnapshot;
  const domSnapshot = (perTcDom || opts.domSnapshot || "").trim();
  // Suite E2E_FEATURE_PATH: shared path, or infer from Spec comments when genItems lack it.
  let distinctPaths = [
    ...new Set(
      generatedOk
        .map((g) => (g.featurePath || "").trim())
        .filter(Boolean)
    ),
  ];
  if (distinctPaths.length === 0 && opts.files.length) {
    const inferred = deriveFeaturePathFromTc({
      title: opts.module,
      specSource: opts.files.map((f) => `${f.path}\n${f.content || ""}`).join("\n"),
    });
    if (inferred) {
      distinctPaths = [inferred];
      log(`  featurePath(inferred from Spec)=${inferred}\n`);
      for (const g of generatedOk) {
        if (!(g.featurePath || "").trim()) g.featurePath = inferred;
      }
    }
  }
  const sharedFeaturePath =
    distinctPaths.length === 1
      ? distinctPaths[0]
      : distinctPaths.length === 0
        ? opts.featurePath?.trim() || undefined
        : undefined;
  if (distinctPaths.length > 1) {
    log(
      `  featurePath: ${distinctPaths.length} distinct paths — omit suite E2E_FEATURE_PATH (use baked per Spec)\n`
    );
  } else if (sharedFeaturePath) {
    log(`  featurePath(suite)=${sharedFeaturePath}\n`);
  }
  if (domSnapshot) {
    log(
      perTcDom
        ? `  domSnapshot: using per-TC Inspect from Generate (${domSnapshot.length} chars)\n`
        : `  domSnapshot: warm-up/shared cache (${domSnapshot.length} chars)\n`
    );
  } else {
    log(`  domSnapshot: (empty — will re-inspect before heal if needed)\n`);
  }

  // Before Heal: re-inspect feature DOM when Gen cleared login-wall / empty snapshot
  if (healFailures) {
    for (const g of generatedOk) {
      if ((g.domSnapshot || "").trim()) continue;
      const fp = (g.featurePath || sharedFeaturePath || "").trim();
      if (!fp && !g.sourceCode) continue;
      try {
        log(`  heal re-inspect: ${g.title} path=${fp || "(none)"}\n`);
        const inspected = await inspectE2eDom({
          targetUrl: opts.targetUrl,
          projectRoot: opts.projectRoot,
          usePlaywrightInspect: true,
          sourceCode: g.sourceCode,
          sourcePaths: g.sourceCode
            ? [
                { path: g.sourceFileName || "fe", content: g.sourceCode },
                ...(g.relatedSources || []),
              ]
            : undefined,
          featurePath: fp || undefined,
          username: opts.username,
          password: opts.password,
          storageStateRel:
            opts.storageStateRel?.trim() ||
            (opts.useStorageState ? "./fixtures/storageState.json" : undefined),
          module: opts.module,
          role: g.authRole,
          onLog: log,
        });
        if (
          inspected.domSnapshot &&
          !isLikelyLoginWallDom(inspected.domSnapshot)
        ) {
          g.domSnapshot = inspected.domSnapshot;
          g.locatorContract = buildLocatorContract({
            sourceCode: g.sourceCode,
            relatedSources: g.relatedSources,
            domSnapshot: g.domSnapshot,
            featurePath: fp,
            testCaseTitle: g.title,
          });
          log(`  heal re-inspect OK elements≈DOM grounded\n`);
        } else {
          log(`  heal re-inspect: still login-wall or empty — keep FE-only grounding\n`);
        }
      } catch (e) {
        log(`  heal re-inspect warn: ${String(e)}\n`);
      }
    }
  }

  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: opts.module,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    roleCredentials: opts.roleCredentials,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
    role:
      generatedOk[0]?.authRole ||
      opts.genItems.find((g) => g.authRole)?.authRole,
    featurePath: sharedFeaturePath,
  });
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
    const emptyRows = rows.map((r) =>
      r.status === "running" || r.status === "generated" || r.status === "pending"
        ? { ...r, status: "fail" as const, error: "Chưa có file Generate" }
        : r
    );
    const metrics = aggregateE2eMetrics(emptyRows);
    return {
      rows: emptyRows,
      okCount: 0,
      files: opts.files,
      moduleStatus: "FAILED",
      metrics,
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
      ? `→ Heal failed specs (maxRetries=${maxRetries}) — tuần tự ×1…\n`
      : showBrowser
        ? `→ Verify module (${generatedOk.length} TC) — tuần tự ×1 worker, Chromium…\n`
        : `→ Verify module (${generatedOk.length} TC) — tuần tự ×1 worker…\n`
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
      domSnapshot: domSnapshot || undefined,
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
        domSnapshot: g.domSnapshot,
        featurePath: g.featurePath,
        sourceFileName: g.sourceFileName,
        sourceCode: g.sourceCode,
        relatedSources: g.relatedSources,
        locatorContract: g.locatorContract,
      })),
    });
    moduleStatus = mod.status;
    log(`  module-status=${mod.status}\n`);
    const failSpecs = (mod.specs || []).filter((s) => !s.success);
    if (failSpecs.length > 0 || moduleStatus !== "PASSED") {
      log(`  --- Nguyên nhân Verify FAIL (${failSpecs.length} spec) ---\n`);
      for (const s of failSpecs) {
        const excerpt = _cleanVerifyErrorExcerpt(
          (s.errorExcerpt || "").trim() || (mod.log || "")
        ) || "(không có errorExcerpt)";
        log(`  ✗ ${s.specPath}\n`);
        log(`    ${excerpt}\n`);
      }
      const tail = _cleanVerifyErrorExcerpt(mod.log || "");
      if (tail && !failSpecs.some((s) => (s.errorExcerpt || "").includes("Phase 3"))) {
        log(`  --- Playwright log (tóm tắt) ---\n`);
        log(`  ${tail}\n`);
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
      const soleFallback = generatedOk.length === 1;
      const resolved = findSpecReportForPrimary(
        g.primarySpecPath,
        (mod.specs || []).map((s) => ({
          specPath: s.specPath,
          success: s.success,
          errorExcerpt: s.errorExcerpt,
        })),
        { soleTcFallback: soleFallback }
      );
      log(
        `  map: primary=${g.primarySpecPath} ↔ report=${resolved?.specPath || "(none)"}\n`
      );
      let passed = false;
      let err: string | undefined;
      if (resolved) {
        const sp = resolved.specPath.replace(/\\/g, "/");
        passed =
          !!resolved.success ||
          healedPass.has(sp) ||
          healedPass.has(sp.split("/").pop() || "");
        if (!passed) {
          for (const h of healList) {
            const hp = h.specPath.replace(/\\/g, "/");
            if (
              (e2eSpecPathsMatch(hp, sp) ||
                hp.endsWith(sp.split("/").pop() || "")) &&
              h.status === "PASSED"
            ) {
              passed = true;
              break;
            }
          }
        }
        err = passed
          ? undefined
          : resolved.errorExcerpt?.slice(0, 1200) ||
            healList.find((h) =>
              e2eSpecPathsMatch(h.specPath, sp)
            )?.errorLog?.slice(0, 1200) ||
            _cleanVerifyErrorExcerpt(mod.log || "") ||
            "FAIL";
        if (!passed) err = enforceExecutionGateFailure(err);
      } else {
        // Unmapped: if exactly one failing report exists, surface its excerpt.
        const fails = (mod.specs || []).filter((s) => !s.success);
        const fallbackExcerpt =
          fails.length === 1
            ? fails[0].errorExcerpt?.slice(0, 1200)
            : undefined;
        passed = false;
        err =
          fallbackExcerpt ||
          "FAIL — không map được spec trong báo cáo Verify batch";
        err = enforceExecutionGateFailure(err);
        if (fallbackExcerpt) {
          log(
            `  map warn: unmapped primary — using sole failing excerpt\n`
          );
        }
      }

      rows[idx] = {
        ...rows[idx],
        status: passed ? "ok" : "fail",
        error: err,
        failCategory: passed ? undefined : classifyE2eFailure(err),
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
        rows[idx] = {
          ...rows[idx],
          status: "fail",
          error: enforceExecutionGateFailure(msg),
          failCategory: classifyE2eFailure(enforceExecutionGateFailure(msg)),
        };
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
      const err = rows[i].error || "Verify incomplete";
      rows[i] = {
        ...rows[i],
        status: "fail",
        error: enforceExecutionGateFailure(err),
        failCategory: classifyE2eFailure(enforceExecutionGateFailure(err)),
      };
    }
  }

  const okCount = rows.filter((r) => r.status === "ok").length;
  const metrics = aggregateE2eMetrics(rows);
  progress({
    phase: "done",
    current: total,
    total,
    label: `Done ${okCount}/${rows.length}`,
  });
  log(
    `→ ${healFailures ? "Heal" : "Verify"} done: ${okCount}/${rows.length} PASS (module=${moduleStatus})\n`
  );
  log(`${formatE2eMetricsReport(metrics)}\n`);

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

  return { rows, okCount, files: allFiles, moduleStatus, metrics };
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
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
  seedCommand?: string;
  teardownCommand?: string;
  showBrowser?: boolean;
  provider?: string | null;
  healFailures?: boolean;
  maxRetries?: number;
  featurePath?: string;
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
  const featurePath =
    opts.featurePath?.trim() ||
    deriveFeaturePathFromTc({
      title: tc.title,
      precondition: tc.precondition,
      testData: tc.testData,
      steps: tc.steps,
    });
  const env = buildE2EEnvConfig({
    targetUrl: opts.targetUrl,
    module: moduleName,
    useStorageState: opts.useStorageState,
    username: opts.username,
    password: opts.password,
    roleCredentials: opts.roleCredentials,
    seedCommand: opts.seedCommand,
    teardownCommand: opts.teardownCommand,
    role: deriveAuthContextFromTestCase(tc).role,
    featurePath,
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
    const errBody = _cleanVerifyErrorExcerpt(
      (sandbox.errorLog || "").trim() || (sandbox as { log?: string }).log || ""
    );
    if (errBody) {
      log(`  ${errBody}\n`);
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
 * Kept for callers that still want one-shot pipeline — Phase 1 FE + featurePath wired.
 */
export async function runE2eJobForTestCase(opts: {
  projectId: string;
  projectRoot: string;
  testCase: TestCase;
  targetUrl: string;
  useStorageState?: boolean;
  username?: string;
  password?: string;
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
  seedCommand?: string;
  teardownCommand?: string;
  usePlaywrightInspect?: boolean;
  showBrowser?: boolean;
  provider?: string | null;
  featurePath?: string;
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
  let featurePath = opts.featurePath?.trim() || undefined;
  let sourceCode: string | undefined;
  let sourcePaths: { path: string; content: string }[] | undefined;
  try {
    const fe = await resolveE2eFeSources({
      projectRoot: opts.projectRoot,
      testCase: opts.testCase,
    });
    if (fe) {
      sourceCode = fe.sourceCode;
      sourcePaths = [
        { path: fe.sourceFileName, content: fe.sourceCode },
        ...fe.relatedSources,
      ];
      featurePath =
        featurePath ||
        deriveFeaturePathFromTc({
          title: opts.testCase.title,
          precondition: opts.testCase.precondition,
          testData: opts.testCase.testData,
          steps: opts.testCase.steps,
          feSource: [fe.sourceCode, ...fe.relatedSources.map((r) => r.content)].join(
            "\n"
          ),
        });
    }
  } catch (e) {
    log(`  fe-context warn: ${String(e)}\n`);
  }
  if (!opts.skipInspect) {
    try {
      const inspected = await inspectE2eDom({
        targetUrl: opts.targetUrl,
        projectRoot: opts.projectRoot,
        usePlaywrightInspect: opts.usePlaywrightInspect,
        sourceCode,
        sourcePaths,
        featurePath,
        username: opts.username,
        password: opts.password,
        storageStateRel: opts.useStorageState
          ? "./fixtures/storageState.json"
          : undefined,
        module: opts.testCase.module || undefined,
        onLog: log,
      });
      domSnapshot = inspected.domSnapshot;
      if (!featurePath && inspected.routes?.length) {
        featurePath = deriveFeaturePathFromTc({
          title: opts.testCase.title,
          precondition: opts.testCase.precondition,
          testData: opts.testCase.testData,
          steps: opts.testCase.steps,
          routes: inspected.routes,
          feSource: sourceCode,
        });
      }
    } catch (e) {
      log(`  inspect warn: ${String(e)}\n`);
    }
  } else {
    log("→ Inspect skipped\n");
  }

  const gen = await generateE2eForTestCase({
    ...opts,
    domSnapshot,
    featurePath,
    onLog: log,
  });

  const verified = await verifyE2eForTestCase({
    ...opts,
    files: gen.files,
    primarySpecPath: gen.primarySpecPath,
    runId: gen.runId,
    domSnapshot,
    featurePath: gen.featurePath || featurePath,
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
  /** Multi-role → E2E_<ROLE>_USERNAME|PASSWORD */
  roleCredentials?: Record<string, { username: string; password: string }>;
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
