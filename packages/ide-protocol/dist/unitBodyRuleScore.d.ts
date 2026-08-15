import type { UnitIntent } from "./unitIntentAliases.js";
export declare const UNIT_BODY_RULE: {
    /** Cap excerpt chars when scoring (aligned with Gen budget). */
    readonly maxExcerptChars: 8000;
    /** How many top path candidates to open for body scoring. */
    readonly topN: 5;
    /** First rule-hit boost. */
    readonly hitBoost: 28;
    /** Extra boost per additional distinct pattern hit. */
    readonly multiHitBoost: 12;
    /** Soft demote when validation intent but path still FE-shaped (defense in depth). */
    readonly feValidationPenalty: 40;
};
export type BodyRuleCandidateIn = {
    pathRel: string;
    score: number;
    reason?: string;
    hits?: string[];
};
export type BodyRuleScoredCandidate = BodyRuleCandidateIn & {
    baseScore: number;
    ruleHits: string[];
    score: number;
};
export type BodyRuleWriteDecision = {
    writeBack: boolean;
    seed: BodyRuleScoredCandidate | null;
    skipReason?: string;
    candidatesTop3: Array<{
        pathRel: string;
        score: number;
        baseScore: number;
        ruleHits: string[];
    }>;
};
/**
 * Order candidates for body-rule excerpt opens.
 * Body-rule / validate_reject: prefer *Handler/*Service over *Query so
 * bool-check queries do not consume topN while CommandHandlers with
 * throw/BadRequest never get scored.
 */
export declare function orderCandidatesForBodyRuleOpen<T extends {
    pathRel: string;
    score: number;
}>(candidates: T[], intent?: Pick<UnitIntent, "requiresBodyRule" | "primaryClass" | "classes"> | null, topN?: 5): T[];
/**
 * Portable feature-family key from filename:
 * DigitalFileCreateCommandHandler / DigitalFileCreateCommand / DigitalFileDeleteCommand
 * → "digitalfile"
 */
export declare function unitFeatureFamilyKey(pathRel: string): string;
/** Prefer Handler/Service; demote bare Command message + Delete* within a family. */
export declare function unitPrimaryShapeRank(pathRel: string): number;
/**
 * Collapse IFoo↔Foo ties and drop *Query when a *Service scores as high —
 * those are not real SUT ambiguity for Unit Gen write-back.
 * Also collapse same feature-family ties (CreateCommand vs CreateCommandHandler vs Delete).
 */
export declare function collapseBodyRuleContenders(usable: BodyRuleScoredCandidate[]): BodyRuleScoredCandidate[];
/** Clip excerpt for scoring. */
export declare function clipBodyExcerpt(text: string | null | undefined, maxChars?: 8000): string;
/**
 * Which intent codePatterns appear in the SUT excerpt (case-insensitive).
 * Supports plain tokens and light regex (`(?i)A|B`, `EntityCode`).
 */
export declare function findBodyRuleHits(excerpt: string, codePatterns: string[] | null | undefined): string[];
export declare function bodyRuleScoreBoost(hitCount: number): number;
/**
 * True when TC Function/title/steps imply file/image upload (not bare Module «tạo mới»).
 */
export declare function queryImpliesUploadIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/** Delete / unassign / remove — never primary for upload/reject-format TCs. */
export declare function pathIsDeleteLikeUnitPrimary(pathRel: string): boolean;
/**
 * Upload / image-file TCs — boost portable Upload|Image|Media|InitUpload paths;
 * demote Delete* and generic DocumentCreate. Product stems stay in SUT aliases.
 */
export declare function uploadIntentPathShapeAdjust(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): number;
/**
 * Title/steps search/lookup (tim kiem / theo ma / SearchTerm) — stronger than
 * Function-only Assign when both cue. Portable VI/IT only.
 */
export declare function queryImpliesSearchLookupIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Search/lookup TCs — boost *Query* / GetAll / Search; demote Assign*Command.
 */
export declare function searchIntentPathShapeAdjust(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): number;
/**
 * Soft writeBack refuse: upload intent must not latch Delete* even when path
 * shares Digital / Image tokens or body-rule throw+BadRequest.
 */
