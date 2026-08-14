/**
 * Per-repo Unit intent rules (`.ai-test/unit-intent-rules.json`).
 * Schema only in AITest — nouns/patterns live on each SUT.
 */
import type { UnitGenScope } from "./unitSutGate.js";
import type { UnitIntent } from "./unitIntentAliases.js";
export type UnitProjectIntentScopeAction = {
    backend?: "allow" | "FAIL_FEATURE_GAP";
    frontend?: "allow" | "FAIL_FEATURE_GAP";
    fullstack?: "allow" | "FAIL_FEATURE_GAP";
    any?: "allow" | "FAIL_FEATURE_GAP";
};
export type UnitProjectIntentRule = {
    id: string;
    whenTitleOrStepsMatch?: string;
    requiredBodyPatterns?: string[];
    preferSutMapKey?: string;
    scopeAction?: UnitProjectIntentScopeAction;
};
export type UnitProjectIntentRulesFile = {
    intents?: UnitProjectIntentRule[];
};
/** IT verbs that must not alone count as body-rule hits (Create/Add latch). */
export declare const UNIT_WEAK_BODY_RULE_PATTERNS: Set<string>;
/**
 * Patterns that may score body excerpts but must NOT drive index path-bridge /
 * folder widen (path name substring latch).
 */
export declare const UNIT_WEAK_PATH_BRIDGE_PATTERNS: Set<string>;
export declare function isWeakBodyRulePattern(pat: string): boolean;
export declare function isWeakPathBridgePattern(pat: string): boolean;
/** Drop Create/Add/… so soft writeBack cannot latch on verb-only hits. */
export declare function filterStrongBodyRulePatterns(patterns: string[]): string[];
/**
 * Soft writeBack must not succeed on generic IT hits alone (P0.1).
 * throw/BadRequest/Create/… without domain phrase/prefer/alias → refuse.
 */
export declare const UNIT_SOFT_GENERIC_RULE_HITS: Set<string>;
export declare function isSoftGenericRuleHit(hit: string): boolean;
export declare function hasStrongWriteBackSignal(opts: {
    pathRel: string;
    ruleHits?: string[] | null;
    hits?: string[] | null;
    preferTokens?: string[] | null;
}): boolean;
export declare function parseUnitProjectIntentRules(raw: unknown): UnitProjectIntentRule[];
export type ApplyProjectIntentResult = {
    intent: UnitIntent;
    matchedIds: string[];
    preferSutMapKey?: string;
    /** When set, Approve/Gen should FAIL_FEATURE_GAP for this scope. */
    scopeRefuse?: "FAIL_FEATURE_GAP";
};
/**
 * Merge matching project intent rules onto portable extractUnitIntent result.
 * Product nouns stay in the project JSON — never in AITest core.
 */
export declare function applyProjectIntentRules(base: UnitIntent, rules: UnitProjectIntentRule[] | null | undefined, opts: {
    title?: string | null;
    module?: string | null;
    steps?: string | null;
    expectedResult?: string | null;
    unitScope?: UnitGenScope | null;
}): ApplyProjectIntentResult;
/**
 * Resolve sutMap pin — keys may be intent id, module phrase, or title cue.
 * Values = repo-relative primary path (portable per project).
 */
export declare function resolveSutMapPin(sutMap: Record<string, string> | null | undefined, opts: {
    preferSutMapKey?: string | null;
    module?: string | null;
    title?: string | null;
    matchedIntentIds?: string[];
}): string | null;
