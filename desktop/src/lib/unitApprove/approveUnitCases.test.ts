import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNIT_APPROVE_DECISION_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  type UnitApprovalDecision,
  type UnitApproveTcIr,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { approveUnitCases } from "./approveUnitCases";
import {
  propertyBindingsFromAliases,
  unitTestCaseContentRevision,
} from "./resolveViaIde";
import { applyLearnedFieldAliases } from "../approvedTcSync/loadUnitEnrichProfile";

function sample(): TestCase {
  return {
    id: "tc-db-1",
    projectId: "project-1",
    testCaseId: "TC-U-1",
    title: "Create category",
    module: "Category",
    type: "Unit",
    priority: "High",
    severity: "Major",
    steps: "Call handler",
    expectedResult: "Category is created",
    testData: "status: READY_FOR_GROUNDING",
    unitContentRevisionCurrent: `sha256:${"a".repeat(64)}`,
    automationReady: false,
    isAiGenerated: true,
    reviewStatus: "Draft",
    executionStatus: "NotRun",
    createdAt: "2026-08-16T00:00:00Z",
  };
}

describe("approveUnitCases", () => {
  it("reports start and outcome of every TC so the UI can advance per case", async () => {
    const first = { ...sample(), id: "tc-db-1", testCaseId: "TC-U-1" };
    const second = { ...sample(), id: "tc-db-2", testCaseId: "TC-U-2" };
    const events: string[] = [];

    const results = await approveUnitCases({
      projectId: first.projectId,
      projectRoot: "D:/sut",
      cases: [first, second],
      onProgress: (event) => {
        events.push(
          `${event.phase}:${event.tc.testCaseId}:${event.index}/${event.total}` +
            (event.phase === "done" ? `:${event.result?.ok ? "ok" : "fail"}` : "")
        );
      },
      deps: {
        // A failing resolve must still settle its TC, otherwise the bar stalls.
        resolve: async ({ tc }) => {
          throw new Error(`no IDE for ${tc.testCaseId}`);
        },
        persist: async () => first,
      },
    });

    assert.equal(results.length, 2);
    assert.deepEqual(events, [
      "start:TC-U-1:0/2",
      "done:TC-U-1:0/2:fail",
      "start:TC-U-2:1/2",
      "done:TC-U-2:1/2:fail",
    ]);
  });

  it("builds IR, resolves through mocked IDE, validates, then persists", async () => {
    const tc = sample();
    const revisionHash = unitTestCaseContentRevision(tc);
    const fileHash = `sha256:${"b".repeat(64)}` as const;
    let persisted = false;

    const results = await approveUnitCases({
      projectId: tc.projectId,
      projectRoot: "D:/sut",
      cases: [tc],
      deps: {
        resolve: async ({ tcIr }) => {
          assert.equal(tcIr.readiness, "READY_FOR_GROUNDING");
          const range = {
            start: { line: 0, character: 0 },
            end: { line: 1, character: 0 },
          };
          return {
            schema: UNIT_APPROVE_DECISION_SCHEMA,
            decisionId: revisionHash,
            canonicalHash: revisionHash,
            emittedAt: "2026-08-16T00:00:00Z",
            requestId: "request-1",
            testCase: { id: tc.id, revisionHash, ir: tcIr },
            repository: {
              workspaceId: revisionHash,
              vcs: "git",
              dirty: false,
              capturedAt: "2026-08-16T00:00:00Z",
            },
            outcome: "READY",
            readiness: "READY_FOR_CODEGEN",
            authoritative: true,
            primary: {
              symbolId: "category-handler",
              pathRel: "src/CategoryHandler.cs",
              name: "Handle",
              containerName: "CategoryHandler",
              kind: "method",
              selectionRange: range,
              fullRange: range,
              fileHash,
            },
            relatedFiles: [],
            existingTests: [],
            fieldBindings: [],
            behaviorEvidence: [],
            files: [
              {
                pathRel: "src/CategoryHandler.cs",
                language: "csharp",
                sha256: fileHash,
                byteSize: 100,
                source: "saved_disk",
              },
            ],
            confidence: { band: "HIGH", reasons: [] },
            checks: [{ id: "symbolCoLocated", ok: true }],
            refusalReasons: [],
          } satisfies UnitApprovalDecision;
        },
        persist: async ({ decision }) => {
          persisted = true;
          assert.equal(decision.testCase.revisionHash, revisionHash);
          return {
            ...tc,
            reviewStatus: "Approved",
            automationReady: true,
          };
        },
      },
    });

    assert.equal(results.length, 1);
    assert.equal(results[0]?.ok, true);
    assert.equal(persisted, true);
  });

  it("uses the server revision verbatim and refuses when it is absent", () => {
    const revision = `sha256:${"c".repeat(64)}`;
    assert.equal(
      unitTestCaseContentRevision({ ...sample(), unitContentRevisionCurrent: revision }),
      revision
    );
    assert.throws(
      () =>
        unitTestCaseContentRevision({
          ...sample(),
          unitContentRevisionCurrent: undefined,
        }),
      /server content revision/
    );
  });

  it("projects project-owned field aliases into deterministic IDE hints", () => {
    const tcIr = {
      schema: UNIT_TC_IR_SCHEMA,
      testCaseId: "TC-032",
      title: "Bỏ trống thời gian thu giữ",
      requirement: { requirementIds: [], behaviorId: "required-seizure-time" },
      module: "Evidence",
      primaryBucket: "VALIDATION_DATA",
      scenario: "NEGATIVE",
      categories: ["Unit"],
      preconditions: [],
      steps: { prepare: [], execute: ["Validate"] },
      expected: {
        type: "value",
        description: "Reject missing seizure time",
        observable: "reject",
      },
      testData: {
        target: {
          scope: "field",
          fields: ["thoiGianThuGiu"],
          constraint: "Bắt buộc",
        },
        input: { tenVatChung: "A", thoiGianThuGiu: null },
      },
      readiness: "READY_FOR_GROUNDING",
    } satisfies UnitApproveTcIr;

    assert.deepEqual(
      propertyBindingsFromAliases(tcIr, {
        "thời gian thu giữ": ["SeizureTime", "IgnoredFallback"],
        tenVatChung: "Name",
      }),
      [
        { label: "thoiGianThuGiu", property: "SeizureTime" },
        { label: "tenVatChung", property: "Name" },
      ]
    );
  });

  it("learns new field aliases without overwriting ones already stored", () => {
    const { next, added } = applyLearnedFieldAliases(
      { fields: { moTa: "Description" } },
      [
        { label: "moTa", property: "Wrong" },
        { label: "thoiGianThuGiu", property: "SeizureTime" },
      ]
    );
    assert.equal(added, 1);
    assert.deepEqual(next.fields, {
      moTa: "Description",
      thoiGianThuGiu: "SeizureTime",
    });
  });
});
