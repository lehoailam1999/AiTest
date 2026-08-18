/**
 * Unit Source Grounding Contract — serialization boundary only.
 *
 * IDE Repository Intelligence owns resolution. Desktop may persist the immutable
 * decision and project it for current Gen consumers, but it must never rebuild a
 * decision from TC markers or `index.db`.
 */
import type {
  ApprovedGroundingDecision,
  UnitApprovalDecision,
} from "@aitest/ide-protocol";
import {
  APPROVED_GROUNDING_SCHEMA,
  projectDecisionToV1Grounding,
} from "@aitest/ide-protocol";

export const UNIT_GROUNDING_CONTRACT_SCHEMA = APPROVED_GROUNDING_SCHEMA;
export type UnitSourceGroundingContract = ApprovedGroundingDecision;

export type UnitDecisionGroundingJson = UnitApprovalDecision & {
  readonly legacyV1: ReturnType<typeof projectDecisionToV1Grounding>;
  readonly deps: string[];
  readonly targetProperties?: ReturnType<
    typeof projectDecisionToV1Grounding
  >["targetProperties"];
  readonly bindings?: ReturnType<
    typeof projectDecisionToV1Grounding
  >["bindings"];
  readonly source: string;
};

/**
 * Persist v2 as authority. `legacyV1` is a deterministic projection of that
 * exact decision for existing consume-only Gen readers, never an independent
 * Desktop resolution.
 */
export function buildGroundingJsonFromDecision(
  decision: UnitApprovalDecision
): UnitDecisionGroundingJson {
  const legacyV1 = projectDecisionToV1Grounding(decision);
  return {
    ...decision,
    legacyV1,
    deps: legacyV1.deps,
    targetProperties: legacyV1.targetProperties,
    bindings: legacyV1.bindings,
    source: legacyV1.source,
  };
}

/** Companion decision path next to an Approved TC Markdown projection. */
export function unitGroundingContractRelPath(mdRelPath: string): string {
  const normalized = String(mdRelPath || "")
    .replace(/\\/g, "/")
    .replace(/^\/+/, "");
  return /\.md$/i.test(normalized)
    ? normalized.replace(/\.md$/i, ".grounding.json")
    : `${normalized}.grounding.json`;
}

export function serializeUnitSourceGroundingContract(
  contract: UnitSourceGroundingContract | UnitDecisionGroundingJson
): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}
