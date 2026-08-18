/**
 * Unit Approve v2 — IDE Repository Intelligence contract.
 * Desktop sends structured TC IR; IDE returns one immutable decision.
 * Markdown markers are projections only — never authority.
 */
export declare const UNIT_APPROVE_REQUEST_SCHEMA: "aitest-unit-approve-request-v2";
export declare const UNIT_APPROVE_RESPONSE_SCHEMA: "aitest-unit-approve-response-v2";
export declare const UNIT_APPROVE_DECISION_SCHEMA: "aitest-unit-approve-decision-v2";
export declare const UNIT_TC_IR_SCHEMA: "aitest-unit-tc-ir-v1";
export type Sha256Hex = `sha256:${string}`;
export type SourcePosition = {
    readonly line: number;
    readonly character: number;
};
/** Zero-based, end-exclusive UTF-16 range. */
export type SourceRange = {
    readonly start: SourcePosition;
    readonly end: SourcePosition;
};
export type UnitApproveTargetScope = "field" | "multi" | "aggregate";
export type UnitApproveScenario = "POSITIVE" | "NEGATIVE" | "BOUNDARY" | "NULL" | "EMPTY" | "BLANK" | "DUPLICATE" | "NOT_FOUND" | "AUTHORIZATION" | "INVALID_STATE" | "DEPENDENCY_FAILURE";
export type UnitApprovePrimaryBucket = "BUSINESS_RULES" | "VALIDATION_DATA" | "ERROR_HANDLING" | "ACCEPTANCE";
export type UnitApproveTcIr = {
    readonly schema: typeof UNIT_TC_IR_SCHEMA;
    readonly testCaseId: string;
    readonly title: string;
    readonly requirement: {
        readonly title?: string;
        readonly requirementIds: readonly string[];
        readonly behaviorId: string;
    };
    readonly module?: string;
    readonly primaryBucket: UnitApprovePrimaryBucket;
    readonly scenario: UnitApproveScenario;
    readonly categories: readonly string[];
    readonly preconditions: readonly string[];
    readonly steps: {
        readonly prepare: readonly string[];
        readonly execute: readonly string[];
    };
    readonly expected: {
        readonly type: string;
        readonly description: string;
        readonly observable: string;
    };
    readonly testData: {
        readonly target?: {
            readonly scope: UnitApproveTargetScope;
            readonly fields: readonly string[];
            readonly constraint?: string;
            readonly boundary?: string;
            readonly value?: unknown;
        };
        readonly input?: Readonly<Record<string, unknown>>;
        readonly existingState?: Readonly<Record<string, unknown>>;
    };
    readonly hints?: {
        readonly layer?: "dto" | "validator" | "service" | "handler" | "repository";
        readonly sourceSignal?: string;
    };
    readonly readiness: "READY_FOR_GROUNDING";
};
export type RepositoryRevision = {
    readonly workspaceId: Sha256Hex;
    readonly vcs: "git" | "none";
    readonly head?: string;
    readonly dirty: boolean;
    readonly dirtyFingerprint?: Sha256Hex;
    readonly capturedAt: string;
};
export type RepositoryRevisionExpectation = {
    readonly workspaceId: Sha256Hex;
    readonly head?: string;
    readonly dirtyFingerprint?: Sha256Hex;
};
export type UnitApproveResolveLimits = {
    readonly maxSymbolCandidates?: number;
    readonly maxReferences?: number;
    readonly maxImplementations?: number;
    readonly maxRelatedFiles?: number;
    readonly maxExistingTests?: number;
    readonly maxEvidencePerFile?: number;
    readonly maxFileBytes?: number;
    readonly deadlineMs?: number;
};
export type UnitApproveResolveParams = {
    readonly schema: typeof UNIT_APPROVE_REQUEST_SCHEMA;
    readonly requestId: string;
    readonly projectId: string;
    readonly testCaseRevision: {
        readonly testCaseId: string;
        readonly contentHash: Sha256Hex;
        readonly generatedFromHash?: string;
        readonly generatedFromVersion?: number;
    };
    readonly tcIr: UnitApproveTcIr;
    readonly expectedRepository?: RepositoryRevisionExpectation;
    readonly manualSourceHint?: {
        readonly pathRel?: string;
        readonly symbol?: string;
        readonly propertyBindings?: readonly {
            readonly label: string;
            readonly property: string;
        }[];
    };
    readonly limits?: UnitApproveResolveLimits;
};
export type GroundedSymbolKind = "class" | "interface" | "method" | "function" | "property" | "constructor";
export type GroundedSymbol = {
    readonly symbolId: string;
    readonly pathRel: string;
    readonly name: string;
    readonly qualifiedName?: string;
    readonly kind: GroundedSymbolKind;
    readonly containerName?: string;
    readonly signature?: string;
    readonly selectionRange: SourceRange;
    readonly fullRange: SourceRange;
    readonly fileHash: Sha256Hex;
};
export type GroundedFileRole = "definition" | "implementation" | "dependency" | "contract" | "dto" | "validator" | "repository" | "existing_test" | "behavior_evidence";
export type GroundedFile = {
    readonly pathRel: string;
    readonly language: string;
    readonly roles: readonly GroundedFileRole[];
    readonly fileHash: Sha256Hex;
    readonly relatedToSymbolId?: string;
    readonly evidenceRanges: readonly SourceRange[];
    readonly discoveredBy: readonly ("workspace_symbol" | "definition" | "references" | "implementation" | "dependency" | "test_search")[];
};
export type ExistingTestEvidence = {
    readonly pathRel: string;
    readonly fileHash: Sha256Hex;
    readonly framework?: "jest" | "vitest" | "xunit" | "nunit" | "pytest" | "junit";
    readonly symbol?: GroundedSymbol;
    readonly relationship: "references_primary" | "imports_primary" | "name_match" | "same_feature";
    readonly referenceRanges: readonly SourceRange[];
};
export type FieldBindingDecision = {
    readonly label: string;
    readonly property: string;
    readonly owner: {
        readonly pathRel: string;
        readonly typeName: string;
        readonly symbolId?: string;
        readonly range: SourceRange;
        readonly fileHash: Sha256Hex;
    };
    readonly source: "exact_symbol" | "input_key" | "display_attribute" | "approved_alias" | "bounded_shortlist_pick";
    readonly confidence: "HIGH" | "MEDIUM";
};
export type BehaviorEvidence = {
    readonly behaviorId: string;
    readonly observable: string;
    readonly kind: "validation" | "branch" | "throw" | "persistence" | "query" | "authorization" | "state_transition";
    readonly pathRel: string;
    readonly fileHash: Sha256Hex;
    readonly range: SourceRange;
    readonly quote: string;
    readonly quoteHash: Sha256Hex;
    readonly matchedSignals: readonly string[];
};
export type FileSnapshot = {
    readonly pathRel: string;
    readonly language: string;
    readonly sha256: Sha256Hex;
    readonly byteSize: number;
    readonly documentVersion?: number;
    readonly source: "saved_disk" | "dirty_editor";
};
export type UnitApproveCheck = {
    readonly id: string;
    readonly ok: boolean;
    readonly detail?: string;
};
export type UnitApproveReasonCode = "STALE_REPOSITORY" | "STALE_EDITOR" | "NO_PRIMARY" | "AMBIGUOUS_PRIMARY" | "INCOMPLETE_BINDINGS" | "FEATURE_GAP" | "UNSUPPORTED_LANGUAGE" | "WORKSPACE_MISMATCH" | "TIMEOUT" | "CANCELLED" | "VALIDATION_FAILED";
export type UnitApproveReason = {
    readonly code: UnitApproveReasonCode;
    readonly message: string;
    readonly pathRel?: string;
    readonly retryable?: boolean;
};
export type UnitApprovalDecision = {
    readonly schema: typeof UNIT_APPROVE_DECISION_SCHEMA;
    readonly decisionId: Sha256Hex;
    readonly emittedAt: string;
    readonly requestId: string;
    readonly testCase: {
        readonly id: string;
        readonly revisionHash: Sha256Hex;
        readonly ir: UnitApproveTcIr;
    };
    readonly repository: RepositoryRevision;
    readonly outcome: "READY" | "NOT_READY" | "FEATURE_GAP";
    readonly readiness: "READY_FOR_CODEGEN" | "NOT_READY" | "FEATURE_GAP";
    readonly authoritative: boolean;
    readonly primary: GroundedSymbol | null;
    readonly relatedFiles: readonly GroundedFile[];
    readonly existingTests: readonly ExistingTestEvidence[];
    readonly fieldBindings: readonly FieldBindingDecision[];
    readonly behaviorEvidence: readonly BehaviorEvidence[];
    readonly files: readonly FileSnapshot[];
    readonly confidence: {
        readonly band: "HIGH" | "MEDIUM" | "LOW";
        readonly score?: number;
        readonly reasons: readonly string[];
    };
    readonly checks: readonly UnitApproveCheck[];
    readonly refusalReasons: readonly UnitApproveReason[];
    readonly canonicalHash: Sha256Hex;
    /** Canonicalized input keys → values for projection into MD/DB. */
    readonly canonicalInput?: Readonly<Record<string, unknown>>;
};
export type UnitApproveResolveResult = {
    readonly schema: typeof UNIT_APPROVE_RESPONSE_SCHEMA;
    readonly requestId: string;
    readonly status: "RESOLVED";
    readonly decision: UnitApprovalDecision;
} | {
    readonly schema: typeof UNIT_APPROVE_RESPONSE_SCHEMA;
    readonly requestId: string;
    readonly status: "STALE" | "NOT_READY" | "FEATURE_GAP" | "UNSUPPORTED";
    readonly repository: RepositoryRevision;
    readonly reasons: readonly UnitApproveReason[];
    readonly retryable: boolean;
    readonly decision?: UnitApprovalDecision;
};
export type UnitApproveDecisionValidation = {
    ok: true;
} | {
    ok: false;
    code: "INVALID_SCHEMA" | "HASH_MISMATCH" | "NOT_AUTHORITATIVE" | "NOT_READY" | "INVALID_PRIMARY" | "MISSING_HASH" | "LOW_CONFIDENCE" | "INCOMPLETE_BINDINGS" | "FILE_MANIFEST_GAP" | "OUTCOME_MISMATCH";
};
/**
 * Validate an immutable Unit Approval decision.
 * For Gen consume-only, pass requireAuthoritative=true.
 */
