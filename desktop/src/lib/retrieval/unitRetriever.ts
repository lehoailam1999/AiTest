/**
 * UnitRetriever — Top-K source files from Code Index + TestPlan keywords.
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { resolveImportSpecifier } from "../codeIndex/buildDependencyGraph";
import type { TestPlan } from "../testPlanner/types";
import {
  clampTopK,
  isExcludedFromUnitRetrieve,
  normalizeKeywords,
  pathKeywordScore,
  symbolKeywordScore,
  unitPathBonus,
} from "./rankScore";
import { UNIT_RANK_POLICY } from "@aitest/ide-protocol";
import type { RankedFileHit, RetrieveFilesResult, RetrieveOptions } from "./types";

function symbolsForFile(snap: CodeIndexSnapshot, pathRel: string): string[] {
  return (snap.symbolsByFile[pathRel] || []).map((s) => s.name);
}

/**
 * Rank index files for Unit gen. Does not read file contents (Phase 4 Context Builder).
 */
export function retrieveUnitSources(
  snapshot: CodeIndexSnapshot,
  plan: TestPlan,
  opts?: RetrieveOptions
): RetrieveFilesResult {
  const topK = clampTopK(opts?.topK ?? UNIT_RANK_POLICY.retrieveTopKDefault);
  const keywords = normalizeKeywords([
    ...plan.keywords,
    plan.module,
    plan.action,
  ].filter(Boolean) as string[]);
  const notes: string[] = [];
  const paths = Object.keys(snapshot.files).filter((p) => !isExcludedFromUnitRetrieve(p));
  if (!paths.length) {
    notes.push("Code index empty or only E2E/UI noise — run sync or use legacy scope");
    return { files: [], primary: null, notes, plan };
  }

  const scores = new Map<string, { score: number; reasons: string[] }>();

  for (const pathRel of paths) {
    const reasons: string[] = [];
    let score = 0;
    const ub = unitPathBonus(pathRel);
    // Skip pure UI / page-like paths even if keywords match
    if (ub <= -15 && !/\.(service|controller|repository|handler|dto|model)\./i.test(pathRel)) {
      continue;
    }
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
    if (ub) {
      score += ub;
      reasons.push(`unitPath${ub >= 0 ? "+" : ""}${ub}`);
    }
    const mod = plan.module.trim().toLowerCase();
    const pathLower = pathRel.toLowerCase();
    if (mod) {
      if (pathLower.includes(`/${mod}/`)) {
        score += 35;
        reasons.push("moduleDir+35");
      } else if (pathLower.includes(`${mod}.`)) {
        score += 25;
        reasons.push("moduleFile+25");
      } else if (pathLower.includes(mod)) {
        score += 10;
        reasons.push("moduleName+10");
      }
    }
    if (score > 0) scores.set(pathRel, { score, reasons });
  }

  // Import proximity: boost direct deps of high-scoring files
  const known = new Set(paths);
  const seeded = [...scores.entries()].sort((a, b) => b[1].score - a[1].score).slice(0, 5);
  for (const [importer, meta] of seeded) {
    if (meta.score < 20) continue;
    const specs = snapshot.dependencyGraph[importer] || [];
    for (const spec of specs) {
      const asPath = known.has(spec) ? spec : null;
      const resolved =
        asPath ||
        resolveImportSpecifier(importer, spec, known, {
          symbolIndex: snapshot.symbolIndex,
        });
      if (!resolved || resolved === importer) continue;
      const cur = scores.get(resolved) || { score: 0, reasons: [] };
      cur.score += 12;
      cur.reasons.push(`depOf:${importer}`);
      scores.set(resolved, cur);
    }
  }

  const ranked: RankedFileHit[] = [...scores.entries()]
    .map(([pathRel, v]) => ({
      pathRel,
      rankScore: v.score,
      reasons: v.reasons,
    }))
    .sort(
      (a, b) =>
        b.rankScore - a.rankScore || a.pathRel.localeCompare(b.pathRel)
    )
    .slice(0, topK);

  if (!ranked.length) {
    // Fallback: unit-shaped paths by bonus only
    notes.push("No keyword hits — fallback unit-shaped paths");
    const fallback = paths
      .map((pathRel) => ({
        pathRel,
        rankScore: unitPathBonus(pathRel),
        reasons: ["fallbackUnitPath"],
      }))
      .filter((h) => h.rankScore > 0)
      .sort((a, b) => b.rankScore - a.rankScore)
      .slice(0, topK);
    return {
      files: fallback,
      primary: fallback[0] || null,
      notes,
      plan,
    };
  }

  notes.push(`UnitRetriever topK=${ranked.length} keywords=${keywords.slice(0, 6).join(",")}`);
  return {
    files: ranked,
    primary: ranked[0] || null,
    notes,
    plan,
  };
}
