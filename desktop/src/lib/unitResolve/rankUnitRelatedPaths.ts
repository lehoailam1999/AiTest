/**
 * Rank / filter related paths for Unit Approve + grounding contract.
 * Portable — no product nouns.
 */
const NOISE_RELATED_RE =
  /(?:\/Migrations?\/|\.spec\.|\.test\.|\.component\.|\.pipe\.|ClientApp\/|\.html$|node_modules)/i;

const PREFERRED_RELATED_RE =
  /(?:\/dto\/|\.dto\.|dto\.cs|validator|\/commands?\/|command\.cs|\/entities?\/|entity\.cs)/i;

export type RankUnitRelatedOpts = {
  maxRelated?: number;
  preferDtoValidator?: boolean;
};

function norm(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "").trim();
}

function scoreRelatedPath(
  pathRel: string,
  primary: string,
  preferDto: boolean
): number {
  const p = norm(pathRel);
  const primaryN = norm(primary);
  if (!p || p.toLowerCase() === primaryN.toLowerCase()) return -100;
  let s = 0;
  if (preferDto && /dto|validator/i.test(p)) s += 10;
  if (PREFERRED_RELATED_RE.test(p)) s += 6;
  if (/handler/i.test(p) && p !== primaryN) s += 1;
  if (NOISE_RELATED_RE.test(p)) s -= 30;
  if (/document|upload|notification|mail/i.test(p) && !/command/i.test(p)) s -= 4;
  return s;
}

export function isNoisyUnitRelatedPath(pathRel: string): boolean {
  return NOISE_RELATED_RE.test(norm(pathRel));
}

/**
 * Score, dedupe, cap related paths for Approve writeBack / grounding.json.
 */
export function rankUnitRelatedPaths(
  primary: string,
  candidates: string[],
  opts?: RankUnitRelatedOpts
): string[] {
  const max = opts?.maxRelated ?? 4;
  const preferDto = opts?.preferDtoValidator ?? false;
  const primaryN = norm(primary).toLowerCase();
  const seen = new Set<string>();
  const scored: Array<{ path: string; score: number }> = [];

  for (const raw of candidates) {
    const p = norm(raw);
    if (!p) continue;
    const k = p.toLowerCase();
    if (k === primaryN || seen.has(k)) continue;
    if (isNoisyUnitRelatedPath(p)) continue;
    seen.add(k);
    scored.push({ path: p, score: scoreRelatedPath(p, primary, preferDto) });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, max).map((x) => x.path);
}

/**
 * Merge expanded related + graph deps — prefer expanded; cap graph noise.
 */
export function mergeUnitRelatedCandidates(
  primary: string,
  expanded: string[],
  fromGraph: string[],
  opts?: RankUnitRelatedOpts
): string[] {
  const max = opts?.maxRelated ?? 4;
  const preferDto = opts?.preferDtoValidator ?? false;
  const expandedClean = rankUnitRelatedPaths(primary, expanded, {
    maxRelated: max,
    preferDtoValidator: preferDto,
  });
  if (expandedClean.length >= Math.min(2, max)) {
    return expandedClean;
  }
  const merged = [...expandedClean];
  for (const g of fromGraph) {
    if (!merged.some((m) => m.toLowerCase() === norm(g).toLowerCase())) {
      merged.push(norm(g));
    }
  }
  return rankUnitRelatedPaths(primary, merged, {
    maxRelated: max,
    preferDtoValidator: preferDto,
  });
}
