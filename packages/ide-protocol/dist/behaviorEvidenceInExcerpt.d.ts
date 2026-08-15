/**
 * Layer 3b — TC behavior must be evidenced in SUT excerpt (body-rule path).
 * Portable heuristics; no product nouns.
 */
export declare function isValidationDataBucket(tcBlob: string): boolean;
/**
 * When excerpt is non-empty, require observable constraint signals in source body.
 */
export declare function behaviorEvidenceInExcerpt(tcBlob: string, excerpt: string): {
    ok: boolean;
    skipReason?: string;
};