export declare function validateUnitApprovalDecision(decision: UnitApprovalDecision | null | undefined, opts?: {
    requireAuthoritative?: boolean;
}): UnitApproveDecisionValidation;
/**
 * Project UnitApprovalDecision → legacy ApprovedGroundingDecision shape
 * for Gen consumers that still read v1 companions during transition.
 */
export declare function projectDecisionToV1Grounding(decision: UnitApprovalDecision): {
    schema: "aitest-unit-grounding-v1";
    emittedAt: string;
    testCaseId: string;
    outcome: "READY" | "NOT_READY" | "FEATURE_GAP";
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
    confidence: "HIGH" | "MEDIUM" | "LOW";
    freshness: "fresh" | "skipped";
    validateChecks: string[];
    source: string;
    targetScope?: UnitApproveTargetScope;
    targetProperties?: Array<{
        name: string;
        ownerType?: string;
        ownerPath?: string;
    }>;
    bindings?: Array<{
        label: string;
        property: string;
        ownerPath: string;
        ownerType?: string;
    }>;
    refusalReasons?: Array<{
        code: string;
        message: string;
    }>;
    decisionId: Sha256Hex;
    canonicalHash: Sha256Hex;
    repository?: RepositoryRevision;
};
/** Stable UTF-8 SHA-256 helper signature (runtime provides digest). */
export type Sha256Fn = (utf8: string | Uint8Array) => Sha256Hex;
/**
 * Build decisionId/canonicalHash over a decision body excluding those two fields.
 * Caller supplies a real SHA-256 implementation (Node crypto / Web Crypto).
 */
export declare function hashDecisionBody(bodyWithoutIds: Omit<UnitApprovalDecision, "decisionId" | "canonicalHash">, sha256: Sha256Fn): Sha256Hex;
export declare const DEFAULT_UNIT_APPROVE_LIMITS: Required<UnitApproveResolveLimits>;
