/**
 * Resolve FE template/component files for E2E Generate so locators match real HTML attrs
 * (data-cy, id, formControlName, …) instead of invented labels from TC wording alone.
 *
 * KEEP_AS_FALLBACK (docs/CODEGEN_LEGACY_CLEANUP.md):
 * Phase 3–4 primary path is Code Index → retrieveE2eSources → contextBuilder.
 * This module remains when index is missing/empty; do not delete until index FE KPI is solid.
 *
 * Legacy: re-rank Unit seed scores toward UI templates (.html / pages / components)
 * and away from backend controllers/services.
 */
import type { TestCase } from "../../api/types";
import { buildProjectIndex } from "../projectIntelligence/projectIndex";
import { resolveSeedFromTestCaseWithAlternatives } from "../projectIntelligence/tcSeedResolver";
import {
  extractDomainTokens,
  isExcludedFromE2eRetrieve,
  modulePathTokenBonus,
} from "../retrieval/rankScore";
import { isTauri, listSourceFiles, readTextFile } from "../../tauri/bridge";
import { normalizeFeaturePath } from "./assertTcReadyForE2eGen";

/** FE-facing extensions — prefer templates/components over pure backend. */
const E2E_FE_EXTS = [
  ".html",
  ".htm",
  ".component.ts",
  ".component.html",
  ".tsx",
  ".jsx",
  ".vue",
  ".cshtml",
  ".razor",
  ".ts",
  ".js",
];

const MAX_RELATED = 3;
const MAX_CHARS = 24_000;
const DEFAULT_LIST_TTL_MS = 5 * 60 * 1000;
const PATH_MARKER_RE =
  /(?:^|\n)\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)/i;

export type E2eFeSourceBundle = {
  sourceFileName: string;
  sourceCode: string;
  relatedSources: { path: string; content: string }[];
  notes: string[];
};

/** Shared listSourceFiles cache for a Generate batch (avoid N full-tree walks). */
export function createFeSourceListCache(ttlMs = DEFAULT_LIST_TTL_MS) {
  let root: string | null = null;
  let paths: string[] | null = null;
  let at = 0;
  let inflight: Promise<string[]> | null = null;

  return {
    async getPaths(
      projectRoot: string
    ): Promise<{ paths: string[]; fromCache: boolean }> {
      const now = Date.now();
      if (paths && root === projectRoot && now - at < ttlMs) {
        return { paths, fromCache: true };
      }
      if (inflight && root === projectRoot) {
        const p = await inflight;
        return { paths: p, fromCache: true };
      }
      root = projectRoot;
      inflight = listSourceFiles(projectRoot, E2E_FE_EXTS).finally(() => {
        inflight = null;
      });
      paths = await inflight;
      at = Date.now();
      return { paths, fromCache: false };
    },
    clear() {
      root = null;
      paths = null;
      at = 0;
      inflight = null;
    },
  };
}

export type FeSourceListCache = ReturnType<typeof createFeSourceListCache>;

function isLikelyFePath(pathRel: string): boolean {
  if (isExcludedFromE2eRetrieve(pathRel)) return false;
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (
    p.includes("/node_modules/") ||
    p.includes("/dist/") ||
    p.includes("/bin/") ||
    p.includes("/obj/") ||
    p.includes(".spec.") ||
    p.includes(".test.") ||
    p.includes(".fixture.")
  ) {
    return false;
  }
  if (
    p.includes("/webapp/") ||
    p.includes("/frontend/") ||
    p.includes("/client/") ||
    p.includes("/clientapp/") ||
    p.includes("/src/main/webapp/") ||
    p.includes("/components/") ||
    p.includes("/pages/") ||
    p.includes(".component.")
  ) {
    return true;
  }
  return (
    p.endsWith(".html") ||
    p.endsWith(".htm") ||
    p.endsWith(".tsx") ||
    p.endsWith(".jsx") ||
    p.endsWith(".vue") ||
    p.endsWith(".cshtml") ||
    p.endsWith(".razor")
  );
}

