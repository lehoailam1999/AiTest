/**
 * Resolve FE template/component files for E2E Generate so locators match real HTML attrs
 * (data-cy, id, formControlName, …) instead of invented labels from TC wording alone.
 *
 * Phase 1: re-rank Unit seed scores toward UI templates (.html / pages / components)
 * and away from backend controllers/services.
 */
import type { TestCase } from "../../api/types";
import { buildProjectIndex } from "../projectIntelligence/projectIndex";
import { resolveSeedFromTestCaseWithAlternatives } from "../projectIntelligence/tcSeedResolver";
import { isTauri, listSourceFiles, readTextFile } from "../../tauri/bridge";

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
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (
    p.includes("/aitest/") ||
    p.includes("/node_modules/") ||
    p.includes("/dist/") ||
    p.includes("/bin/") ||
    p.includes("/obj/") ||
    p.includes(".spec.") ||
    p.includes(".test.")
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
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let bonus = 0;
  if (/\.(html|htm|cshtml|razor|vue)$/.test(p)) bonus += 40;
  if (/\.component\.(ts|html|tsx)$/.test(p)) bonus += 35;
  if (p.includes("/pages/") || p.includes("/components/")) bonus += 25;
  if (p.includes("/controllers/") || p.includes("/services/") || p.includes("/api/"))
    bonus -= 30;
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

export async function resolveE2eFeSources(opts: {
  projectRoot: string;
  testCase: TestCase;
  /** Batch-shared listSourceFiles cache */
  listCache?: FeSourceListCache;
}): Promise<E2eFeSourceBundle | null> {
  if (!isTauri()) return null;

  const notes: string[] = [];
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
  const usePaths = fePaths.length ? fePaths : paths;
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
  ]);
  const primary = ranked[0];
  if (!primary) {
    notes.push("No seed after E2E re-rank");
    return null;
  }

  let sourceCode = "";
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

  const relatedSources: { path: string; content: string }[] = [];
  let budget = MAX_CHARS - sourceCode.length;
  for (const c of ranked) {
    if (relatedSources.length >= MAX_RELATED) break;
    if (c.pathRel === primary.pathRel) continue;
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
    `FE seed=${primary.pathRel} score=${primary.score} related=${relatedSources.length} (E2E re-rank)`
  );

  return {
    sourceFileName: primary.pathRel,
    sourceCode:
      sourceCode.length > MAX_CHARS ? sourceCode.slice(0, MAX_CHARS) : sourceCode,
    relatedSources,
    notes,
  };
}
