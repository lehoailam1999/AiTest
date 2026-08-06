/** Phase 4 — budgets for index-backed Context Builder. */

export type IndexContextBudget = {
  maxTotalChars: number;
  maxPrimaryChars: number;
  maxRelatedChars: number;
  maxRelatedFiles: number;
  maxDepSummaryChars: number;
  maxBusinessChars: number;
};

/** Unit gen — roadmap 24–48k band; stay slim for CLI. */
export const UNIT_INDEX_BUDGET: IndexContextBudget = {
  maxTotalChars: 36_000,
  maxPrimaryChars: 12_000,
  maxRelatedChars: 3_500,
  maxRelatedFiles: 7,
  maxDepSummaryChars: 2_000,
  maxBusinessChars: 1_500,
};

/** E2E — FE seed + few related; DOM separate. */
export const E2E_INDEX_BUDGET: IndexContextBudget = {
  maxTotalChars: 28_000,
  maxPrimaryChars: 10_000,
  maxRelatedChars: 3_000,
  maxRelatedFiles: 5,
  maxDepSummaryChars: 1_500,
  maxBusinessChars: 1_200,
};

export function trimChars(content: string, max: number): { text: string; truncated: boolean } {
  if (content.length <= max) return { text: content, truncated: false };
  return { text: `${content.slice(0, max)}\n/* …truncated… */`, truncated: true };
}
