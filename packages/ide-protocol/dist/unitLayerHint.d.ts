/**
 * Portable Unit layerHint / sourceSignal — Approve enrich + related expand.
 * No product nouns: only parse TC markers and match type stems in index paths.
 */
import type { UnitIntent } from "./unitIntentAliases.js";
export type UnitLayerHint = "handler" | "dto" | "validator" | "authz";
export type UnitSourceSignal = {
    raw: string;
    /** Type/symbol before `.` — e.g. EvidenceDto from EvidenceDto.SeizureLocation */
    typeName: string | null;
    /** Member after `.` when present */
    memberName: string | null;
};
/** Parse `layerHint: dto|validator|handler|authz` from Test Data (portable). */
export declare function parseUnitLayerHint(testData?: string | null): UnitLayerHint | null;
/** Parse `sourceSignal: Type.Member` or bare token from Test Data. */
export declare function parseUnitSourceSignal(testData?: string | null): UnitSourceSignal | null;
/**
 * VALIDATION / AUTH intents and explicit layerHint need DTO/Validator siblings
 * (or authz services) in the Gen packet — not Handler-only.
 */
export declare function preferDtoValidatorForHints(intent: UnitIntent | null | undefined, testData?: string | null): boolean;
/**
 * When TC declares layerHint dto|validator|authz, pick a better primary than
 * a Handler that does not own the enforce site (portable).
 */
export declare function findLayerHintPrimaryPath(opts: {
    testData?: string | null;
    entryPathRel?: string | null;
    allPaths: string[];
    featureTokens?: string[] | null;
}): string | null;
/** Swap primary → layer path; keep previous primary in related (cap 4). */
export declare function applyLayerHintPrimaryPromotion(opts: {
    testData?: string | null;
    primaryPath: string;
    relatedPaths: string[];
    allPaths: string[];
    featureTokens?: string[] | null;
}): {
    primaryPath: string;
    relatedPaths: string[];
    promoted: boolean;
};