/** Bonus for FE-like paths when re-ranking Unit seeds for E2E. */
export function e2eFeRankBonus(pathRel: string): number {
  if (isExcludedFromE2eRetrieve(pathRel)) return -100;
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let bonus = 0;
  if (/\.(html|htm|cshtml|razor|vue)$/.test(p)) bonus += 40;
  if (/\.component\.(ts|html|tsx)$/.test(p)) bonus += 35;
  if (p.includes("/pages/") || p.includes("/components/")) bonus += 25;
  // Prefer form/modal/create/update templates over list-only shells for Act locators
  if (/\/(create|update|edit|form|modal|dialog|detail)\//.test(p)) bonus += 28;
  if (/\.(create|update|edit|form|modal)\./.test(p)) bonus += 22;
  if (/\/list\//.test(p) || /\.list\./.test(p)) bonus -= 8;
  if (p.includes("/controllers/") || p.includes("/services/") || p.includes("/api/"))
    bonus -= 30;
  if (/\.service\.(ts|js)$/.test(p) && !p.includes("/components/")) bonus -= 45;
  return bonus;
}

function rerankForE2e(
  items: Array<{ pathRel: string; score: number }>
): Array<{ pathRel: string; score: number }> {
  return items
    .map((it) => ({
      pathRel: it.pathRel,
      score: it.score + e2eFeRankBonus(it.pathRel),
    }))
    .sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
}

function normalizePath(value: string): string {
  const clean = (value || "").trim().replace(/\\/g, "/");
  if (!clean) return "";
  const noProto = clean.replace(/^[a-z]+:\/\/[^/]+/i, "");
  const out = noProto.startsWith("/") ? noProto : `/${noProto}`;
  return out.replace(/\/{2,}/g, "/").toLowerCase();
}

function pathHintFromTestCase(tc: TestCase): string | undefined {
  const blob = [tc.testData, tc.precondition, tc.steps, tc.title]
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .join("\n");
  const m = PATH_MARKER_RE.exec(blob);
  if (!m?.[1]) return undefined;
  // Reject placeholders e.g. path: [Thiếu Context]
  const usable = normalizeFeaturePath(m[1]);
  if (!usable) return undefined;
  return normalizePath(usable);
}

function pathTokens(pathHint: string | undefined): string[] {
  if (!pathHint) return [];
  return pathHint
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && !/^\d+$/.test(s))
    .slice(-4);
}

function pathHintBonus(pathRel: string, tokens: string[]): number {
  if (!tokens.length) return 0;
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (p.includes(`/${t}/`) || p.endsWith(`/${t}`) || p.includes(`.${t}.`)) {
      score += 30;
    }
  }
  if (score > 0 && /routes?|app-routing|router|navigation|menu/.test(p)) {
    score += 10;
  }
  return score;
}

