/**
 * Unit Approve v2 — IDE Repository Intelligence contract.
 * Desktop sends structured TC IR; IDE returns one immutable decision.
 * Markdown markers are projections only — never authority.
 */

export const UNIT_APPROVE_REQUEST_SCHEMA =
  "aitest-unit-approve-request-v2" as const;
export const UNIT_APPROVE_RESPONSE_SCHEMA =
  "aitest-unit-approve-response-v2" as const;
export const UNIT_APPROVE_DECISION_SCHEMA =
  "aitest-unit-approve-decision-v2" as const;
export const UNIT_TC_IR_SCHEMA = "aitest-unit-tc-ir-v1" as const;

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

export type UnitApproveScenario =
  | "POSITIVE"
  | "NEGATIVE"
  | "BOUNDARY"
  | "NULL"
  | "EMPTY"
  | "BLANK"
  | "DUPLICATE"
  | "NOT_FOUND"
  | "AUTHORIZATION"
  | "INVALID_STATE"
  | "DEPENDENCY_FAILURE";

export type UnitApprovePrimaryBucket =
  | "BUSINESS_RULES"
  | "VALIDATION_DATA"
  | "ERROR_HANDLING"
  | "ACCEPTANCE";

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

export type GroundedSymbolKind =
  | "class"
  | "interface"
  | "method"
  | "function"
  | "property"
  | "constructor";

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

export type GroundedFileRole =
  | "definition"
  | "implementation"
  | "dependency"
  | "contract"
  | "dto"
  | "validator"
  | "repository"
  | "existing_test"
  | "behavior_evidence";

export type GroundedFile = {
  readonly pathRel: string;
  readonly language: string;
  readonly roles: readonly GroundedFileRole[];
  readonly fileHash: Sha256Hex;
  readonly relatedToSymbolId?: string;
  readonly evidenceRanges: readonly SourceRange[];
  readonly discoveredBy: readonly (
    | "workspace_symbol"
    | "definition"
    | "references"
    | "implementation"
    | "dependency"
    | "test_search"
  )[];
};

export type ExistingTestEvidence = {
  readonly pathRel: string;
  readonly fileHash: Sha256Hex;
  readonly framework?:
    | "jest"
    | "vitest"
    | "xunit"
    | "nunit"
    | "pytest"
    | "junit";
  readonly symbol?: GroundedSymbol;
  readonly relationship:
    | "references_primary"
    | "imports_primary"
    | "name_match"
    | "same_feature";
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
  readonly source:
    | "exact_symbol"
    | "input_key"
    | "display_attribute"
    | "approved_alias"
    | "bounded_shortlist_pick";
  readonly confidence: "HIGH" | "MEDIUM";
};

