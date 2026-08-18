import type { UnitApprovalDecision } from "@aitest/ide-protocol";
import { testcases } from "../../api";
import type { TestCase } from "../../api/types";
import { writeUnitDecisionArtifacts } from "../approvedTcSync";
import { mergeLearnedFieldAliases } from "../approvedTcSync/loadUnitEnrichProfile";
import { emitsSutMarkers, projectUnitApprovalDecision } from "./decisionProjection";

function sameIdentifier(a: string, b: string): boolean {
  const flatten = (value: string) =>
    value
      .normalize("NFD")
      .replace(/\p{Diacritic}/gu, "")
      .replace(/[^a-z0-9]/gi, "")
      .toLowerCase();
  return flatten(a) === flatten(b);
}

/**
 * A binding is worth remembering when the resolver verified it against real
 * source and it actually bridges a business label to a different identifier.
 * Waiting for a fully READY case never builds the alias file, because the very
 * cases that still need the bridge are the ones being refused.
 */
function learnableAliases(
  decision: UnitApprovalDecision
): { label: string; property: string }[] {
  if (!emitsSutMarkers(decision)) return [];
  return decision.fieldBindings
    .filter(
      (binding) =>
        binding.label &&
        binding.property &&
        binding.confidence !== "LOW" &&
        !sameIdentifier(binding.label, binding.property)
    )
    .map((binding) => ({ label: binding.label, property: binding.property }));
}

export async function persistUnitApprovalDecision(input: {
  projectId: string;
  projectRoot: string;
  tc: TestCase;
  decision: UnitApprovalDecision;
  requirementTitle?: string | null;
  deletePaths?: string[];
}): Promise<TestCase> {
  const projection = projectUnitApprovalDecision(input.decision, input.tc.testData);
  const approved = await testcases.approveUnit({
    id: input.tc.id,
    expectedRevision: input.decision.testCase.revisionHash,
    decision: input.decision,
    testData: projection.testData,
  });
  const projectedTc: TestCase = {
    ...approved,
    testData: approved.testData || projection.testData,
    automationReady: projection.automationReady,
    reviewStatus: "Approved",
  };
  const artifacts = await writeUnitDecisionArtifacts(input.decision, projectedTc, {
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    requirementTitle: input.requirementTitle,
    deletePaths: input.deletePaths,
  });
  if (!artifacts.ok) {
    throw new Error(
      artifacts.errors[0] ||
        "Unit decision was approved but its source-grounding artifacts were not written"
    );
  }
  try {
    const aliases = learnableAliases(input.decision);
    if (aliases.length) {
      await mergeLearnedFieldAliases(input.projectRoot, aliases);
    }
  } catch {
    /* aliases are a cache, not the TC source of truth */
  }
  return projectedTc;
}
