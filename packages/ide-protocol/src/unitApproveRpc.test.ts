import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  DEFAULT_UNIT_APPROVE_LIMITS,
  UNIT_APPROVE_DECISION_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  hashDecisionBody,
  projectDecisionToV1Grounding,
  validateUnitApprovalDecision,
  type UnitApprovalDecision,
  type UnitApproveTcIr,
} from "./unitApproveRpc.js";

function sha256(utf8: string | Uint8Array): `sha256:${string}` {
  const h = createHash("sha256");
  h.update(typeof utf8 === "string" ? utf8 : Buffer.from(utf8));
  return `sha256:${h.digest("hex")}`;
}

const range = {
  start: { line: 10, character: 0 },
  end: { line: 40, character: 1 },
};

function sampleIr(overrides?: Partial<UnitApproveTcIr>): UnitApproveTcIr {
  return {
    schema: UNIT_TC_IR_SCHEMA,
    testCaseId: "TC-013",
    title: "Mô tả toàn khoảng trắng",
    requirement: {
      title: "Tạo vật chứng",
      requirementIds: ["BR-19"],
      behaviorId: "BR-19-B01",
    },
    module: "Nhập mô tả chi tiết vật chứng",
    primaryBucket: "VALIDATION_DATA",
    scenario: "NEGATIVE",
    categories: ["validation"],
    preconditions: [],
    steps: { prepare: ["Chuẩn bị dữ liệu"], execute: ["Gọi tạo mới"] },
    expected: {
      type: "REJECT",
      description: "Từ chối khoảng trắng",
      observable: "validate",
    },
    testData: {
      target: {
        scope: "field",
        fields: ["moTa"],
        constraint: "Không được nhập toàn khoảng trắng",
        value: "      ",
      },
      input: {
        tenVatChung: "Vật chứng kiểm thử",
        hoSoVuAn: ["VuAn/HS-001"],
        moTa: "      ",
      },
    },
    readiness: "READY_FOR_GROUNDING",
    ...overrides,
  };
}

function sampleDecision(
  overrides?: Partial<UnitApprovalDecision>
): UnitApprovalDecision {
  const body = {
    schema: UNIT_APPROVE_DECISION_SCHEMA,
    emittedAt: "2026-08-16T12:00:00.000Z",
    requestId: "req-1",
    testCase: {
      id: "TC-013",
      revisionHash: sha256("tc-013"),
      ir: sampleIr(),
    },
    repository: {
      workspaceId: sha256("workspace"),
      vcs: "git" as const,
      head: "abc123",
      dirty: false,
      capturedAt: "2026-08-16T12:00:00.000Z",
    },
    outcome: "READY" as const,
    readiness: "READY_FOR_CODEGEN" as const,
    authoritative: true,
    primary: {
      symbolId: "EvidenceCreateCommandHandler:Handle",
      pathRel:
        "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
      name: "Handle",
      kind: "method" as const,
      containerName: "EvidenceCreateCommandHandler",
      selectionRange: range,
      fullRange: range,
      fileHash: sha256("primary"),
    },
    relatedFiles: [
      {
        pathRel: "src/Forensic.Dto/EvidenceDto.cs",
        language: "csharp",
        roles: ["dto" as const],
        fileHash: sha256("dto"),
        evidenceRanges: [range],
        discoveredBy: ["dependency" as const],
      },
    ],
    existingTests: [],
    fieldBindings: [
      {
        label: "moTa",
        property: "Description",
        owner: {
          pathRel: "src/Forensic.Dto/EvidenceDto.cs",
          typeName: "EvidenceDto",
          range,
          fileHash: sha256("dto"),
        },
        source: "bounded_shortlist_pick" as const,
        confidence: "HIGH" as const,
      },
    ],
    behaviorEvidence: [],
    files: [
      {
        pathRel:
          "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
        language: "csharp",
        sha256: sha256("primary"),
        byteSize: 100,
        source: "saved_disk" as const,
      },
      {
        pathRel: "src/Forensic.Dto/EvidenceDto.cs",
        language: "csharp",
        sha256: sha256("dto"),
        byteSize: 50,
        source: "saved_disk" as const,
      },
    ],
    confidence: {
      band: "HIGH" as const,
      score: 0.9,
      reasons: ["symbol+binding"],
    },
    checks: [
      { id: "workspaceSymbol", ok: true },
      { id: "definition", ok: true },
      { id: "fieldBinding", ok: true },
    ],
    refusalReasons: [],
    canonicalInput: {
      Name: "Vật chứng kiểm thử",
      CaseRecords: ["VuAn/HS-001"],
      Description: "      ",
    },
    ...overrides,
  };
  const decisionId = hashDecisionBody(body, sha256);
  return { ...body, decisionId, canonicalHash: decisionId };
}

describe("unitApproveRpc", () => {
  it("validates READY authoritative decision", () => {
    const d = sampleDecision();
    assert.equal(validateUnitApprovalDecision(d, { requireAuthoritative: true }).ok, true);
  });

  it("rejects READY without field bindings", () => {
    const d = sampleDecision({ fieldBindings: [] });
    const r = validateUnitApprovalDecision(d, { requireAuthoritative: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "INCOMPLETE_BINDINGS");
  });

  it("allows FEATURE_GAP non-authoritative with primary retained", () => {
    const d = sampleDecision({
      outcome: "FEATURE_GAP",
      readiness: "FEATURE_GAP",
      authoritative: false,
      confidence: { band: "LOW", reasons: ["no MaxLength"] },
      refusalReasons: [
        {
          code: "FEATURE_GAP",
          message: "Description has no MaxLength",
        },
      ],
    });
    assert.equal(validateUnitApprovalDecision(d).ok, true);
    assert.equal(
      validateUnitApprovalDecision(d, { requireAuthoritative: true }).ok,
      false
    );
  });

  it("rejects authoritative when outcome is not READY", () => {
    const d = sampleDecision({
      outcome: "NOT_READY",
      readiness: "NOT_READY",
      authoritative: true,
    });
    const r = validateUnitApprovalDecision(d);
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "NOT_AUTHORITATIVE");
  });

  it("rejects file manifest gaps", () => {
    const d = sampleDecision({
      files: [
        {
          pathRel:
            "src/Forensic.Application/Commands/Evidence/EvidenceCreateCommandHandler.cs",
          language: "csharp",
          sha256: sha256("primary"),
          byteSize: 100,
          source: "saved_disk",
        },
      ],
    });
    const r = validateUnitApprovalDecision(d, { requireAuthoritative: true });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.code, "FILE_MANIFEST_GAP");
  });

  it("projects v2 decision to v1 grounding shape with Description binding", () => {
    const d = sampleDecision();
    const v1 = projectDecisionToV1Grounding(d);
    assert.equal(v1.schema, "aitest-unit-grounding-v1");
    assert.equal(v1.authoritative, true);
    assert.equal(v1.primary.code, "EvidenceCreateCommandHandler.Handle");
    assert.equal(v1.bindings?.[0]?.property, "Description");
    assert.equal(v1.bindings?.[0]?.label, "moTa");
    assert.equal(v1.source, "ide-repository-intelligence");
  });

  it("exposes default limits", () => {
    assert.equal(DEFAULT_UNIT_APPROVE_LIMITS.deadlineMs, 150_000);
    assert.equal(DEFAULT_UNIT_APPROVE_LIMITS.maxRelatedFiles, 8);
  });
});
