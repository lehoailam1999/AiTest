import {
  DESKTOP_REQUIRED_UNIT_APPROVE_CAPS,
  UNIT_APPROVE_REQUEST_SCHEMA,
  extractTcSourceMarkers,
  type Sha256Hex,
  type UnitApprovalDecision,
  type UnitApproveResolveParams,
  type UnitApproveTcIr,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import {
  loadUnitEnrichProfileKnobs,
  type UnitFieldAliasMap,
} from "../approvedTcSync/loadUnitEnrichProfile";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "../ideBridge/session";
import { ideWorkspaceMatchesProject } from "../ideBridge/rootsMatch";

function normFieldLabel(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Project-owned aliases are deterministic hints only. The IDE still verifies
 * every property against its source-derived shortlist before accepting it.
 */
export function propertyBindingsFromAliases(
  tcIr: UnitApproveTcIr,
  aliases: UnitFieldAliasMap | null | undefined
): Array<{ label: string; property: string }> {
  if (!aliases) return [];
  const byLabel = new Map(
    Object.entries(aliases).map(([label, value]) => [normFieldLabel(label), value])
  );
  const labels = [
    ...new Set([
      ...(tcIr.testData.target?.fields || []),
      ...Object.keys(tcIr.testData.input || {}),
    ]),
  ];
  return labels.flatMap((label) => {
    const configured = byLabel.get(normFieldLabel(label));
    const property = Array.isArray(configured) ? configured[0] : configured;
    return typeof property === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(property)
      ? [{ label, property }]
      : [];
  });
}

/**
 * The API owns the CAS revision formula and returns it on every TestCase. Any
 * local recomputation drifts from the server and makes approve-unit reject the
 * decision with a revision conflict, so this fails closed instead of guessing.
 */
export function unitTestCaseContentRevision(tc: TestCase): Sha256Hex {
  const revision = tc.unitContentRevisionCurrent;
  if (typeof revision !== "string" || !/^sha256:[a-f0-9]{64}$/i.test(revision)) {
    throw new Error(
      "Test case is missing its server content revision — reload the test case list before Approve"
    );
  }
  return revision as Sha256Hex;
}

export async function resolveUnitApprovalViaIde(input: {
  projectId: string;
  projectRoot: string;
  tc: TestCase;
  tcIr: UnitApproveTcIr;
}): Promise<UnitApprovalDecision> {
  const client = getIdeRpcClientOrNull();
  const session = useIdeBridgeSession.getState();
  if (!client?.isConnected || session.status !== "connected") {
    throw new Error("Unit Approve requires a connected IDE bridge");
  }

  const missing = DESKTOP_REQUIRED_UNIT_APPROVE_CAPS.filter(
    (capability) => !session.capabilities.includes(capability)
  );
  if (missing.length) {
    throw new Error(
      `IDE extension is missing Unit Approve capabilities: ${missing.join(", ")}`
    );
  }
  if (!ideWorkspaceMatchesProject(session.workspaceRoot, input.projectRoot)) {
    throw new Error(
      `IDE workspace mismatch: expected ${input.projectRoot}, connected ${session.workspaceRoot || "(unknown)"}`
    );
  }

  const contentHash = unitTestCaseContentRevision(input.tc);
  const requestId = `unit-approve-${input.tc.id}-${Date.now().toString(36)}`;
  const markers = extractTcSourceMarkers(input.tc.testData || "");
  const pathRel = markers.paths[0]?.replace(/\\/g, "/");
  const symbol = markers.codes[0]
    ?.split(".")
    .pop()
    ?.replace(/\(.*$/, "")
    .trim();
  const profile = await loadUnitEnrichProfileKnobs(input.projectRoot);
  const propertyBindings = propertyBindingsFromAliases(
    input.tcIr,
    profile.fieldAliases
  );
  const params: UnitApproveResolveParams = {
    schema: UNIT_APPROVE_REQUEST_SCHEMA,
    requestId,
    projectId: input.projectId,
    testCaseRevision: {
      testCaseId: input.tc.id,
      contentHash,
      ...(input.tc.generatedFromHash
        ? { generatedFromHash: input.tc.generatedFromHash }
        : {}),
      ...(input.tc.generatedFromVersion != null
        ? { generatedFromVersion: input.tc.generatedFromVersion }
        : {}),
    },
    tcIr: input.tcIr,
    ...(pathRel || symbol || propertyBindings.length
      ? {
          manualSourceHint: {
            ...(pathRel ? { pathRel } : {}),
            ...(symbol ? { symbol } : {}),
            ...(propertyBindings.length ? { propertyBindings } : {}),
          },
        }
      : {}),
    // Repository resolve + two bounded CLI calls need a wider budget than Gen.
    limits: { deadlineMs: 150_000 },
  };
  const result = await client.unitApproveResolve(params);
  // RESOLVED = READY path. FEATURE_GAP/NOT_READY may still carry a decision
  // with nearest primary/bindings that must be persisted non-authoritatively.
  if (result.status === "RESOLVED") {
    if (
      result.requestId !== requestId ||
      result.decision.requestId !== requestId ||
      result.decision.testCase.id !== input.tc.id ||
      result.decision.testCase.revisionHash !== contentHash
    ) {
      throw new Error(
        "IDE returned a Unit Approve decision for a different TC revision"
      );
    }
    return result.decision;
  }
  if (
    (result.status === "FEATURE_GAP" || result.status === "NOT_READY") &&
    result.decision
  ) {
    if (
      result.decision.requestId !== requestId ||
      result.decision.testCase.id !== input.tc.id
    ) {
      throw new Error(
        "IDE returned a Unit Approve decision for a different TC"
      );
    }
    return result.decision;
  }
  const reason = (result.reasons || []).map((item) => item.message).join("; ");
  throw new Error(
    `IDE Unit Approve ${result.status}: ${reason || "resolution refused"}`
  );
}
