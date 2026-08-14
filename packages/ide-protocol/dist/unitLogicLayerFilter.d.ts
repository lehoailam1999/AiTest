/**
 * Shared weak FE / thin HTTP client shapes (Desktop planner + Extension Gen).
 * Combines ClientApp/pages/components + resumable/chunk upload clients.
 */
export declare function isWeakUnitClientPath(pathRel: string): boolean;
/** True when TC path: marker explicitly points at this file (manual override). */
export declare function markersPointAtPath(pathRel: string, markers?: {
    paths?: string[] | null;
} | null): boolean;
/**
 * Phase 2 deny for auto-primary, unless TC path: explicitly points here.
 */
export declare function isBlockedUnitPrimaryPath(pathRel: string, markers?: {
    paths?: string[] | null;
} | null): boolean;
/**
 * Hard deny as Unit auto-primary (Approve enrich / retrieve primary).
 * Portable shapes only — no product folder names.
 */
export declare function isDeniedUnitPrimaryPath(pathRel: string): boolean;
/**
 * Anemic entity / POCO / DTO shapes — fine as *related*, weak as Unit *primary*
 * when the TC is about validate / reject / enable-disable behavior.
 */
export declare function isAnemicEntityLikePath(pathRel: string): boolean;
/**
 * TC implies behavior primary (validate / reject / enable-disable / filter),
 * not “assert property on entity”.
 */
export declare function tcImpliesBehaviorPrimary(tcText: string): boolean;
/**
 * Preferred logic-layer shapes for Unit primary.
 */
export declare function isPreferredLogicLayerPath(pathRel: string): boolean;
/**
 * Deny for related expand (Phase 4): FE / tests / pipes / constants / thin upload clients.
 * Allows enum/types/DTO/interface folders that are denied as Unit *primary*.
 */
export declare function isDeniedUnitRelatedPath(pathRel: string): boolean;
/**
 * Path-list filter: hard-deny only (no scores → cannot judge prefer competitiveness).
 */
export declare function filterUnitLogicLayerPaths(paths: string[]): string[];
/**
 * Scored-candidate filter:
 * 1) drop denied
 * 2) behavior TCs drop anemic entities when any Handler/Service remains
 * 3) if preferred are competitive with best score → keep preferred only
 * 4) else keep all non-denied (avoids weak cross-domain Handler beating Form)
 */
export declare function filterUnitLogicLayerCandidates<T extends {
    pathRel: string;
    score?: number;
}>(cands: T[], opts?: {
    tcText?: string | null;
}): T[];
