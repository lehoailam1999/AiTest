/**
 * Phase 3 — Unit Rule Engine SoT (single façade).
 * Desktop + Extension MUST consume this module for conventions, guards,
 * prompt contract lines, and shared rank-policy constants — do not fork wording.
 */
export { behaviorEvidenceInExcerpt, isValidationDataBucket, } from "./behaviorEvidenceInExcerpt.js";
export { UNIT_CONVENTIONS_CORE, UNIT_GEN_LIMITS, UNIT_LAYOUT_RULE, } from "./unitConventions.js";
export { UNIT_SUT_ALIGN_MIN, UNIT_SUT_ALIGN_MIN_NO_MARKER, PATH_RANK_STOP, unitSutAlignMin, isSutAlignedEnough, significantTokens, extractTcSourceMarkers, sutTcAlignmentScore, expectedDomainTokensFromTc, extractPathDomainHints, sutDomainConflict, isPacketSutAcceptable, detectCodeStack, stackForPath, assertStackMatchesPath, findInventedRuleSmells, findNonPortableTestHarnessSmells, assertUnitGenQuality, detectCsharpPackagesFromTestCode, CSHARP_USING_TO_PACKAGE, type UnitCodeStack, type SutDomainConflict, } from "./unitGenGuards.js";
export { assertSafeAitestTargetRel, isAllowedUnitLayoutPath, } from "./codegenPathJail.js";
/**
 * Shared rank / retrieve policy (Desktop index + Extension disk resolve).
 * Keep aligned with UNIT_GEN_LIMITS.maxRelatedFiles.
 */
export declare const UNIT_RANK_POLICY: {
    readonly maxRelatedFiles: 4;
    readonly retrieveTopKDefault: 8;
    readonly retrieveTopKMin: 5;
    readonly retrieveTopKMax: 10;
    /** FE / SPA shells that must not become Unit primary without explicit markers. */
    readonly weakClientAppAdminRe: RegExp;
    /** Thin HTTP / chunk upload clients — not business-rule SUT. */
    readonly weakHttpClientRe: RegExp;
    readonly preferPathShapes: readonly ["handler", "command", "query", "usecase", "use-case", "service", "validator", "validation", "policy", "authorization", "permission", "repository"];
};
/**
 * Minimal Gen transport lines only (Extension / CLI).
 * All Unit policy (layers, grounding, path jail, no-invent, stack) lives in
 * `.ai-test/unit-conventions.md` (seed: UNIT_CONVENTIONS_CORE) — do not restate here.
 */
export declare const UNIT_PROMPT_RULES_CORE: readonly string[];
/** Rough token estimate when no tokenizer is available (chars/4). */
export declare function estimateTokenCount(text: string | null | undefined): number;
export type UnitGenPhaseMetrics = {
    /** Wall time for AI CLI oneshot */
    cliTimeMs?: number;
    /** Prompt size in characters */
    promptChars?: number;
    /** Approx tokens from promptChars */
    promptTokens?: number;
    /** Primary SUT excerpt chars */
    sutChars?: number;
    /** Related excerpts chars */
    relatedChars?: number;
    /** context_size = sut + related (+ optional prompt body without conventions) */
    contextSize?: number;
    /** Number of related / retrieved files in packet */
    retrievedFiles?: number;
    truncated?: boolean;
};
export declare function buildUnitGenPhaseMetrics(input: {
    cliTimeMs?: number;
    prompt?: string;
    sutExcerpt?: string;
    relatedExcerpt?: string;
    relatedFileCount?: number;
    truncated?: boolean;
}): UnitGenPhaseMetrics;
