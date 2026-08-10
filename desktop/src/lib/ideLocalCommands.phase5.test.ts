/**
 * Phase 5 — buildIdeLocalGenerateBody attaches planner/contextFiles additively.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildIdeLocalGenerateBody,
  shouldPreferCodeIndex,
} from "./ideLocalCommands.js";
import type { AITestContextPacket } from "./contextPacket/types.js";
import { CONTEXT_PACKET_VERSION } from "./contextPacket/types.js";

function samplePacket(): AITestContextPacket {
  return {
    packetVersion: CONTEXT_PACKET_VERSION,
    purpose: "generate-unit",
    meta: { language: "TypeScript", framework: "jest" },
    files: [
      {
        pathRel: "src/math.ts",
        content: "export function add(a:number,b:number){return a+b}",
        role: "primary",
      },
      {
        pathRel: "src/types.ts",
        content: "export type N = number",
        role: "dependency",
      },
    ],
    diagnostics: {
      truncated: [],
      omittedPaths: [],
      seedReason: "test",
      seedCandidates: [],
      gaps: [],
    },
  };
}

describe("shouldPreferCodeIndex", () => {
  it("enables TS/JS and C#; blocks empty and unindexed langs", () => {
    assert.equal(shouldPreferCodeIndex("TypeScript"), true);
    assert.equal(shouldPreferCodeIndex("javascript"), true);
    assert.equal(shouldPreferCodeIndex("C#"), true);
    assert.equal(shouldPreferCodeIndex("csharp"), true);
    assert.equal(shouldPreferCodeIndex("dotnet"), true);
    assert.equal(shouldPreferCodeIndex(""), false);
    assert.equal(shouldPreferCodeIndex(null), false);
    assert.equal(shouldPreferCodeIndex("Python"), false);
    assert.equal(shouldPreferCodeIndex("Java"), false);
  });
});

describe("buildIdeLocalGenerateBody Phase 5", () => {
  it("omits planner/indexVersion when not provided (legacy-compatible)", () => {
    const body = buildIdeLocalGenerateBody({
      projectId: "p1",
      testCaseId: "t1",
      packet: samplePacket(),
      sourceFileName: "src/math.ts",
      framework: "jest",
      language: "TypeScript",
    });
    assert.ok(body.contextPacket);
    assert.equal(body.planner, undefined);
    assert.equal(body.indexVersion, undefined);
    assert.equal(body.contextFiles?.length, 2);
    assert.equal(body.sourceFileName, "src/math.ts");
  });

  it("attaches planner and indexVersion when provided", () => {
    const body = buildIdeLocalGenerateBody({
      projectId: "p1",
      testCaseId: "t1",
      packet: samplePacket(),
      sourceFileName: "src/math.ts",
      framework: "jest",
      language: "TypeScript",
      planner: {
        testType: "Unit",
        module: "Math",
        action: "add",
        keywords: ["add"],
        hints: { framework: "jest" },
      },
      indexVersion: "aitest-code-index-v1",
      contextSource: "code-index",
    });
    assert.equal(body.planner?.module, "Math");
    assert.equal(body.indexVersion, "aitest-code-index-v1");
    assert.equal(body.contextSource, "code-index");
  });

  it("attaches explicit projectRules payload for unit conventions", () => {
    const body = buildIdeLocalGenerateBody({
      projectId: "p1",
      testCaseId: "t1",
      packet: samplePacket(),
      sourceFileName: "src/math.ts",
      framework: "jest",
      language: "TypeScript",
      projectRules: "# Unit conventions\nUse AAA.",
      projectRulesSource: "unit-conventions",
    });
    assert.equal(body.projectRulesSource, "unit-conventions");
    assert.match(body.projectRules || "", /Unit conventions/);
  });
});