export type BehaviorEvidence = {
  readonly behaviorId: string;
  readonly observable: string;
  readonly kind:
    | "validation"
    | "branch"
    | "throw"
    | "persistence"
    | "query"
    | "authorization"
    | "state_transition";
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

export type UnitApproveReasonCode =
  | "STALE_REPOSITORY"
  | "STALE_EDITOR"
  | "NO_PRIMARY"
  | "AMBIGUOUS_PRIMARY"
  | "INCOMPLETE_BINDINGS"
  | "FEATURE_GAP"
  | "UNSUPPORTED_LANGUAGE"
  | "WORKSPACE_MISMATCH"
  | "TIMEOUT"
  | "CANCELLED"
  | "VALIDATION_FAILED";

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

export type UnitApproveResolveResult =
  | {
      readonly schema: typeof UNIT_APPROVE_RESPONSE_SCHEMA;
      readonly requestId: string;
      readonly status: "RESOLVED";
      readonly decision: UnitApprovalDecision;
    }
  | {
      readonly schema: typeof UNIT_APPROVE_RESPONSE_SCHEMA;
      readonly requestId: string;
      readonly status: "STALE" | "NOT_READY" | "FEATURE_GAP" | "UNSUPPORTED";
      readonly repository: RepositoryRevision;
      readonly reasons: readonly UnitApproveReason[];
      readonly retryable: boolean;
      readonly decision?: UnitApprovalDecision;
    };

export type UnitApproveDecisionValidation =
  | { ok: true }
  | {
      ok: false;
      code:
        | "INVALID_SCHEMA"
        | "HASH_MISMATCH"
        | "NOT_AUTHORITATIVE"
        | "NOT_READY"
        | "INVALID_PRIMARY"
        | "MISSING_HASH"
        | "LOW_CONFIDENCE"
        | "INCOMPLETE_BINDINGS"
        | "FILE_MANIFEST_GAP"
        | "OUTCOME_MISMATCH";
    };

function normPath(value: string): string {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
}

function isSha256(value: unknown): value is Sha256Hex {
  return (
    typeof value === "string" &&
    /^sha256:[a-f0-9]{64}$/i.test(value)
  );
}

/**
 * Validate an immutable Unit Approval decision.
 * For Gen consume-only, pass requireAuthoritative=true.
 */
export function validateUnitApprovalDecision(
  decision: UnitApprovalDecision | null | undefined,
  opts?: { requireAuthoritative?: boolean }
): UnitApproveDecisionValidation {
  if (!decision || decision.schema !== UNIT_APPROVE_DECISION_SCHEMA) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
  if (!isSha256(decision.decisionId) || !isSha256(decision.canonicalHash)) {
    return { ok: false, code: "HASH_MISMATCH" };
  }
  if (!isSha256(decision.testCase?.revisionHash)) {
    return { ok: false, code: "HASH_MISMATCH" };
  }
  if (
    decision.outcome === "READY" &&
    decision.readiness !== "READY_FOR_CODEGEN"
  ) {
    return { ok: false, code: "OUTCOME_MISMATCH" };
  }
  if (
    decision.outcome !== "READY" &&
    decision.authoritative === true
  ) {
    return { ok: false, code: "NOT_AUTHORITATIVE" };
  }
  if (opts?.requireAuthoritative) {
    if (decision.authoritative !== true || decision.outcome !== "READY") {
      return {
        ok: false,
        code: decision.outcome === "READY" ? "NOT_AUTHORITATIVE" : "NOT_READY",
      };
    }
    if (
      decision.confidence.band !== "HIGH" &&
      decision.confidence.band !== "MEDIUM"
    ) {
      return { ok: false, code: "LOW_CONFIDENCE" };
    }
  }

  if (decision.outcome === "READY" || decision.primary) {
    if (
      !decision.primary ||
      !normPath(decision.primary.pathRel) ||
      !String(decision.primary.name || "").trim() ||
      !isSha256(decision.primary.fileHash)
    ) {
      return { ok: false, code: "INVALID_PRIMARY" };
    }
  }

  const fileMap = new Map(
    (decision.files || []).map((f) => [normPath(f.pathRel).toLowerCase(), f])
  );
  for (const f of decision.files || []) {
    if (!isSha256(f.sha256) || !normPath(f.pathRel)) {
      return { ok: false, code: "MISSING_HASH" };
    }
  }
  if (decision.primary) {
    const key = normPath(decision.primary.pathRel).toLowerCase();
    const snap = fileMap.get(key);
    if (!snap || snap.sha256 !== decision.primary.fileHash) {
      return { ok: false, code: "FILE_MANIFEST_GAP" };
    }
  }
  for (const rel of decision.relatedFiles || []) {
    const key = normPath(rel.pathRel).toLowerCase();
    const snap = fileMap.get(key);
    if (!snap || snap.sha256 !== rel.fileHash) {
      return { ok: false, code: "FILE_MANIFEST_GAP" };
    }
  }
  for (const b of decision.fieldBindings || []) {
    const key = normPath(b.owner.pathRel).toLowerCase();
    const snap = fileMap.get(key);
    if (!snap || snap.sha256 !== b.owner.fileHash) {
      return { ok: false, code: "FILE_MANIFEST_GAP" };
    }
  }

  const scope = decision.testCase.ir.testData.target?.scope;
  if (scope === "field" || scope === "multi") {
    const labels = decision.testCase.ir.testData.target?.fields || [];
    const expected = scope === "multi" ? Math.max(2, labels.length) : 1;
    if ((decision.fieldBindings || []).length < expected) {
      if (opts?.requireAuthoritative || decision.outcome === "READY") {
        return { ok: false, code: "INCOMPLETE_BINDINGS" };
      }
    }
  }

  return { ok: true };
}

/**
 * Project UnitApprovalDecision → legacy ApprovedGroundingDecision shape
 * for Gen consumers that still read v1 companions during transition.
 */
export function projectDecisionToV1Grounding(
  decision: UnitApprovalDecision
): {
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
  related: Array<{ pathRel: string; contentHash?: string }>;
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
  refusalReasons?: Array<{ code: string; message: string }>;
  decisionId: Sha256Hex;
  canonicalHash: Sha256Hex;
  repository?: RepositoryRevision;
} {
  const primary = decision.primary;
  const typeName =
    primary?.kind === "method" || primary?.kind === "constructor"
      ? primary.containerName || primary.name
      : primary?.name || "";
  const methodName =
    primary?.kind === "method" || primary?.kind === "constructor"
      ? primary.name
      : undefined;
  const code = methodName ? `${typeName}.${methodName}` : typeName;
  return {
    schema: "aitest-unit-grounding-v1",
    emittedAt: decision.emittedAt,
    testCaseId: decision.testCase.id,
    outcome: decision.outcome,
    authoritative: decision.authoritative,
    primary: {
      pathRel: primary?.pathRel || "",
      code,
      typeName,
      methodName,
      line: primary?.selectionRange.start.line,
      endLine: primary?.selectionRange.end.line,
      contentHash: primary?.fileHash,
    },
    related: decision.relatedFiles.map((f) => ({
      pathRel: f.pathRel,
      contentHash: f.fileHash,
    })),
    deps: decision.relatedFiles.map((f) => f.pathRel),
    confidence: decision.confidence.band,
    freshness: "fresh",
    validateChecks: decision.checks.filter((c) => c.ok).map((c) => c.id),
    source: "ide-repository-intelligence",
    targetScope: decision.testCase.ir.testData.target?.scope,
    targetProperties: decision.fieldBindings.map((b) => ({
      name: b.property,
      ownerType: b.owner.typeName,
      ownerPath: b.owner.pathRel,
    })),
    bindings: decision.fieldBindings.map((b) => ({
      label: b.label,
      property: b.property,
      ownerPath: b.owner.pathRel,
      ownerType: b.owner.typeName,
    })),
    refusalReasons: decision.refusalReasons.map((reason) => ({
      code: reason.code,
      message: reason.message,
    })),
    decisionId: decision.decisionId,
    canonicalHash: decision.canonicalHash,
    repository: decision.repository,
  };
}

/** Stable UTF-8 SHA-256 helper signature (runtime provides digest). */
export type Sha256Fn = (utf8: string | Uint8Array) => Sha256Hex;

/**
 * Build decisionId/canonicalHash over a decision body excluding those two fields.
 * Caller supplies a real SHA-256 implementation (Node crypto / Web Crypto).
 */
export function hashDecisionBody(
  bodyWithoutIds: Omit<UnitApprovalDecision, "decisionId" | "canonicalHash">,
  sha256: Sha256Fn
): Sha256Hex {
  const canonical = JSON.stringify(bodyWithoutIds);
  return sha256(canonical);
}

export const DEFAULT_UNIT_APPROVE_LIMITS: Required<UnitApproveResolveLimits> = {
  maxSymbolCandidates: 20,
  maxReferences: 20,
  maxImplementations: 12,
  maxRelatedFiles: 8,
  maxExistingTests: 6,
  maxEvidencePerFile: 8,
  maxFileBytes: 32768,
  /**
   * Covers IDE symbol resolve plus two bounded CLI calls: the identifier
   * proposal that bridges business vocabulary to source names, and the field
   * shortlist pick. A cold agent invocation alone can take about a minute.
   */
  deadlineMs: 150_000,
};
