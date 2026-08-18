/**
 * Single source-grounding decision shared by Approve, Desktop Gen and IDE Gen.
 * Product-neutral; paths/properties must come from the indexed candidate packet.
 */
export declare const APPROVED_GROUNDING_SCHEMA: "aitest-unit-grounding-v1";
export type GroundingConfidence = "HIGH" | "MEDIUM" | "LOW";
export type GroundingOutcome = "READY" | "NOT_READY" | "FEATURE_GAP";
export type GroundingTargetScope = "field" | "multi" | "aggregate";
export type GroundingBinding = {
    label: string;
    property: string;
    ownerPath: string;
    ownerType?: string;
};
export type ApprovedGroundingDecision = {
    schema: typeof APPROVED_GROUNDING_SCHEMA;
    emittedAt: string;
    testCaseId?: string;
    outcome?: GroundingOutcome;
    authoritative: boolean;
    primary: {
        pathRel: string;
        code: string;
        typeName: string;
        methodName?: string;
        line?: number;
        endLine?: number;
        contentHash?: string;
    };
    related: Array<{
        pathRel: string;
        contentHash?: string;
    }>;
    deps: string[];
    confidence?: GroundingConfidence;
    freshness?: string;
    validateChecks?: string[];
    source?: string;
    score?: number;
    targetScope?: GroundingTargetScope;
    targetProperties?: Array<{
        name: string;
        ownerType?: string;
        ownerPath?: string;
    }>;
    bindings?: GroundingBinding[];
    /** Why Approve refused, carried so Gen can state the cause instead of guessing. */
    refusalReasons?: Array<{
        code: string;
        message: string;
    }>;
    intentClass?: string | null;
    layerScope?: "backend" | "frontend";
    behaviorEvidence?: {
        quote?: string;
        excerptHash?: string;
        pathRel?: string;
    };
};
/**
 * A decision is only authoritative when the resolver itself reported that it
 * grounded a primary against a repository it had verified as fresh.
 */
export declare const REQUIRED_GROUNDING_CHECKS: readonly ["primary", "repository-fresh"];
/**
 * Content hashes travel in two spellings: the IDE emits `sha256:<hex>` while
 * re-hashing on the consumer side yields bare hex. Compare them by digest only.
 */
export declare function normalizeContentHash(value: string | null | undefined): string;
export declare function sameContentHash(a: string | null | undefined, b: string | null | undefined): boolean;
export type GroundingMarkerInput = {
    paths?: string[];
    codes?: string[];
};
export type GroundingValidationResult = {
    ok: true;
} | {
    ok: false;
    code: "INVALID_SCHEMA" | "NOT_AUTHORITATIVE" | "NOT_READY" | "INVALID_PRIMARY" | "MISSING_HASH" | "LOW_CONFIDENCE" | "STALE_DECISION" | "MISSING_CHECKS" | "INCOMPLETE_BINDINGS" | "MARKER_MISMATCH";
};
/**
 * Pure authority validation. Runtime hash equality is checked by the packet
 * materializer after reading source; this validates the persisted decision.
 */
export declare function validateApprovedGroundingDecision(decision: ApprovedGroundingDecision | null | undefined, markers?: GroundingMarkerInput): GroundingValidationResult;