export declare function pathContradictsUploadVerb(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Soft writeBack refuse: search/lookup title must not latch Assign*Command
 * when a Query/GetAll-shaped alternative is expected.
 */
export declare function pathContradictsSearchVerb(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * True when Function/title/steps imply load/display/get-detail (read), not create.
 * Portable VI/IT only — stronger than bare Module «Update …» / Function «chỉnh sửa».
 */
export declare function queryImpliesReadGetDetailIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/** Create*CommandHandler — wrong primary for read/get-detail TCs. */
export declare function pathIsCreateLikeUnitPrimary(pathRel: string): boolean;
/** Update / Edit / Patch primary shapes — portable across stacks (path segment / type name). */
export declare function pathIsUpdateLikeUnitPrimary(pathRel: string): boolean;
/**
 * CRUD verb from TC text + intent — portable VI/IT only (no product nouns).
 * Order: read > delete > update > create. `validate_reject` / trùng mã alone ≠ create.
 */
export type UnitCrudVerb = "create" | "read" | "update" | "delete";
export declare function detectUnitCrudVerb(intent: UnitIntent, shapeBlob?: string | null): UnitCrudVerb | null;
/** Path looks like a CRUD command/query primary (not DTO/entity). */
export declare function pathLooksLikeCrudPrimary(pathRel: string): boolean;
export declare function pathMatchesCrudVerb(pathRel: string, verb: UnitCrudVerb): boolean;
/**
 * Boost path matching detected CRUD verb; demote other CRUD primaries.
 * Stack-agnostic: matches Create|Update|Delete|Get in path/type names.
 */
export declare function crudVerbPathShapeAdjust(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): number;
/**
 * Soft writeBack refuse: detected CRUD verb must not latch a different CRUD primary.
 * validate_reject alone does not fire (verb null). read → pathContradictsReadGetVerb.
 */
export declare function pathContradictsCrudVerb(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Read/get-detail TCs — boost Get* Query* Queries folder; demote Create*CommandHandler.
 */
export declare function readGetIntentPathShapeAdjust(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): number;
/**
 * Soft writeBack refuse: read/get-detail must not latch Create* (or Update*
 * when title/steps are pure load/display/get-by-id).
 */
export declare function pathContradictsReadGetVerb(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Storage / compartment / occupied state — stronger than assign/filter when both cue.
 * Portable IT: Compartment|Storage|Slot|IsOccupied (no product nouns).
 */
export declare function queryImpliesStorageStateIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Authz / permission / CanWrite — Function/Title cues (not bare Module create).
 */
export declare function queryImpliesAuthzIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * True when Function/Title/steps imply assign / filter / list (not bare Module create).
 * Portable VI/IT cues — score only; not a hard moduleGate.
 * Does not fire when storage/compartment state is the stronger op.
 */
export declare function queryImpliesAssignFilterIntent(intent: UnitIntent, shapeBlob?: string | null): boolean;
/**
 * Op tokens from Function/Title that must hit path/symbol for soft writeBack.
 * Portable IT stems only.
 */
export declare function extractOpPreferTokens(intent: UnitIntent, shapeBlob?: string | null): string[];
/**
 * Soft writeBack refuse when op tokens from Title/Function miss the candidate path
 * (e.g. storage/compartment TC latching AssignCase with no Storage/Compartment hit).
 */
export declare function pathContradictsOpPreferTokens(pathRel: string, opTokens: string[] | null | undefined): boolean;
/**
 * Assign / Filter / List / Storage / Authz op shape adjust.
 * Boost matching Handler shapes; demote conflicting Create/Assign in same family.
 * No product nouns.
 */
export declare function functionOpPathShapeAdjust(pathRel: string, intent: UnitIntent, shapeBlob?: string | null): number;
/**
 * Portable shape adjust for validate_reject / auto_generate_code + create cues.
 * Boost Create*Handler; demote signed-URL generators and compound *DocumentCreate*.
 * No product nouns.
 */
export declare function validateRejectPathShapeAdjust(pathRel: string, intent: UnitIntent, tcBlob?: string | null): number;
/**
 * Re-score one path candidate with body-rule hits from its excerpt.
 */
/** Patterns used for body-rule hit detection (never bare Upload/Create/Add). */
export declare function bodyRulePatternsForIntent(intent: UnitIntent): string[];
/**
 * Phrases from TC title/module/expected for excerpt affinity.
 * Portable: any language tokens present in both TC and SUT strings/comments.
 */
export declare function extractTcAffinityPhrases(tcBlob: string | null | undefined): string[];
/**
 * Boost when SUT excerpt/path shares phrases, preferTokens, or tech stems with the TC.
 * Breaks cross-family CreateHandler ties without product aliases.
 */
export declare function extractExcerptTechStems(excerpt: string | null | undefined): string[];
export declare function tcExcerptAffinityBoost(excerpt: string | null | undefined, tcBlob: string | null | undefined, opts?: {
    preferTokens?: string[] | null;
    pathRel?: string | null;
}): {
    boost: number;
    hits: string[];
};
export type ApplyBodyRuleOpts = {
    preferTokens?: string[] | null;
};
export declare function applyBodyRuleToCandidate(cand: BodyRuleCandidateIn, excerpt: string, intent: UnitIntent, tcBlob?: string | null, opts?: ApplyBodyRuleOpts | null): BodyRuleScoredCandidate;
export type PickBodyRuleOpts = {
    minScore?: number;
    minMargin?: number;
    minRatio?: number;
    /**
     * Domain / tech tokens from Requirement→Module→Title (+ project aliases).
     * Break cross-family score ties without treating them as ambiguous margin.
     */
    preferTokens?: string[] | null;
    /** Full TC blob for verb contradiction (upload≠Delete, search≠Assign). */
    shapeBlob?: string | null;
};
/** Count how many prefer tokens hit the path (portable domain nudge). */
export declare function countPreferTokenHits(pathRel: string, preferTokens: string[] | null | undefined): number;
/**
 * Fail-closed pick after body-rule rescoring.
 * When intent.requiresBodyRule → best must have ≥1 ruleHits.
 */
export declare function decideBodyRuleWriteBack(scored: BodyRuleScoredCandidate[], intent: UnitIntent, opts?: PickBodyRuleOpts): BodyRuleWriteDecision;
/** Compact log line for Activity / Grounding (P3.2). */
export declare function formatBodyRuleLog(decision: BodyRuleWriteDecision, extra?: {
    intentClass?: string | null;
    matchedIntentIds?: string[] | null;
    domainGuard?: string | null;
    softSignalOk?: boolean | null;
}): string;
