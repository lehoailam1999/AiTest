/**
 * Shared soft-bypass policy for Unit Gen when SUT gate blocks but source exists.
 */
export function canSoftBypassUnitSutGate(opts: {
  code?: string;
  primaryPath?: string;
  sourceExcerpt?: string;
  tcBlob?: string;
  alignmentScore?: number;
  minAlignment?: number;
  markersMatch?: boolean;
}): boolean {
  if (!/FEATURE_GAP|SUT_MISMATCH/i.test(opts.code || "")) return false;
  if (/primaryBucket:\s*VALIDATION_DATA|trace:\s*VALIDATION_DATA/i.test(opts.tcBlob || "")) {
    return false;
  }
  if (!opts.primaryPath?.trim() || !opts.sourceExcerpt?.trim()) return false;
  if (opts.markersMatch === false) return false;

  const blob = opts.tcBlob || "";
  const highConf = /\bconfidence=HIGH\b/i.test(blob);
  const min = opts.minAlignment ?? 50;
  const score = opts.alignmentScore ?? 0;
  const alignedEnough = score >= min;

  return highConf || alignedEnough;
}
