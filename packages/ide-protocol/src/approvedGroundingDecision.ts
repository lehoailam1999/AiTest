/**
 * Single source-grounding decision shared by Approve, Desktop Gen and IDE Gen.
 * Product-neutral; paths/properties must come from the indexed candidate packet.
 */

export const APPROVED_GROUNDING_SCHEMA =
  "aitest-unit-grounding-v1" as const;

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
  related: Array<{ pathRel: string; contentHash?: string }>;
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
  refusalReasons?: Array<{ code: string; message: string }>;
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
export const REQUIRED_GROUNDING_CHECKS = [
  "primary",
  "repository-fresh",
] as const;

/**
 * Content hashes travel in two spellings: the IDE emits `sha256:<hex>` while
 * re-hashing on the consumer side yields bare hex. Compare them by digest only.
 */
export function normalizeContentHash(value: string | null | undefined): string {
  return String(value || "")
    .trim()
    .replace(/^sha256:/i, "")
    .toLowerCase();
}

export function sameContentHash(
  a: string | null | undefined,
  b: string | null | undefined
): boolean {
  const left = normalizeContentHash(a);
  const right = normalizeContentHash(b);
  return Boolean(left) && left === right;
}

export type GroundingMarkerInput = {
  paths?: string[];
  codes?: string[];
};

export type GroundingValidationResult =
  | { ok: true }
  | {
      ok: false;
      code:
        | "INVALID_SCHEMA"
        | "NOT_AUTHORITATIVE"
        | "NOT_READY"
        | "INVALID_PRIMARY"
        | "MISSING_HASH"
        | "LOW_CONFIDENCE"
        | "STALE_DECISION"
        | "MISSING_CHECKS"
        | "INCOMPLETE_BINDINGS"
        | "MARKER_MISMATCH";
    };

function normPath(value: string): string {
  return String(value || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function markerCodeMatches(code: string, markers: string[]): boolean {
  const actual = String(code || "").trim().toLowerCase();
  return markers.some((raw) => {
    const marker = String(raw || "").trim().toLowerCase();
    return (
      marker === actual ||
      actual.startsWith(`${marker}.`) ||
      marker.startsWith(`${actual}.`)
    );
  });
}

/**
 * Pure authority validation. Runtime hash equality is checked by the packet
 * materializer after reading source; this validates the persisted decision.
 */
export function validateApprovedGroundingDecision(
  decision: ApprovedGroundingDecision | null | undefined,
  markers?: GroundingMarkerInput
): GroundingValidationResult {
  if (!decision || decision.schema !== APPROVED_GROUNDING_SCHEMA) {
    return { ok: false, code: "INVALID_SCHEMA" };
  }
  if (decision.authoritative !== true) {
    return { ok: false, code: "NOT_AUTHORITATIVE" };
  }
  if (decision.outcome && decision.outcome !== "READY") {
    return { ok: false, code: "NOT_READY" };
  }
  if (
    !normPath(decision.primary?.pathRel) ||
    !String(decision.primary?.code || "").trim() ||
    !String(decision.primary?.typeName || "").trim()
  ) {
    return { ok: false, code: "INVALID_PRIMARY" };
  }
  if (!String(decision.primary.contentHash || "").trim()) {
    return { ok: false, code: "MISSING_HASH" };
  }
  if (
    decision.confidence !== "HIGH" &&
    decision.confidence !== "MEDIUM"
  ) {
    return { ok: false, code: "LOW_CONFIDENCE" };
  }
  if (
    decision.freshness !== "fresh" &&
    decision.freshness !== "skipped"
  ) {
    return { ok: false, code: "STALE_DECISION" };
  }
  // Checks are the ids IDE Repository Intelligence passed during Approve.
  const checks = new Set(decision.validateChecks || []);
  for (const required of REQUIRED_GROUNDING_CHECKS) {
    if (!checks.has(required)) {
      return { ok: false, code: "MISSING_CHECKS" };
    }
  }
  if (decision.targetScope === "field" || decision.targetScope === "multi") {
    const bindings = decision.bindings || [];
    const props = decision.targetProperties || [];
    const expected = decision.targetScope === "multi" ? 2 : 1;
    if (
      bindings.length < expected &&
      props.filter((p) => p.name && p.ownerPath).length < expected
    ) {
      return { ok: false, code: "INCOMPLETE_BINDINGS" };
    }
  }
  if (markers) {
    const paths = markers.paths || [];
    const codes = markers.codes || [];
    const primary = normPath(decision.primary.pathRel).toLowerCase();
    if (
      (paths.length &&
        !paths.some((p) => normPath(p).toLowerCase() === primary)) ||
      (codes.length && !markerCodeMatches(decision.primary.code, codes))
    ) {
      return { ok: false, code: "MARKER_MISMATCH" };
    }
  }
  return { ok: true };
}
