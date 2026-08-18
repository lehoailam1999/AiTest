import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import {
  UNIT_APPROVE_DECISION_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  hashDecisionBody,
  type UnitApprovalDecision,
} from "@aitest/ide-protocol";
import { projectUnitApprovalDecision } from "./decisionProjection.ts";

function sha256(utf8: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(utf8).digest("hex")}`;
}

const range = {
  start: { line: 0, character: 0 },
  end: { line: 1, character: 0 },
};

describe("projectUnitApprovalDecision", () => {
  it("rewrites multi-key input to source properties, keeping business labels", () => {
    const body = {
      schema: UNIT_APPROVE_DECISION_SCHEMA,
      emittedAt: "2026-08-16T00:00:00.000Z",
      requestId: "r1",
      testCase: {
        id: "uuid-1",
        revisionHash: sha256("rev"),
        ir: {
          schema: UNIT_TC_IR_SCHEMA,
          testCaseId: "uuid-1",
          title: "moTa blank",
          requirement: {
            requirementIds: [],
            behaviorId: "B1",
          },
          primaryBucket: "VALIDATION_DATA" as const,
          scenario: "NEGATIVE" as const,
          categories: ["Unit"],
          preconditions: [],
          steps: { prepare: [], execute: ["call"] },
          expected: {
            type: "REJECT",
            description: "reject",
            observable: "validate",
          },
          testData: {
            target: {
              scope: "field" as const,
              fields: ["moTa"],
            },
            input: {
              tenVatChung: "A",
              hoSoVuAn: ["HS-1"],
              moTa: "   ",
            },
          },
          readiness: "READY_FOR_GROUNDING" as const,
        },
      },
      repository: {
        workspaceId: sha256("ws"),
        vcs: "none" as const,
        dirty: false,
        capturedAt: "2026-08-16T00:00:00.000Z",
      },
      outcome: "READY" as const,
      readiness: "READY_FOR_CODEGEN" as const,
      authoritative: true,
      primary: {
        symbolId: "H.Handle",
        pathRel: "src/App/EvidenceCreateCommandHandler.cs",
        name: "Handle",
        kind: "method" as const,
        containerName: "EvidenceCreateCommandHandler",
        selectionRange: range,
        fullRange: range,
        fileHash: sha256("p"),
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
            fileHash: sha256("d"),
          },
          source: "bounded_shortlist_pick" as const,
          confidence: "HIGH" as const,
        },
        {
          label: "tenVatChung",
          property: "Name",
          owner: {
            pathRel: "src/Dto/EvidenceDto.cs",
            typeName: "EvidenceDto",
            range,
            fileHash: sha256("d"),
          },
          source: "bounded_shortlist_pick" as const,
          confidence: "MEDIUM" as const,
        },
        {
          label: "hoSoVuAn",
          property: "CaseRecords",
          owner: {
            pathRel: "src/Dto/EvidenceDto.cs",
            typeName: "EvidenceDto",
            range,
            fileHash: sha256("d"),
          },
          source: "bounded_shortlist_pick" as const,
          confidence: "MEDIUM" as const,
        },
      ],
      behaviorEvidence: [],
      files: [
        {
          pathRel: "src/App/EvidenceCreateCommandHandler.cs",
          language: "csharp",
          sha256: sha256("p"),
          byteSize: 1,
          source: "saved_disk" as const,
        },
        {
          pathRel: "src/Dto/EvidenceDto.cs",
          language: "csharp",
          sha256: sha256("d"),
          byteSize: 1,
          source: "saved_disk" as const,
        },
      ],
      confidence: { band: "HIGH" as const, reasons: [] },
      checks: [],
      refusalReasons: [],
    };
    const id = hashDecisionBody(body, sha256);
    const decision: UnitApprovalDecision = {
      ...body,
      decisionId: id,
      canonicalHash: id,
    };
    const projected = projectUnitApprovalDecision(
      decision,
      "target.field: moTa\nstatus: READY_FOR_GROUNDING"
    );
    assert.match(projected.testData, /target\.field:\s*moTa/);
    assert.doesNotMatch(projected.testData, /target\.fieldLabel/);
    assert.match(projected.testData, /target\.property:\s*Description/);
    assert.match(projected.testData, /target\.properties:\s*Description,\s*Name,\s*CaseRecords/);
    assert.match(projected.testData, /status:\s*READY_FOR_CODEGEN/);
    assert.match(projected.testData, /layer:\s*dto/);
    assert.match(projected.testData, /input:\s*\{.*"Name":"A".*"Description":" {3}".*\}/);
    assert.doesNotMatch(projected.testData, /input:.*"moTa"/);
    assert.equal(projected.canonicalInput.Description, "   ");
    assert.equal(projected.canonicalInput.Name, "A");
    assert.deepEqual(projected.canonicalInput.CaseRecords, ["HS-1"]);
    assert.equal(projected.automationReady, true);
  });

  it("does not emit Gen-usable path/code for a non-authoritative NOT_READY decision", () => {
    const body = {
      schema: UNIT_APPROVE_DECISION_SCHEMA,
      emittedAt: "2026-08-16T00:00:00.000Z",
      requestId: "r-not-ready",
      testCase: {
        id: "uuid-2",
        revisionHash: sha256("rev-2"),
        ir: {
          schema: UNIT_TC_IR_SCHEMA,
          testCaseId: "uuid-2",
          title: "list cabinets by room",
          requirement: { requirementIds: [], behaviorId: "B2" },
          primaryBucket: "BUSINESS_RULES" as const,
          scenario: "POSITIVE" as const,
          categories: ["Unit"],
          preconditions: [],
          steps: { prepare: [], execute: ["query"] },
          expected: {
            type: "STATE",
            description: "list",
            observable: "query",
          },
          testData: {
            target: { scope: "aggregate" as const, fields: ["tuLuuTru"] },
            input: {},
          },
          readiness: "READY_FOR_GROUNDING" as const,
        },
      },
      repository: {
        workspaceId: sha256("ws"),
        vcs: "none" as const,
        dirty: false,
        capturedAt: "2026-08-16T00:00:00.000Z",
      },
      outcome: "NOT_READY" as const,
      readiness: "NOT_READY" as const,
      authoritative: false,
      primary: {
        symbolId: "C.AddAppSettingsModule",
        pathRel: "src/Configuration/AppSettingsStartup.cs",
        name: "AddAppSettingsModule",
        kind: "method" as const,
        containerName: "AppSettingsConfiguration",
        selectionRange: range,
        fullRange: range,
        fileHash: sha256("c"),
      },
      relatedFiles: [],
      existingTests: [],
      fieldBindings: [],
      behaviorEvidence: [],
      files: [
        {
          pathRel: "src/Configuration/AppSettingsStartup.cs",
          language: "csharp",
          sha256: sha256("c"),
          byteSize: 1,
          source: "saved_disk" as const,
        },
      ],
      confidence: { band: "LOW" as const, reasons: [] },
      checks: [],
      refusalReasons: [
        {
          code: "AMBIGUOUS_PRIMARY" as const,
          message: "Multiple primary symbols have the same repository relevance.",
        },
      ],
    };
    const id = hashDecisionBody(body, sha256);
    const decision: UnitApprovalDecision = {
      ...body,
      decisionId: id,
      canonicalHash: id,
    };
    const projected = projectUnitApprovalDecision(
      decision,
      [
        "target.scope: aggregate",
        "target.field: tuLuuTru",
        "layer: dto",
        'input: {"phongLuuTru":"Phòng lưu trữ hợp lệ"}',
        "status: READY_FOR_GROUNDING",
      ].join("\n")
    );
    assert.match(projected.testData, /status:\s*NOT_READY/);
    assert.doesNotMatch(projected.testData, /path:\s/);
    assert.doesNotMatch(projected.testData, /code:\s/);
    assert.equal(projected.automationReady, false);
    // A refused run must not strip the analysis markers it cannot rebuild,
    // otherwise every retry starts from a test case with no target at all.
    assert.match(projected.testData, /target\.field:\s*tuLuuTru/);
    assert.match(projected.testData, /target\.scope:\s*aggregate/);
    assert.match(projected.testData, /layer:\s*dto/);
    assert.match(projected.testData, /input:\s*\{"phongLuuTru":"Phòng lưu trữ hợp lệ"\}/);
    assert.equal(projected.testData.match(/^input:/gm)?.length, 1);
  });

  it("keeps nearest primary markers on FEATURE_GAP but is not automation-ready", () => {
    const body = {
      schema: UNIT_APPROVE_DECISION_SCHEMA,
      emittedAt: "2026-08-16T00:00:00.000Z",
      requestId: "r-gap",
      testCase: {
        id: "uuid-3",
        revisionHash: sha256("rev-3"),
        ir: {
          schema: UNIT_TC_IR_SCHEMA,
          testCaseId: "uuid-3",
          title: "optional room",
          requirement: { requirementIds: [], behaviorId: "B3" },
          primaryBucket: "VALIDATION_DATA" as const,
          scenario: "POSITIVE" as const,
          categories: ["Unit"],
          preconditions: [],
          steps: { prepare: [], execute: ["validate"] },
          expected: {
            type: "ACCEPT",
            description: "accept",
            observable: "validate",
          },
          testData: {
            target: { scope: "field" as const, fields: ["phongLuuTru"] },
            input: {},
          },
          readiness: "READY_FOR_GROUNDING" as const,
        },
      },
      repository: {
        workspaceId: sha256("ws"),
        vcs: "none" as const,
        dirty: false,
        capturedAt: "2026-08-16T00:00:00.000Z",
      },
      outcome: "FEATURE_GAP" as const,
      readiness: "FEATURE_GAP" as const,
      authoritative: false,
      primary: {
        symbolId: "H.Handle",
        pathRel: "src/App/EvidenceCreateCommandHandler.cs",
        name: "Handle",
        kind: "method" as const,
        containerName: "EvidenceCreateCommandHandler",
        selectionRange: range,
        fullRange: range,
        fileHash: sha256("p"),
      },
      relatedFiles: [],
      existingTests: [],
      fieldBindings: [],
      behaviorEvidence: [],
      files: [
        {
          pathRel: "src/App/EvidenceCreateCommandHandler.cs",
          language: "csharp",
          sha256: sha256("p"),
          byteSize: 1,
          source: "saved_disk" as const,
        },
      ],
      confidence: { band: "LOW" as const, reasons: [] },
      checks: [],
      refusalReasons: [
        {
          code: "FEATURE_GAP" as const,
          message: "No source evidence was found for: required.",
        },
      ],
    };
    const id = hashDecisionBody(body, sha256);
    const decision: UnitApprovalDecision = {
      ...body,
      decisionId: id,
      canonicalHash: id,
    };
    const projected = projectUnitApprovalDecision(decision);
    assert.match(projected.testData, /path:\s*src\/App\/EvidenceCreateCommandHandler\.cs/);
    assert.match(projected.testData, /status:\s*FEATURE_GAP/);
    assert.equal(projected.automationReady, false);
  });
});
