/**
 * Resolve FE template/component files for E2E Generate so locators match real HTML attrs
 * (data-cy, id, formControlName, …) instead of invented labels from TC wording alone.
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

export type E2eFeSourceBundle = {
  sourceFileName: string;
  sourceCode: string;
  relatedSources: { path: string; content: string }[];
  notes: string[];
};

function isLikelyFePath(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (
    p.includes("/aitest/") ||
    p.includes("/node_modules/") ||
    p.includes("/dist/") ||
    p.includes(".spec.") ||
    p.includes(".test.")
  ) {
    return false;
  }
  // Prefer UI layers
  if (
    p.includes("/webapp/") ||
    p.includes("/frontend/") ||
    p.includes("/client/") ||
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
    p.endsWith(".vue") ||
    p.endsWith(".tsx") ||
    p.endsWith(".jsx") ||
    p.endsWith(".cshtml") ||
    p.endsWith(".razor")
  );
}

export async function resolveE2eFeSources(opts: {
  projectRoot: string;
  testCase: TestCase;
}): Promise<E2eFeSourceBundle | null> {
  if (!isTauri()) return null;
  const notes: string[] = [];
  let paths: string[] = [];
  try {
    paths = await listSourceFiles(opts.projectRoot, E2E_FE_EXTS);
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
    { limit: 8 }
  );
  if (!best) {
    notes.push("No seed file matched TC tokens");
    return null;
  }

  let sourceCode = "";
  try {
    sourceCode = await readTextFile(opts.projectRoot, best.pathRel);
  } catch (e) {
    notes.push(`read primary failed: ${best.pathRel} (${String(e)})`);
    return null;
  }
  if (!sourceCode.trim()) {
    notes.push(`Empty primary: ${best.pathRel}`);
    return null;
  }

  const relatedSources: { path: string; content: string }[] = [];
  let budget = MAX_CHARS - sourceCode.length;
  for (const c of candidates) {
    if (relatedSources.length >= MAX_RELATED) break;
    if (c.pathRel === best.pathRel) continue;
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
    `FE seed=${best.pathRel} score=${best.score} related=${relatedSources.length}`
  );
  return {
    sourceFileName: best.pathRel,
    sourceCode:
      sourceCode.length > MAX_CHARS ? sourceCode.slice(0, MAX_CHARS) : sourceCode,
    relatedSources,
    notes,
  };
}