export function hasFeGroundingHooks(
  sourceCode?: string,
  related?: { path: string; content: string }[]
): boolean {
  const blob = [sourceCode || "", ...(related || []).map((r) => r.content)].join("\n");
  return /data-cy\s*=|data-testid\s*=|formControlName|\[formControl\]|formControl\s*=|routerLink|\[routerLink\]|matInput|mat-label|placeholder\s*=|path:\s*['"`][^'"`]+['"`]/.test(
    blob
  );
}

/** Angular/React sibling templates that usually hold locators (data-cy, formControlName). */
export function siblingTemplatePaths(primaryPath: string): string[] {
  const p = primaryPath.replace(/\\/g, "/");
  const out: string[] = [];
  if (/\.component\.ts$/i.test(p)) {
    out.push(p.replace(/\.component\.ts$/i, ".component.html"));
  } else if (/\.tsx$/i.test(p)) {
    // keep tsx as SoT
  } else if (/\.ts$/i.test(p) && !/\.(spec|test)\.ts$/i.test(p)) {
    out.push(p.replace(/\.ts$/i, ".html"));
  }
  return out;
}

/** Absolute or root-relative path → path usable with readTextFile under projectRoot. */
export function toFeReadPath(projectRoot: string, absOrRel: string): string {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = absOrRel.replace(/\\/g, "/");
  if (!p) return p;
  const lowerRoot = root.toLowerCase();
  const lowerP = p.toLowerCase();
  if (lowerP.startsWith(lowerRoot + "/")) {
    return p.slice(root.length + 1);
  }
  return p.replace(/^\.\//, "");
}

/**
 * When primary is `.component.ts`, also load `.component.html` where locators live.
 * Without this, locator contract stays empty for Angular Forensic-style apps.
 *
 * Also: if primary is a list shell, pull create/update/modal form templates from the
 * same feature folder so Act locators (formControlName / field_*) enter the contract.
 */
export async function attachSiblingFeTemplates(opts: {
  projectRoot: string;
  sourceFileName: string;
  relatedSources: { path: string; content: string }[];
  readFile?: (projectRoot: string, pathRel: string) => Promise<string>;
  maxExtra?: number;
  /** TC title/steps — boost create/update surfaces when wording matches */
  actionHint?: string;
}): Promise<{ relatedSources: { path: string; content: string }[]; notes: string[] }> {
  const notes: string[] = [];
  const related = [...(opts.relatedSources || [])];
  const have = new Set(related.map((r) => r.path.replace(/\\/g, "/").toLowerCase()));
  have.add(opts.sourceFileName.replace(/\\/g, "/").toLowerCase());
  const read =
    opts.readFile ||
    (async (root: string, pathRel: string) => readTextFile(root, pathRel));
  const maxExtra = opts.maxExtra ?? 6;
  let added = 0;
  const seeds = [
    opts.sourceFileName,
    ...related.map((r) => r.path).filter((p) => /\.component\.ts$/i.test(p)),
  ];
  for (const seed of seeds) {
    if (added >= maxExtra) break;
    for (const sibRaw of siblingTemplatePaths(seed)) {
      if (added >= maxExtra) break;
      const sib = toFeReadPath(opts.projectRoot, sibRaw);
      const key = sib.replace(/\\/g, "/").toLowerCase();
      if (have.has(key)) continue;
      const absKey = sibRaw.replace(/\\/g, "/").toLowerCase();
      if (have.has(absKey)) continue;
      try {
        const raw = await read(opts.projectRoot, sib);
        if (!raw.trim()) continue;
        related.unshift({
          path: sib,
          content: raw.length > 20_000 ? raw.slice(0, 20_000) : raw,
        });
        have.add(key);
        have.add(absKey);
        added += 1;
        notes.push(`FE template sibling=${sib}`);
      } catch {
        /* sibling missing — ok */
      }
    }
  }
  // List → form surfaces (create/update/modal) for Act grounding
  for (const cand of formSurfaceCandidatePaths(opts.sourceFileName, opts.actionHint)) {
    if (added >= maxExtra) break;
    const sib = toFeReadPath(opts.projectRoot, cand);
    const key = sib.replace(/\\/g, "/").toLowerCase();
    if (have.has(key)) continue;
    try {
      const raw = await read(opts.projectRoot, sib);
      if (!raw.trim()) continue;
      related.unshift({
        path: sib,
        content: raw.length > 20_000 ? raw.slice(0, 20_000) : raw,
      });
      have.add(key);
      added += 1;
      notes.push(`FE form surface=${sib}`);
    } catch {
      /* candidate missing — ok */
    }
  }
  return { relatedSources: related, notes };
}

/**
 * Portable candidates: …/list/foo.component.html → …/create|update|… form templates.
 */
export function formSurfaceCandidatePaths(
  primaryPath: string,
  actionHint?: string
): string[] {
  const p = primaryPath.replace(/\\/g, "/");
  if (!/\/list\//i.test(p) && !/\.list\./i.test(p)) {
    // Still try create sibling when TC clearly is create and we landed on a non-form file
    const hint = (actionHint || "").toLowerCase();
    if (!/(tạo|tao|create|thêm|add|mới|moi)/i.test(hint)) return [];
  }
  const file = p.split("/").pop() || "";
  const stem = file
    .replace(/\.component\.(html|ts|tsx)$/i, "")
    .replace(/\.(html|tsx|jsx)$/i, "")
    .replace(/\.list$/i, "");
  if (!stem || stem.length < 2) return [];
  // …/feature/list/x.component.html → …/feature  (do not strip an extra segment)
  const featureDir = /\/list\/[^/]+$/i.test(p)
    ? p.replace(/\/list\/[^/]+$/i, "")
    : p.replace(/\/[^/]+$/i, "");
  if (!featureDir) return [];
  // Prefer create/modal first when action looks like create
  const hint = (actionHint || "").toLowerCase();
  const createFirst = /(tạo|tao|create|thêm|add|mới|moi)/i.test(hint);
  const createPaths = [
    `${featureDir}/create/${stem}-create-modal.component.html`,
    `${featureDir}/create/${stem}-create.component.html`,
    `${featureDir}/create/${stem}.component.html`,
    `${featureDir}/modal/${stem}-create-modal.component.html`,
  ];
  const updatePaths = [
    `${featureDir}/update/${stem}-update.component.html`,
    `${featureDir}/update/${stem}.component.html`,
    `${featureDir}/edit/${stem}-edit.component.html`,
    `${featureDir}/edit/${stem}.component.html`,
  ];
  return createFirst ? [...createPaths, ...updatePaths] : [...updatePaths, ...createPaths];
}

export async function resolveE2eFeSources(opts: {
  projectRoot: string;
  testCase: TestCase;
  /** Batch-shared listSourceFiles cache */
  listCache?: FeSourceListCache;
}): Promise<E2eFeSourceBundle | null> {
  if (!isTauri()) return null;

  const notes: string[] = [];
  const hint = pathHintFromTestCase(opts.testCase);
  const hintTokens = pathTokens(hint);
  const domainTokens = extractDomainTokens(
    opts.testCase.module,
    hint,
    opts.testCase.title,
    opts.testCase.testData
  );
  if (hint) notes.push(`path hint=${hint}`);
  if (domainTokens.length) notes.push(`domainTokens=${domainTokens.slice(0, 8).join(",")}`);
  let paths: string[] = [];
  try {
    if (opts.listCache) {
      const listed = await opts.listCache.getPaths(opts.projectRoot);
      paths = listed.paths;
      if (listed.fromCache) notes.push("FE list cache hit");
    } else {
      paths = await listSourceFiles(opts.projectRoot, E2E_FE_EXTS);
    }
  } catch (e) {
    notes.push(`listSourceFiles failed: ${String(e)}`);
    return null;
  }

  const fePaths = paths.filter(isLikelyFePath);
  const usePaths = fePaths.length ? fePaths : paths.filter((p) => !isExcludedFromE2eRetrieve(p));
  if (!usePaths.length) {
    notes.push("No FE source files found under project root");
    return null;
  }

  const index = buildProjectIndex(usePaths);
  const { best, candidates } = resolveSeedFromTestCaseWithAlternatives(
    opts.testCase,
    index,
    { limit: 12 }
  );
  if (!best) {
    notes.push("No seed file matched TC tokens");
    return null;
  }

  const ranked = rerankForE2e([
    { pathRel: best.pathRel, score: best.score },
    ...candidates.map((c) => ({ pathRel: c.pathRel, score: c.score })),
  ])
    .map((it) => ({
      ...it,
      score:
        it.score +
        pathHintBonus(it.pathRel, hintTokens) +
        modulePathTokenBonus(it.pathRel, domainTokens),
    }))
    .filter((it) => !isExcludedFromE2eRetrieve(it.pathRel))
    .sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));

  const actionHint = [opts.testCase.title, opts.testCase.module, opts.testCase.steps]
    .filter(Boolean)
    .join("\n");

  // FE quality gate: prefer primary with hooks (or attachable sibling/form surface)
  let primary: { pathRel: string; score: number } | undefined;
  let sourceCode = "";
  let relatedSources: { path: string; content: string }[] = [];
  for (const cand of ranked.slice(0, 8)) {
    let code = "";
    try {
      code = await readTextFile(opts.projectRoot, cand.pathRel);
    } catch {
      continue;
    }
    if (!code.trim()) continue;
    const probe = await attachSiblingFeTemplates({
      projectRoot: opts.projectRoot,
      sourceFileName: cand.pathRel,
      relatedSources: [],
      actionHint,
      maxExtra: 4,
    });
    if (!hasFeGroundingHooks(code, probe.relatedSources)) {
      notes.push(`FE quality skip=${cand.pathRel} (no hooks)`);
      continue;
    }
    primary = cand;
    sourceCode = code;
    relatedSources = probe.relatedSources;
    notes.push(...probe.notes);
    break;
  }
  if (!primary) {
    // Fallback: best ranked even without hooks (Gen may still use TC-only)
    primary = ranked[0];
    if (!primary) {
      notes.push("No seed after E2E re-rank");
      return null;
    }
    try {
      sourceCode = await readTextFile(opts.projectRoot, primary.pathRel);
    } catch (e) {
      notes.push(`read primary failed: ${primary.pathRel} (${String(e)})`);
      return null;
    }
    if (!sourceCode.trim()) {
      notes.push(`Empty primary: ${primary.pathRel}`);
      return null;
    }
    const withTpl = await attachSiblingFeTemplates({
      projectRoot: opts.projectRoot,
      sourceFileName: primary.pathRel,
      relatedSources: [],
      actionHint,
    });
    relatedSources = withTpl.relatedSources;
    notes.push(...withTpl.notes);
    notes.push("FE quality: no hooked primary — using best ranked seed");
  }

  let budget = MAX_CHARS - sourceCode.length;
  for (const c of ranked) {
    if (relatedSources.length >= MAX_RELATED) break;
    if (c.pathRel === primary.pathRel) continue;
    if (relatedSources.some((r) => r.path.replace(/\\/g, "/") === c.pathRel.replace(/\\/g, "/")))
      continue;
    if (budget < 500) break;
    try {
      const raw = await readTextFile(opts.projectRoot, c.pathRel);
      if (!raw.trim()) continue;
      const slice = raw.length > budget ? raw.slice(0, budget) : raw;
      relatedSources.push({ path: c.pathRel, content: slice });
      budget -= slice.length;
    } catch {
      /* skip unreadable */
    }
  }

  notes.push(
    `FE seed=${primary.pathRel} score=${primary.score} related=${relatedSources.length} (E2E re-rank + path-hint + domain)`
  );

  return {
    sourceFileName: primary.pathRel,
    sourceCode:
      sourceCode.length > MAX_CHARS ? sourceCode.slice(0, MAX_CHARS) : sourceCode,
    relatedSources,
    notes,
  };
}
