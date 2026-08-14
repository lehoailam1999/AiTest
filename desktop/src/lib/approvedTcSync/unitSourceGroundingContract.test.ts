import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { snapshotFromPaths } from "../unitResolve/snapshotFromPaths.js";
import {
  UNIT_GROUNDING_CONTRACT_SCHEMA,
  buildUnitGroundingContractFiles,
  buildUnitSourceGroundingContract,
  parseConfidenceFromTestData,
  unitGroundingContractRelPath,
} from "./unitSourceGroundingContract.js";

describe("unitSourceGroundingContract (Layer 5)", () => {
  it("parseConfidenceFromTestData reads auto-enrich band", () => {
    assert.equal(
      parseConfidenceFromTestData(
        "# auto-enriched from index.db (score=90 confidence=MEDIUM warning=soft-margin writeBack=yes)"
      ),
      "MEDIUM"
    );
    assert.equal(parseConfidenceFromTestData("no band"), null);
  });

  it("unitGroundingContractRelPath swaps .md → .grounding.json", () => {
    assert.equal(
      unitGroundingContractRelPath(
        ".ai-test/test-cases/UnitTest/foo/TC-001.md"
      ),
      ".ai-test/test-cases/UnitTest/foo/TC-001.grounding.json"
    );
  });

  it("buildUnitSourceGroundingContract fills primary + related + deps", () => {
    const pathRel = "src/App/Commands/Widget/WidgetCreateCommandHandler.cs";
    const related = "src/App/Commands/Widget/WidgetCreateCommand.cs";
    const snap = snapshotFromPaths([pathRel, related]);
    snap.dependencyGraph[pathRel] = [related];
    snap.symbolsByFile[pathRel] = [
      {
        name: "WidgetCreateCommandHandler",
        kind: "class",
        line: 3,
        endLine: 40,
        exported: true,
      },
      {
        name: "Handle",
        kind: "method",
        line: 10,
        endLine: 30,
        parent: "WidgetCreateCommandHandler",
      },
    ];

    const c = buildUnitSourceGroundingContract({
      pathRel,
      code: "WidgetCreateCommandHandler.Handle",
      relatedPaths: [related],
      codeIndex: snap,
      confidence: "HIGH",
      freshness: "fresh",
      validateChecks: ["indexFile", "moduleGate"],
      testCaseId: "TC-001",
      score: 120,
      source: "index.db",
    });
    assert.ok(c);
    assert.equal(c!.schema, UNIT_GROUNDING_CONTRACT_SCHEMA);
    assert.equal(c!.primary.typeName, "WidgetCreateCommandHandler");
    assert.equal(c!.primary.methodName, "Handle");
    assert.equal(c!.primary.line, 10);
    assert.equal(c!.primary.endLine, 30);
    assert.equal(c!.related.length, 1);
    assert.ok(c!.deps.includes(related));
    assert.equal(c!.confidence, "HIGH");
    assert.equal(c!.freshness, "fresh");
  });

  it("buildUnitGroundingContractFiles emits companion for Unit with markers", () => {
    const files = buildUnitGroundingContractFiles(
      [
        {
          id: "1",
          testCaseId: "TC-100",
          type: "Unit",
          module: "Tạo mới",
          reviewStatus: "Approved",
          testData:
            "path: src/App/WidgetCreateCommandHandler.cs\ncode: WidgetCreateCommandHandler\nrelated: src/App/WidgetCreateCommand.cs\n# auto-enriched from index.db (score=88 confidence=HIGH writeBack=yes)",
        },
        {
          id: "2",
          testCaseId: "TC-E2E",
          type: "E2E",
          module: "UI",
          reviewStatus: "Approved",
          testData: "path: /admin",
        },
      ],
      { codeIndex: snapshotFromPaths(["src/App/WidgetCreateCommandHandler.cs"]) }
    );
    assert.equal(files.length, 1);
    assert.match(files[0]!.path, /\.grounding\.json$/);
    assert.match(files[0]!.content, /aitest-unit-grounding-v1/);
    assert.match(files[0]!.content, /WidgetCreateCommandHandler/);
  });
});
