/**
 * Portable Unit intent alias layer (Approve enrich Phase 1).
 * Maps TC cues (VI/EN) → code patterns / feature tokens — no product paths.
 * Domain nouns come from project `.ai-test/code-aliases.json` only.
 */
import { type CodeAliasMap } from "./viCodeAliases.js";
import { UNIT_INTENT_DEFS, UNIT_UI_MASTER_STRONG_RE, type IntentDefLoaded, type UnitIntentClass } from "./loadUnitIntentDefs.js";
export { UNIT_INTENT_DEFS, UNIT_UI_MASTER_STRONG_RE };
export type { IntentDefLoaded, UnitIntentClass };
export type UnitIntent = {
    classes: UnitIntentClass[];
    /** Most specific class for gate/debug (may be undefined if none matched). */
    primaryClass?: UnitIntentClass;
    /** True when TC is UI/master/form — not BE Unit under scope=backend. */
    uiOnly: boolean;
    /** All code-ish patterns (path boost + legacy). */
    codePatterns: string[];
    /**
     * Patterns that must appear in SUT excerpt when requiresBodyRule.
     * Excludes action nouns like Upload/InitUpload (those are featureTokens only).
     */
    rulePatterns: string[];
    /**
     * Tokens for path/symbol ranking.
     * Includes project alias expansions (domain nouns) for soft boosts.
     */
    featureTokens: string[];
    /**
     * Feature tokens from intent class defs only (no project aliases).
     */
    classFeatureTokens: string[];
    /** When true, Phase 3 must see ≥1 bodyRuleHits before write-back. */
    requiresBodyRule: boolean;
    /**
     * Project intent overlay may suppress misleading operation heuristics
     * (for example duplicate validation must not be treated as permission).
     */
    forbiddenOpTokens?: string[];
};
/** Minimal TC shape — Desktop TestCase / Extension payloads. */
export type UnitIntentTcLike = {
    title?: string | null;
    module?: string | null;
    steps?: string | null;
    expectedResult?: string | null;
    precondition?: string | null;
    testData?: string | null;
};
export type ExtractUnitIntentOpts = {
    projectAliases?: CodeAliasMap | null;
    requirementTitle?: string | null;
    /**
     * When true, only title+module+requirement are used for ui_master cues
     * (steps often say «điền form» on BE create TCs — must not flip uiOnly).
     */
    uiFromTitleModuleOnly?: boolean;
    /**
     * Approve path/code grounding: match intent cues on Module+Function+Title only.
     * Steps / Expected / Precondition / Test Data must not flip primaryClass
     * (e.g. «ngăn lưu trữ» in steps → state_enable on a create-success TC).
     * Default true.
     */
    cuesFromGroundingOnly?: boolean;
};
/** Diacritic-stripped lowercase blob for cue matching. */
export declare function unitIntentBlob(tc: UnitIntentTcLike, requirementTitle?: string | null): string;
/**
 * Function-level blob (no Studio Module / requirementTitle).
 * Persist create/update must follow TC Function+Title — not Module alone.
 * When grounding-only: Title + Function only (no Steps/TestData).
 */
export declare function unitIntentFunctionBlob(tc: UnitIntentTcLike, opts?: {
    groundingOnly?: boolean;
}): string;
/**
 * Approve grounding blob: Module (requirement) + Function (module) + Title.
 * Excludes Steps / Expected / Precondition / Test Data.
 */
export declare function unitIntentGroundingBlob(tc: UnitIntentTcLike, requirementTitle?: string | null): string;
/** Title + module + requirement only (for UI intent — ignore steps «điền form»). */
export declare function unitIntentTitleModuleBlob(tc: UnitIntentTcLike, requirementTitle?: string | null): string;
/** Highest-priority matched class (for gate/debug). */
export declare function primaryIntentClass(classes: UnitIntentClass[]): UnitIntentClass | undefined;
export declare function hasStrongUiMasterCues(blob: string): boolean;
/**
 * Extract portable Unit intent from TC text (+ optional project domain aliases).
 */
export declare function extractUnitIntent(tc: UnitIntentTcLike, opts?: ExtractUnitIntentOpts): UnitIntent;
