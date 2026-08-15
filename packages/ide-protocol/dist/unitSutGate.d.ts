/**
 * P0 / P0.1 hard gate before Unit Gen AI CLI — portable (no product hardcoding).
 */
import type { CodeAliasMap } from "./viCodeAliases.js";
import { type UnitIntentClass } from "./unitIntentAliases.js";
export type UnitSutRefuseCode = "FAIL_NEEDS_MARKER" | "FAIL_DOMAIN_GUARD" | "FAIL_SUT_MISMATCH" | "FAIL_FEATURE_GAP";
export type UnitDomainGuardRule = {
    whenModuleMatches?: string;
    allowPathContains?: string[];
    denyPathContains?: string[];
};
export type UnitSutGateCandidate = {
    path: string;
    score?: number;
    reason?: string;
};
/** Profile unit.scope — default backend for Unit Gen. */
export type UnitGenScope = "backend" | "frontend" | "any";
export type UnitSutGateResult = {
    decision: "gen" | "block";
    code?: UnitSutRefuseCode;
    reason: string;
    alignmentScore: number;
    markersHit: number;
    domainGuard: "pass" | "fail" | "skip";
    resolvedSut: string | "unresolved";
    featureGap?: string | null;
    /** Debug — primary intent class from TC. */
    intentClass?: UnitIntentClass | null;
    /** Debug — intent classes matched. */
    intentClasses?: UnitIntentClass[];
    /** Debug — min alignment floor applied. */
    minAlignment?: number;
};
/**
 * When TC has no path:/code: markers, require this alignment floor (stricter than
 * UNIT_SUT_ALIGN_MIN_NO_MARKER) unless profile requireMarkers forces FAIL_NEEDS_MARKER.
 */
export declare const UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT = 8;
/**
 * Absolute Gen floor (default) — alignment &lt; this never reaches CLI.
 * Override per-repo via profile `unit.minAlignment`.
 */
export declare const UNIT_SUT_ALIGN_HARD_FLOOR = 50;
/** Default Unit Gen scope when profile omits unit.scope. */
export declare const UNIT_GEN_SCOPE_DEFAULT: UnitGenScope;
/** IT verbs that must not alone win path rank / gate. */
export declare const UNIT_WEAK_COMMON_PATH_TOKENS: Set<string>;
/**
 * Tokens dropped from Module/Title/Requirement path scoring.
 * Narrower than basename penalty — keep Upload/MaxFileSize as intent rank signals.
 */
export declare const UNIT_WEAK_RANK_TOKENS: Set<string>;
/** True when token is too generic to drive SUT path rank alone. */
export declare function isWeakUnitRankToken(token: string): boolean;
/** Drop weak IT verbs from rank token lists (portable anti-AccountCreate latch). */
export declare function filterStrongRankTokens(tokens: string[]): string[];
/**
 * Strip policy / conventions dumps so feature-gap does not latch onto wording
 * inside `.ai-test/unit-conventions.md` examples (e.g. «BR / malware / validation»).
 */
export declare function scenarioTextForFeatureGap(tcText: string): string;
export declare function detectFeatureGap(tcText: string, sourceExcerpt: string): {
    gap: boolean;
    label?: string;
};
/** Match optional profile unit.domainGuards against module + path (portable). */
export declare function applyProfileDomainGuards(opts: {
    moduleText: string;
    primaryPath: string;
    rules?: UnitDomainGuardRule[] | null;
}): {
    pass: boolean;
    reason?: string;
};
/**
 * Hard gate: intent → markers → domain → body-rule → alignment floor → Gen.
 * Fail-closed. Never invent BE for UI/master when scope=backend.
 */
export declare function decideUnitSutGate(opts: {
    tcText: string;
    primaryPath?: string | null;
    sourceExcerpt?: string | null;
    /** Related DTO/validator excerpts — combined for body-rule + VALIDATION gap checks. */
    relatedExcerpt?: string | null;
    codeAliases?: CodeAliasMap | null;
    alignmentScore?: number | null;
    markersHit?: number | null;
    moduleText?: string | null;
    domainGuards?: UnitDomainGuardRule[] | null;
    /**
     * Profile unit.requireMarkers — when true, path:+code: required.
     * When undefined, unmarked TCs still need UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT.
     */
    requireMarkers?: boolean | null;
    /**
     * Profile unit.scope — default backend.
     * ui_master_create / uiOnly + backend → FAIL_FEATURE_GAP before Gen.
     */
    unitScope?: UnitGenScope | null;
    /**
     * Profile unit.minAlignment — default UNIT_SUT_ALIGN_HARD_FLOOR (50).
     * alignment &lt; this → never call CLI (no preferred-path exception).
     */
    minAlignment?: number | null;
}): UnitSutGateResult;
/** True when CLI/model output is a refuse protocol line. */
export declare function isUnitGenRefuseOutput(code: string): boolean;
/**
 * Path-rank penalty when basename is mostly weak Create/Unit/Upload tokens
 * and no marker / strong layer token hit.
 */
export declare function weakCommonPathTokenPenalty(pathRel: string, opts?: {
    hasMarkers?: boolean;
    strongTokenHit?: boolean;
}): number;
