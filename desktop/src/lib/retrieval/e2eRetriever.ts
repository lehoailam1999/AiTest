/**
 * E2eRetriever — Top-K FE/page files from Code Index + TestPlan (featurePath + keywords).
 * Complements legacy resolveE2eFeSources; does not replace Tauri list+seed until wired.
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";
import type { TestPlan } from "../testPlanner/types";
import {
  clampTopK,
  e2ePathBonus,
  featurePathTokenBonus,
  isExcludedFromE2eRetrieve,
  normalizeKeywords,
  pathKeywordScore,
  symbolKeywordScore,
} from "./rankScore";
import type { RankedFileHit, RetrieveFilesResult, RetrieveOptions } from "./types";

function symbolsForFile(snap: CodeIndexSnapshot, pathRel: string): string[] {
  return (snap.symbolsByFile[pathRel] || []).map((s) => s.name);
}

export function retrieveE2eSources(
  snapshot: CodeIndexSnapshot,
  plan: TestPlan,
  opts?: RetrieveOptions
): RetrieveFilesResult {
  const topK = clampTopK(opts?.topK);
  const featurePath = plan.hints.featurePath;
  const keywords = normalizeKeywords([
    ...plan.keywords,
    plan.module,
    plan.action,
    ...(featurePath ? featurePath.split("/").filter(Boolean) : []),
  ]);
  const notes: string[] = [];
  const paths = Object.keys(snapshot.files).filter((p) => !isExcludedFromE2eRetrieve(p));
  if (!paths.length) {
    notes.push("Code index empty or only generated E2E — run sync / use legacy FE resolve");
    return { files: [], primary: null, notes, plan };
  }

  const ranked: RankedFileHit[] = [];
  for (const pathRel of paths) {
    const reasons: string[] = [];
    let score = 0;
    const pk = pathKeywordScore(pathRel, keywords);
    if (pk) {
      score += pk;
      reasons.push(`pathKeywords+${pk}`);
    }
    const sk = symbolKeywordScore(symbolsForFile(snapshot, pathRel), keywords);
    if (sk) {
      score += sk;
      reasons.push(`symbols+${sk}`);
    }
    const fb = featurePathTokenBonus(pathRel, featurePath);
    if (fb) {
      score += fb;
      reasons.push(`featurePath+${fb}`);
    }
    const eb = e2ePathBonus(pathRel);
    if (eb) {
      score += eb;
      reasons.push(`e2ePath${eb >= 0 ? "+" : ""}${eb}`);
    }
    if (score > 0) {
      ranked.push({ pathRel, rankScore: score, reasons });
    }
  }

  ranked.sort(
    (a, b) => b.rankScore - a.rankScore || a.pathRel.localeCompare(b.pathRel)
  );
  const top = ranked.slice(0, topK);

  if (!top.length) {
    notes.push("No E2E hits — fallback FE-shaped paths");
    const fallback = paths
      .map((pathRel) => ({
        pathRel,
        rankScore: e2ePathBonus(pathRel),
        reasons: ["fallbackE2ePath"],
      }))
      .filter((h) => h.rankScore > 0)
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, topK);
    return { files: fallback, primary: fallback[0] || null, notes, plan };
  }

  if (featurePath) notes.push(`featurePath=${featurePath}`);
  notes.push(`E2eRetriever topK=${top.length}`);
  return { files: top, primary: top[0] || null, notes, plan };
}
