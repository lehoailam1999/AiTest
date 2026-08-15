import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildPacketFromUnitGrounding,
  isUnitGroundingFastPathEligible,
  parseUnitSourceGroundingContract,
} from "./groundingFastPath.js";
import { UNIT_GROUNDING_CONTRACT_SCHEMA } from "../approvedTcSync/unitSourceGroundingContract.js";
import { hashContent } from "../codeIndex/hashContent.js";

describe("groundingFastPath", () => {
  const markers = {
    paths: ["src/Foo/CreateFooHandler.cs"],
    codes: ["CreateFooHandler"],
    related: [],
  };

  it("parses valid contract and rejects bad schema", () => {
    const ok = parseUnitSourceGroundingContract(
      JSON.stringify({
        schema: UNIT_GROUNDING_CONTRACT_SCHEMA,
        emittedAt: "2026-01-01T00:00:00.000Z",
        primary: {
          pathRel: "src/Foo/CreateFooHandler.cs",
          code: "CreateFooHandler",
          typeName: "CreateFooHandler",
        },
        related: [],
        deps: [],
        confidence: "HIGH",
      })
    );
    assert.ok(ok);
    assert.equal(ok?.primary.pathRel, "src/Foo/CreateFooHandler.cs");
    assert.equal(parseUnitSourceGroundingContract("{}"), null);
  });

  it("requires marker agreement and rejects LOW/stale", () => {
    const base = {
      schema: UNIT_GROUNDING_CONTRACT_SCHEMA,
      emittedAt: "2026-01-01T00:00:00.000Z",
      primary: {
        pathRel: "src/Foo/CreateFooHandler.cs",
        code: "CreateFooHandler",
        typeName: "CreateFooHandler",
        contentHash: "fnv1a64_test",
      },
      related: [],
      deps: [] as string[],
      confidence: "HIGH" as const,
      freshness: "fresh" as const,
      authoritative: true,
    };
    assert.equal(isUnitGroundingFastPathEligible(base, markers), true);
    assert.equal(
      isUnitGroundingFastPathEligible({ ...base, confidence: "LOW" }, markers),
      false
    );
    assert.equal(
      isUnitGroundingFastPathEligible({ ...base, freshness: "stale" }, markers),
      false
    );
    assert.equal(
      isUnitGroundingFastPathEligible(
        {
          ...base,
          primary: {
            ...base.primary,
            pathRel: "src/Other/OtherHandler.cs",
            code: "OtherHandler",
            typeName: "OtherHandler",
          },
        },
        markers
      ),
      false
    );
  });

  it("builds packet from primary + deps without planner", async () => {
    const files: Record<string, string> = {
      "src/Foo/CreateFooHandler.cs": "class CreateFooHandler {}",
      "src/Foo/CreateFooCommand.cs": "class CreateFooCommand {}",
    };
    const primaryHash = await hashContent(files["src/Foo/CreateFooHandler.cs"]!);
    const built = await buildPacketFromUnitGrounding({
      projectRoot: "/proj",
      projectId: "p1",
      testCaseId: "tc1",
      language: "csharp",
      contract: {
        schema: UNIT_GROUNDING_CONTRACT_SCHEMA,
        emittedAt: "2026-01-01T00:00:00.000Z",
        primary: {
          pathRel: "src/Foo/CreateFooHandler.cs",
          code: "CreateFooHandler.Handle",
          typeName: "CreateFooHandler",
          methodName: "Handle",
          contentHash: primaryHash,
        },
        related: [{ pathRel: "src/Foo/CreateFooCommand.cs" }],
        deps: ["src/Foo/CreateFooCommand.cs"],
        confidence: "HIGH",
        freshness: "fresh",
        authoritative: true,
      },
      readFile: async (_root, rel) => files[rel] || "",
    });
    assert.ok(built);
    assert.equal(built?.primaryPath, "src/Foo/CreateFooHandler.cs");
    assert.equal(built?.packet.diagnostics.seedReason, "grounding-contract-fast-path");
    assert.equal(built?.packet.files[0]?.role, "primary");
    assert.equal(built?.packet.files.some((f) => f.role === "dependency"), true);
  });
});
