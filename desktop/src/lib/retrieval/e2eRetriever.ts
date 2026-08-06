/**
 * E2eRetriever — Top-K FE/page files from Code Index + TestPlan (featurePath + keywords).
 * Complements legacy resolveE2eFeSources; does not replace Tauri list+seed until wired.
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";
import type { TestPlan } from "../testPlanner/types";
import {
  clampTopK,
  e2ePathBonus,
  extractDomainTokens,
  featurePathTokenBonus,
  hasSemanticE2eReasons,
  isExcludedFromE2eRetrieve,
  modulePathTokenBonus,
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
  const domainTokens = extractDomainTokens(
    plan.module,
    featurePath,
    plan.action,
    ...(plan.keywords || [])
  );
  const keywords = normalizeKeywords([
    ...plan.keywords,
    plan.module,
    plan.action,
    ...domainTokens,
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
    const mb = modulePathTokenBonus(pathRel, domainTokens);
    if (mb) {
      score += mb;
      reasons.push(`domainTokens${mb >= 0 ? "+" : ""}${mb}`);
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

  // Prefer TC/plan token overlap. Shape-only hits (create/update/modal) tie-break by
  // path sort and often pick the wrong feature folder — defer to legacy FE resolve.
  const semantic = ranked.filter((h) => hasSemanticE2eReasons(h.reasons));
  if (!semantic.length) {
    notes.push(
      "No semantic E2E hits (shape-only) — defer to legacy FE resolve"
    );
    if (featurePath) notes.push(`featurePath=${featurePath}`);
    if (domainTokens.length)
      notes.push(`domainTokens=${domainTokens.slice(0, 8).join(",")}`);
    return { files: [], primary: null, notes, plan };
  }

  const top = semantic.slice(0, topK);

  if (featurePath) notes.push(`featurePath=${featurePath}`);
  if (domainTokens.length) notes.push(`domainTokens=${domainTokens.slice(0, 8).join(",")}`);
  notes.push(`E2eRetriever topK=${top.length}`);
  return { files: top, primary: top[0] || null, notes, plan };
}
