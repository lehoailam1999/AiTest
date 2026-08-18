/**
 * Phase 3 — Unit Rule Engine SoT (single façade).
 * Desktop + Extension MUST consume this module for conventions, guards,
 * prompt contract lines, and shared rank-policy constants — do not fork wording.
 */
export { behaviorEvidenceInExcerpt, isValidationDataBucket, } from "./behaviorEvidenceInExcerpt.js";
export { UNIT_CONVENTIONS_CORE, UNIT_GEN_LIMITS, UNIT_LAYOUT_RULE, } from "./unitConventions.js";
export { UNIT_SUT_ALIGN_MIN, UNIT_SUT_ALIGN_MIN_NO_MARKER, PATH_RANK_STOP, unitSutAlignMin, isSutAlignedEnough, significantTokens, extractTcSourceMarkers, sutTcAlignmentScore, expectedDomainTokensFromTc, extractPathDomainHints, sutDomainConflict, isPacketSutAcceptable, detectCodeStack, stackForPath, assertStackMatchesPath, findInventedRuleSmells, findNonPortableTestHarnessSmells, assertUnitGenQuality, detectCsharpPackagesFromTestCode, CSHARP_USING_TO_PACKAGE, } from "./unitGenGuards.js";
export { assertSafeAitestTargetRel, isAllowedUnitLayoutPath, } from "./codegenPathJail.js";
/**
 * Shared rank / retrieve policy (Desktop index + Extension disk resolve).
 * Keep aligned with UNIT_GEN_LIMITS.maxRelatedFiles.
 */
export const UNIT_RANK_POLICY = {
    maxRelatedFiles: 4,
    retrieveTopKDefault: 8,
    retrieveTopKMin: 5,
    retrieveTopKMax: 10,
    /** FE / SPA shells that must not become Unit primary without explicit markers. */
    weakClientAppAdminRe: /(\/clientapp\/|\/client-app\/|\/wwwroot\/|angular|\/components?\/|\/pages?\/|\/views?\/).+/i,
    /** Thin HTTP / chunk upload clients — not business-rule SUT. */
    weakHttpClientRe: /(resumable-?upload|chunked-?upload|multipart-upload|form-?data-?upload)/i,
    preferPathShapes: [
        "handler",
        "command",
        "query",
        "usecase",
        "use-case",
        "service",
        "validator",
        "validation",
        "policy",
        "authorization",
        "permission",
        // Prefer service/handler owning the rule over thin controllers / anemic entities
        "repository",
    ],
};
/**
 * Minimal Gen transport lines only (Extension / CLI).
 * All Unit policy (layers, grounding, path jail, no-invent, stack) lives in
 * `.ai-test/unit-conventions.md` (seed: UNIT_CONVENTIONS_CORE) — do not restate here.
 */
export const UNIT_PROMPT_RULES_CORE = [
    "You are generating ONE unit test file for ONE Approved Test Case.",
    "Return ONLY the unit test source inside a single markdown code fence. No explanation outside the fence.",
    "Do NOT write files to disk — return text only.",
    "Policy SoT is the «Project rules / unit-conventions» block below — follow it; do not invent conflicting rules.",
    "Primary SUT in the packet is authoritative — map TC intent to closest behavior in primary + related excerpts.",
    "VALIDATION_DATA: assert only constraints evidenced in excerpts ([Required], MaxLength, throw/BadRequest, duplicate) — never invent.",
    "If the locked packet cannot be exercised faithfully, return an empty code fence; never search for or substitute another SUT.",
];
/** Rough token estimate when no tokenizer is available (chars/4). */
export function estimateTokenCount(text) {
    const n = (text || "").length;
    if (!n)
        return 0;
    return Math.max(1, Math.ceil(n / 4));
}
export function buildUnitGenPhaseMetrics(input) {
    const promptChars = (input.prompt || "").length;
    const sutChars = (input.sutExcerpt || "").length;
    const relatedChars = (input.relatedExcerpt || "").length;
    return {
        cliTimeMs: input.cliTimeMs,
        promptChars,
        promptTokens: estimateTokenCount(input.prompt),
        sutChars,
        relatedChars,
        contextSize: sutChars + relatedChars,
        retrievedFiles: input.relatedFileCount ?? 0,
        truncated: input.truncated,
    };
}
