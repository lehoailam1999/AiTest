/** Extract searchable stems from indexed paths (folders + file/symbol names). */
export declare function extractStemsFromIndexPaths(paths: string[]): string[];
/** Test/helper — clear stem cache. */
export declare function clearIndexStemCache(): void;
/** Path segment / substring match — shared by Approve rank + index token filter. */
export declare function pathHitsIndexToken(pathRel: string, token: string): boolean;
/** Keep tokens that hit ≥1 indexed path. */
export declare function filterTokensHittingPaths(tokens: string[], paths: string[]): string[];
export type ExpandTokensFromIndexOpts = {
    minStemLen?: number;
    minWordLen?: number;
};
/**
 * Match TC text (VI normalized + Latin identifiers) against index path stems.
 * Returns only stems present on this repo's index.
 */
export declare function expandTokensFromIndex(raw: string, paths: string[], opts?: ExpandTokensFromIndexOpts): string[];
/** Alias — same helper used across Desktop rank + legacy seed. */
export declare const pathHitsToken: typeof pathHitsIndexToken;
