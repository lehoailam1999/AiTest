/**
 * P3 — token/char budget + path noise filters for Context Builder.
 * Prevents ClientApp/src/app mirror floods and token overflow.
 */

import type { ContextPacketFile } from "../contextPacket/types";

export type ContextBudgetPolicy = {
  maxTotalChars: number;
  maxPrimaryChars: number;
  maxDependencyChars: number;
  maxOverviewChars: number;
  maxDependencyFiles: number;
  maxOverviewFiles: number;
  maxReferenceFiles: number;
};

/** Default IDE-first budget (unit generate) */
export const IDE_CONTEXT_BUDGET: ContextBudgetPolicy = {
  maxTotalChars: 48_000,
  maxPrimaryChars: 16_000,
  maxDependencyChars: 6_000,
  maxOverviewChars: 3_500,
  maxDependencyFiles: 8,
  maxOverviewFiles: 2,
  maxReferenceFiles: 4,
};

/** FS fallback — tighter overview to avoid module floods */
export const FS_CONTEXT_BUDGET: ContextBudgetPolicy = {
  maxTotalChars: 56_000,
  maxPrimaryChars: 12_000,
  maxDependencyChars: 6_000,
  maxOverviewChars: 3_500,
  maxDependencyFiles: 10,
  maxOverviewFiles: 3,
  maxReferenceFiles: 0,
};

export type RankTier = "primary" | "ctor" | "import" | "reference" | "overview" | "test-sample";

export const TIER_PRIORITY: Record<RankTier, number> = {
  primary: 100,
  ctor: 90,
  import: 70,
  reference: 50,
  "test-sample": 40,
  overview: 20,
};

export function trimToBudget(content: string, max: number): { text: string; truncated: boolean } {
  if (content.length <= max) return { text: content, truncated: false };
  return { text: content.slice(0, max) + "\n/* …truncated… */", truncated: true };
}

/**
 * True when path looks like Angular/SPA deep mirror noise relative to seed.
 * DoD P3: không ClientApp mirror trong related ồ ạt.
 */
export function isClientAppMirrorNoise(pathRel: string, seedPathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/");
  const s = seedPathRel.replace(/\\/g, "/");
  if (p === s) return false;

  const underApp = (path: string) => {
    const parts = path.split("/");
    const i = parts.findIndex((x) => x.toLowerCase() === "app");
    const client = parts.some((x) => x.toLowerCase() === "clientapp");
    return { i, client, parts };
  };

  const a = underApp(p);
  const b = underApp(s);
  const pIsDeepUi =
    a.client ||
    /\/src\/app\//i.test(p) ||
    /ClientApp\//i.test(p);

  if (!pIsDeepUi) return false;

  // Same leaf folder as seed → keep
  const seedDir = s.includes("/") ? s.slice(0, s.lastIndexOf("/")) : "";
  if (seedDir && (p.startsWith(`${seedDir}/`) || p === seedDir)) return false;

  // Seed also under app/: require first feature segment after app to match
  if (a.i >= 0 && b.i >= 0) {
    const featP = a.parts[a.i + 1];
    const featS = b.parts[b.i + 1];
    if (featP && featS && featP.toLowerCase() !== featS.toLowerCase()) return true;
    // Same feature but deep sibling trees beyond +2 segments from seed → noise
    if (featP && featS && featP.toLowerCase() === featS.toLowerCase()) {
      const seedTail = b.parts.slice(b.i + 1, b.i + 3).join("/");
      const pathTail = a.parts.slice(a.i + 1, a.i + 3).join("/");
      if (seedTail && pathTail && seedTail.toLowerCase() !== pathTail.toLowerCase()) {
        return true;
      }
    }
    return false;
  }

  // Candidate under ClientApp/app but seed is not → usually unrelated for unit SUT
  if (pIsDeepUi && b.i < 0 && !b.client) return true;

  return false;
}

/** Drop noise paths; preserve order. */
export function filterNoisePaths(paths: string[], seedPathRel: string): string[] {
  return paths.filter((p) => !isClientAppMirrorNoise(p, seedPathRel));
}

export type RankedFile = ContextPacketFile & {
  tier: RankTier;
  rankScore: number;
};

/**
 * Enforce total char budget by dropping lowest-priority files first
 * (never drop primary). Truncate remaining if still over.
 */
export function enforceContextBudget(
  files: RankedFile[],
  budget: ContextBudgetPolicy
): { files: ContextPacketFile[]; truncated: string[]; omittedPaths: string[] } {
  const truncated: string[] = [];
  const omittedPaths: string[] = [];

  const sorted = [...files].sort((a, b) => b.rankScore - a.rankScore);
  const kept: RankedFile[] = [];
  let depCount = 0;
  let overviewCount = 0;
  let refCount = 0;

  for (const f of sorted) {
    if (f.tier === "primary") {
      const cut = trimToBudget(f.content, budget.maxPrimaryChars);
      if (cut.truncated) truncated.push(f.pathRel);
      kept.push({ ...f, content: cut.text });
      continue;
    }
    if (f.tier === "ctor" || f.tier === "import") {
      if (depCount >= budget.maxDependencyFiles) {
        omittedPaths.push(f.pathRel);
        continue;
      }
      const cut = trimToBudget(f.content, budget.maxDependencyChars);
      if (cut.truncated) truncated.push(f.pathRel);
      kept.push({ ...f, content: cut.text, role: "dependency" });
      depCount++;
      continue;
    }
    if (f.tier === "reference") {
      if (refCount >= budget.maxReferenceFiles) {
        omittedPaths.push(f.pathRel);
        continue;
      }
      const cut = trimToBudget(f.content, Math.min(budget.maxDependencyChars, 2500));
      if (cut.truncated) truncated.push(f.pathRel);
      kept.push({ ...f, content: cut.text, role: "dependency" });
      refCount++;
      continue;
    }
    if (f.tier === "overview") {
      if (overviewCount >= budget.maxOverviewFiles) {
        omittedPaths.push(f.pathRel);
        continue;
      }
      const cut = trimToBudget(f.content, budget.maxOverviewChars);
      if (cut.truncated) truncated.push(f.pathRel);
      kept.push({ ...f, content: cut.text, role: "overview" });
      overviewCount++;
      continue;
    }
    // test-sample
    const cut = trimToBudget(f.content, budget.maxOverviewChars);
    if (cut.truncated) truncated.push(f.pathRel);
    kept.push({ ...f, content: cut.text });
  }

  // Drop lowest score until under total budget (keep at least primary)
  kept.sort((a, b) => b.rankScore - a.rankScore);
  let total = kept.reduce((n, f) => n + f.content.length, 0);
  while (total > budget.maxTotalChars && kept.length > 1) {
    // remove lowest priority non-primary
    let idx = -1;
    let minScore = Infinity;
    for (let i = 0; i < kept.length; i++) {
      if (kept[i].tier === "primary") continue;
      if (kept[i].rankScore < minScore) {
        minScore = kept[i].rankScore;
        idx = i;
      }
    }
    if (idx < 0) break;
    omittedPaths.push(kept[idx].pathRel);
    total -= kept[idx].content.length;
    kept.splice(idx, 1);
  }

  // Restore primary-first order for Prompt Builder
  kept.sort((a, b) => {
    if (a.tier === "primary") return -1;
    if (b.tier === "primary") return 1;
    return b.rankScore - a.rankScore;
  });

  return {
    files: kept.map(({ tier: _t, rankScore: _r, ...rest }) => rest),
    truncated,
    omittedPaths,
  };
}
