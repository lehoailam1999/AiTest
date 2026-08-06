/**
 * Phase 5 — buildIdeLocalGenerateBody attaches planner/contextFiles additively.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildIdeLocalGenerateBody } from "./ideLocalCommands.js";
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
});
