import {
  UNIT_APPROVE_DECISION_SCHEMA,
  hashDecisionBody,
  validateUnitApprovalDecision,
  type BehaviorEvidence,
  type ExistingTestEvidence,
  type FieldBindingDecision,
  type GroundedFile,
  type GroundedSymbol,
  type RepositoryRevision,
  type UnitApprovalDecision,
  type UnitApproveCheck,
  type UnitApproveReason,
  type UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { requiredBehaviorSignals } from "./behaviorEvidence";
import { sha256 } from "./hash";
import type { FieldBindingDiagnostics } from "./resolveBindings";
import type {
  ProposalDiagnostics,
  SourceDiscoveryDiagnostics,
  SymbolIndexDiagnostics,
} from "./resolvePrimary";
import type { RepoDocument } from "./runtime";

export type BuildDecisionInput = {
  params: UnitApproveResolveParams;
  repository: RepositoryRevision;
  primary: GroundedSymbol | null;
  relatedPaths: readonly string[];
  bindings: readonly FieldBindingDecision[];
  fieldBinding?: FieldBindingDiagnostics;
  evidence: readonly BehaviorEvidence[];
  existingTests?: readonly ExistingTestEvidence[];
  documents: ReadonlyMap<string, RepoDocument>;
  ambiguousPrimary: boolean;
  proposal?: ProposalDiagnostics;
  sourceDiscovery?: SourceDiscoveryDiagnostics;
  symbolIndex?: SymbolIndexDiagnostics;
  hintIgnored?: string;
};

/**
 * The business-vocabulary bridge is the step most likely to fail invisibly, so
 * every decision records whether it ran, what it suggested, and what the
 * repository confirmed.
 */
function proposalCheck(
  proposal: ProposalDiagnostics | undefined
): UnitApproveCheck {
  if (!proposal || (!proposal.attempted && proposal.skipped === "not_needed")) {
    return { id: "symbol-proposal", ok: true, detail: "not needed" };
  }
  if (!proposal.attempted) {
    return {
      id: "symbol-proposal",
      ok: false,
      detail: `skipped: ${proposal.skipped || "unknown"}`,
    };
  }
  const engine =
    (proposal.engine ? ` via ${proposal.engine}` : "") +
    (proposal.memoHit ? " (reused in batch)" : "");
  if (proposal.error) {
    return { id: "symbol-proposal", ok: false, detail: `failed${engine}: ${proposal.error}` };
  }
  return {
    id: "symbol-proposal",
    ok: proposal.verifiedSymbols.length > 0,
    detail:
      `proposed ${proposal.proposedSymbols.join(", ") || "none"}` +
      `; repository confirmed ${proposal.verifiedSymbols.join(", ") || "none"}${engine}`,
  };
}

/**
 * The vocabulary bridge for fields fails the same invisible way the symbol one
 * does, so the decision records whether the picker ran, what it answered and
 * which answers the shortlist refused.
 */
function fieldBindingPickCheck(
  diagnostics: FieldBindingDiagnostics | undefined
): UnitApproveCheck[] {
  if (!diagnostics || !diagnostics.labels.length) return [];
  const engine =
    (diagnostics.engine ? ` via ${diagnostics.engine}` : "") +
    (diagnostics.pickerMemoHit ? " (reused in batch)" : "");
  const parts = [
    `${diagnostics.candidateCount} source properties in shortlist`,
    `deterministic: ${diagnostics.deterministic.join(", ") || "none"}`,
  ];
  if (!diagnostics.pickerAttempted) {
    parts.push(`picker skipped: ${diagnostics.pickerSkipped || "unknown"}`);
    return [
      {
        id: "field-binding-pick",
        ok: diagnostics.pickerSkipped === "not_needed",
        detail: parts.join("; "),
      },
    ];
  }
  parts.push(`accepted: ${diagnostics.accepted.join(", ") || "none"}`);
  if (diagnostics.rejected.length) {
    parts.push(`refused outside shortlist: ${diagnostics.rejected.join(", ")}`);
  }
  if (diagnostics.declaredMissing.length) {
    parts.push(`reported absent from source: ${diagnostics.declaredMissing.join(", ")}`);
  }
  if (diagnostics.pickerError) parts.push(`error${engine}: ${diagnostics.pickerError}`);
  else if (engine) parts.push(`picked${engine}`);
  return [
    {
      id: "field-binding-pick",
      ok: !diagnostics.pickerError && diagnostics.unresolved.length === 0,
      detail: parts.join("; "),
    },
  ];
}

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/** Rewrite every matching input key to its source-backed property. */
function canonicalizeInput(
  input: Readonly<Record<string, unknown>> | undefined,
  bindings: readonly FieldBindingDecision[]
): Readonly<Record<string, unknown>> | undefined {
  if (!input) return input;
  const entries = Object.entries(input);
  if (!entries.length || !bindings.length) return input;
  const out: Record<string, unknown> = {};
  entries.forEach(([key, value]) => {
    const keyNorm = norm(key);
    const binding = bindings.find(
      (item) => norm(item.label) === keyNorm || norm(item.property) === keyNorm
    );
    out[binding?.property || key] = value;
  });
  return out;
}

function languageRole(pathRel: string): GroundedFile["roles"][number] {
  if (/(dto|model|contract|request|input)/i.test(pathRel)) return "dto";
  if (/(validator|validation)/i.test(pathRel)) return "validator";
  if (/(repository|store|dao)/i.test(pathRel)) return "repository";
  return "dependency";
}

export function buildDecision(input: BuildDecisionInput): UnitApprovalDecision {
  const {
    params,
    repository,
    primary,
    bindings,
    evidence,
    documents,
    ambiguousPrimary,
  } = input;
  const existingTests = input.existingTests || [];
  const labels = [
    ...new Map(
      (params.tcIr.testData.target?.fields || []).map((label) => [norm(label), label])
    ).values(),
  ];
  const scope = params.tcIr.testData.target?.scope;
  // `multi` describes the value cardinality (for example one CaseRecords
  // collection), not a requirement to bind two different source properties.
  // Readiness is based only on declared target labels; input-only aliases remain
  // useful for canonical payload projection but must not affect this count.
  const expectedBindings = scope === "aggregate" ? 0 : labels.length;
  const targetBindings = bindings.filter((binding) =>
    labels.some((label) => norm(label) === norm(binding.label))
  );
  const boundLabels = new Set(targetBindings.map((binding) => norm(binding.label)));
  const bindingsComplete =
    expectedBindings === 0 ||
    labels.every((label) => boundLabels.has(norm(label)));
  const requiredSignals = requiredBehaviorSignals(params);
  const foundSignals = new Set(evidence.flatMap((item) => item.matchedSignals));
  const missingSignals = requiredSignals.filter((signal) => !foundSignals.has(signal));

  // A label the repository genuinely does not model is a feature gap, not a
  // resolver failure; only an unfinished or broken binding step is NOT_READY.
  const fieldBinding = input.fieldBinding;
  const unboundLabels = fieldBinding?.unresolved || [];
  const missingFields = unboundLabels.filter((label) =>
    (fieldBinding?.declaredMissing || []).includes(label)
  );
  const fieldsAbsentFromSource =
    !bindingsComplete &&
    unboundLabels.length > 0 &&
    missingFields.length === unboundLabels.length &&
    !fieldBinding?.pickerError;
  const bindingStepFailed = Boolean(
    fieldBinding?.pickerError || fieldBinding?.pickerSkipped === "no_budget"
  );

  let outcome: UnitApprovalDecision["outcome"] = "READY";
  if (!primary || ambiguousPrimary) outcome = "NOT_READY";
  else if (!bindingsComplete) {
    outcome = fieldsAbsentFromSource ? "FEATURE_GAP" : "NOT_READY";
  } else if (missingSignals.length) outcome = "FEATURE_GAP";
  const authoritative = outcome === "READY";

  const indexUnavailable = Boolean(
    input.symbolIndex && input.symbolIndex.queries > 0 && input.symbolIndex.hits === 0
  );
  // The vocabulary bridge is what reaches English identifiers from a business
  // test case, so losing it to a timeout says nothing about the repository.
  const proposerFailed = Boolean(input.proposal?.attempted && input.proposal.error);
  const refusalReasons: UnitApproveReason[] = [];
  if (!primary) {
    refusalReasons.push({
      code: "NO_PRIMARY",
      // An unresponsive index is a transient environment problem, not a verdict
      // about the repository, so it must be retryable and say so.
      message: indexUnavailable
        ? "The IDE symbol index returned no results at all; it is probably still loading the workspace."
        : proposerFailed
          ? `The identifier proposer did not answer (${input.proposal?.error}), so no candidate could be confirmed.`
          : "No repository symbol could be grounded as the primary subject.",
      retryable: indexUnavailable || proposerFailed,
    });
  } else if (ambiguousPrimary) {
    refusalReasons.push({
      code: "AMBIGUOUS_PRIMARY",
      message: "Multiple primary symbols have the same repository relevance.",
      retryable: false,
    });
  }
  if (primary && !bindingsComplete) {
    const counted = `Resolved ${targetBindings.length} of ${expectedBindings} required field bindings`;
    if (fieldsAbsentFromSource) {
      refusalReasons.push({
        code: "FEATURE_GAP",
        message: `${counted}: the source has no property for ${missingFields.join(", ")}.`,
        pathRel: primary.pathRel,
        retryable: false,
      });
    } else {
      refusalReasons.push({
        code: "INCOMPLETE_BINDINGS",
        message: bindingStepFailed
          ? `${counted}; the field-binding step could not finish (${
              fieldBinding?.pickerError || "no time left in the Approve budget"
            }).`
          : `${counted}${
              unboundLabels.length ? ` — still unbound: ${unboundLabels.join(", ")}` : ""
            }.`,
        // A step that never completed can succeed on the next attempt; a
        // completed step that simply found nothing cannot.
        retryable: bindingStepFailed,
      });
    }
  }
  if (primary && bindingsComplete && missingSignals.length) {
    refusalReasons.push({
      code: "FEATURE_GAP",
      message: `No source evidence was found for: ${missingSignals.join(", ")}.`,
      pathRel: primary.pathRel,
      retryable: false,
    });
  }

  const files = [...documents.values()].map((doc) => ({
    pathRel: doc.pathRel.replace(/\\/g, "/"),
    language: doc.language,
    sha256: sha256(doc.text),
    byteSize: Buffer.byteLength(doc.text, "utf8"),
    documentVersion: doc.version,
    source: doc.dirty ? ("dirty_editor" as const) : ("saved_disk" as const),
  }));
  const fileByPath = new Map(files.map((file) => [file.pathRel.toLowerCase(), file]));
  const relevantPaths = new Set([
    ...input.relatedPaths,
    ...bindings.map((binding) => binding.owner.pathRel),
    ...evidence.map((item) => item.pathRel),
  ]);
  relevantPaths.delete(primary?.pathRel || "");
  const relatedFiles: GroundedFile[] = [...relevantPaths]
    .map((pathRel): GroundedFile | null => {
      const normalized = pathRel.replace(/\\/g, "/");
      const file = fileByPath.get(normalized.toLowerCase());
      if (!file) return null;
      const hasBehavior = evidence.some(
        (item) => item.pathRel.toLowerCase() === normalized.toLowerCase()
      );
      return {
        pathRel: normalized,
        language: file.language,
        roles: hasBehavior ? [languageRole(normalized), "behavior_evidence"] : [languageRole(normalized)],
        fileHash: file.sha256,
        relatedToSymbolId: primary?.symbolId,
        evidenceRanges: evidence
          .filter((item) => item.pathRel.toLowerCase() === normalized.toLowerCase())
          .map((item) => item.range),
        discoveredBy: ["workspace_symbol"],
      };
    })
    .filter((item): item is GroundedFile => item !== null);

  const confidenceBand =
    outcome === "READY"
      ? bindings.some((binding) => binding.confidence === "MEDIUM")
        ? "MEDIUM"
        : "HIGH"
      : "LOW";
  const body: Omit<UnitApprovalDecision, "decisionId" | "canonicalHash"> = {
    schema: UNIT_APPROVE_DECISION_SCHEMA,
    emittedAt: repository.capturedAt,
    requestId: params.requestId,
    testCase: {
      id: params.testCaseRevision.testCaseId,
      revisionHash: params.testCaseRevision.contentHash,
      ir: params.tcIr,
    },
    repository,
    outcome,
    readiness:
      outcome === "READY"
        ? "READY_FOR_CODEGEN"
        : outcome === "FEATURE_GAP"
          ? "FEATURE_GAP"
          : "NOT_READY",
    authoritative,
    primary,
    relatedFiles,
    existingTests,
    fieldBindings: bindings,
    behaviorEvidence: evidence,
    files,
    confidence: {
      band: confidenceBand,
      score: outcome === "READY" ? (confidenceBand === "HIGH" ? 0.95 : 0.78) : 0,
      reasons:
        outcome === "READY"
          ? ["Primary, file manifest, and required bindings are grounded."]
          : refusalReasons.map((reason) => reason.message),
    },
    checks: [
      { id: "primary", ok: Boolean(primary) && !ambiguousPrimary },
      { id: "field-bindings", ok: bindingsComplete },
      ...fieldBindingPickCheck(fieldBinding),
      {
        id: "behavior-evidence",
        ok: missingSignals.length === 0,
        detail: missingSignals.length
          ? `Missing ${missingSignals.join(", ")}`
          : undefined,
      },
      { id: "repository-fresh", ok: true },
      ...(input.sourceDiscovery
        ? [
            {
              id: "source-discovery",
              ok: input.sourceDiscovery.candidateCount > 0,
              detail:
                `${input.sourceDiscovery.candidateCount} candidates from ` +
                `${input.sourceDiscovery.hitPaths.length} source files using exact business phrases`,
            } satisfies UnitApproveCheck,
          ]
        : []),
      proposalCheck(input.proposal),
      ...(input.symbolIndex
        ? [
            {
              id: "symbol-index",
              ok: input.symbolIndex.hits > 0 || input.symbolIndex.queries === 0,
              detail:
                `${input.symbolIndex.hits} hits over ${input.symbolIndex.queries} queries` +
                (input.symbolIndex.retried ? " (retried after empty index)" : ""),
            } satisfies UnitApproveCheck,
          ]
        : []),
      ...(input.hintIgnored
        ? [
            {
              id: "source-marker",
              ok: false,
              detail: `ignored: ${input.hintIgnored}`,
            } satisfies UnitApproveCheck,
          ]
        : []),
    ],
    refusalReasons,
    canonicalInput: canonicalizeInput(
      params.tcIr.testData.input,
      bindings
    ),
  };
  const digest = hashDecisionBody(body, sha256);
  const decision: UnitApprovalDecision = {
    ...body,
    decisionId: digest,
    canonicalHash: digest,
  };
  const validation = validateUnitApprovalDecision(decision, {
    requireAuthoritative: authoritative,
  });
  if (!validation.ok) {
    throw new Error(`Invalid Unit Approval decision: ${validation.code}`);
  }
  return decision;
}
