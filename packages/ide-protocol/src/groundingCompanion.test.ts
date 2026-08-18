import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  validateApprovedGroundingDecision,
} from "./approvedGroundingDecision.js";
import { parseGroundingCompanion } from "./groundingCompanion.js";
import {
  UNIT_APPROVE_DECISION_SCHEMA,
  projectDecisionToV1Grounding,
  type UnitApprovalDecision,
} from "./unitApproveRpc.js";

function sha256(value: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

const range = {
  start: { line: 21, character: 0 },
  end: { line: 302, character: 1 },
};

function readyDecision(): UnitApprovalDecision {
  return {
    schema: UNIT_APPROVE_DECISION_SCHEMA,
    decisionId: sha256("decision"),
    canonicalHash: sha256("decision"),
    emittedAt: "2026-08-16T19:06:56.853Z",
    requestId: "req-1",
    testCase: {
      id: "tc-1",
      revisionHash: sha256("tc"),
      ir: {
        testData: { target: { scope: "field", fields: ["moTa"] }, input: {} },
      } as UnitApprovalDecision["testCase"]["ir"],
    },
    repository: {
      workspaceId: sha256("workspace"),
      vcs: "git",
      dirty: false,
      capturedAt: "2026-08-16T19:06:56.853Z",
    },
    outcome: "READY",
    readiness: "READY_FOR_CODEGEN",
    authoritative: true,
    primary: {
      symbolId: "handler",
      pathRel: "src/App/EvidenceCreateCommandHandler.cs",
      name: "EvidenceCreateCommandHandler",
      kind: "class",
      selectionRange: range,
      fullRange: range,
      fileHash: sha256("primary"),
    },
    relatedFiles: [],
    existingTests: [],
    fieldBindings: [
      {
        label: "moTa",
        property: "Description",
        owner: {
          pathRel: "src/Dto/EvidenceDto.cs",
          typeName: "EvidenceDto",
          range,
          fileHash: sha256("dto"),
        },
        source: "bounded_shortlist_pick",
        confidence: "MEDIUM",
      },
    ],
    behaviorEvidence: [],
    files: [],
    confidence: { band: "HIGH", reasons: [] },
    checks: [
      { id: "primary", ok: true },
      { id: "repository-fresh", ok: true },
    ],
    refusalReasons: [],
  };
}

describe("grounding companion reader", () => {
  it("reads the persisted v2 decision through its embedded v1 projection", () => {
    const decision = readyDecision();
    const persisted = {
      ...decision,
      legacyV1: projectDecisionToV1Grounding(decision),
    };
    const contract = parseGroundingCompanion(JSON.stringify(persisted));
    assert.equal(contract?.schema, "aitest-unit-grounding-v1");
    assert.equal(contract?.primary.code, "EvidenceCreateCommandHandler");
    assert.deepEqual(validateApprovedGroundingDecision(contract), { ok: true });
  });

  it("projects the decision itself when no v1 copy was persisted", () => {
    const contract = parseGroundingCompanion(JSON.stringify(readyDecision()));
    assert.equal(contract?.authoritative, true);
    assert.equal(
      contract?.primary.pathRel,
      "src/App/EvidenceCreateCommandHandler.cs"
    );
  });

  it("still reads a plain v1 companion and rejects anything else", () => {
    const v1 = projectDecisionToV1Grounding(readyDecision());
    assert.equal(parseGroundingCompanion(JSON.stringify(v1))?.schema, v1.schema);
    assert.equal(parseGroundingCompanion('{"schema":"something-else"}'), null);
    assert.equal(parseGroundingCompanion("not json"), null);
  });
});
