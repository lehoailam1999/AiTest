export type ExpandUnitRelatedOpts = {
    entryPathRel: string;
    allPaths: string[];
    /** Intent / alias feature tokens (Upload, Evidence, …). */
    featureTokens?: string[] | null;
    /** Cap related paths (default UNIT_GEN_LIMITS.maxRelatedFiles = 4). */
    maxRelated?: number;
    /**
     * When true (VALIDATION / AUTH TCs): prioritize DTO / Validator / bare Command
     * siblings so Gen packet can see field/authz enforce — not Handler-only.
     */
    preferDtoValidator?: boolean;
};
/** Strip common type suffixes for feature family matching. */
export declare function featureStem(stem: string): string;
/** Feature keys from entry path (UploadService → upload, …). */
export declare function entryFeatureKeys(entryPathRel: string): string[];
/** True for DTO / Validator / bare Command (validation layer siblings). */
export declare function isValidationLayerRelatedPath(pathRel: string): boolean;
/**
 * Shape bonus for related (not primary): Interface / DTO / enum preferred.
 * Returns 0 when path is not a useful related shape.
 */
export declare function relatedShapeBonus(pathRel: string): number;
/**
 * Expand related paths for an entry SUT (portable, no product folders).
 */
export declare function expandUnitRelatedPaths(opts: ExpandUnitRelatedOpts): string[];
/** Format related paths for Test Data (`related: a, b` or multi-line). */
export declare function formatRelatedMarkerLines(relatedPaths: string[]): string[];
