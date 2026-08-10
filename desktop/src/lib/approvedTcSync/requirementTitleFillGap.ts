/**
 * Bulk Approve: fill-gap requirement titles (no API / Vite deps).
 */

export function mergeRequirementTitleFillGap(
  cases: Array<{
    id: string;
    testCaseId?: string | null;
    sourceId?: string | null;
  }>,
  map: Record<string, string>,
  fallbackTitle?: string | null
): Record<string, string> {
  const out = { ...map };
  const t = (fallbackTitle || "").trim();
  if (!t) return out;
  for (const tc of cases) {
    const has =
      (out[tc.id] ||
        (tc.testCaseId ? out[tc.testCaseId] : "") ||
        (tc.sourceId ? out[tc.sourceId] : "") ||
        "").trim().length > 0;
    if (has) continue;
    out[tc.id] = t;
    if (tc.testCaseId) out[tc.testCaseId] = t;
    if (tc.sourceId) out[tc.sourceId] = t;
  }
  return out;
}
