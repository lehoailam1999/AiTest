/**
 * Phase B.1 — Unit Gen parse helpers + offline gate.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  excerptFromContextPacket,
  stripCodeFences,
} from "../../../../ide-plugins/vscode/src/unitGenParse.ts";
import { isIdeCodegenReady } from "./codegenCommands.ts";

describe("unitGenParse", () => {
  it("strips markdown fences", () => {
    const raw = "Here:\n```ts\nconst x = 1;\n```\n";
    assert.equal(stripCodeFences(raw), "const x = 1;");
  });

  it("excerpts primary from context packet", () => {
    const ex = excerptFromContextPacket({
      files: [
        { role: "primary", pathRel: "src/a.ts", content: "export const a = 1;" },
        { role: "dependency", pathRel: "src/b.ts", content: "export const b = 2;" },
      ],
    });
    assert.equal(ex.primaryPath, "src/a.ts");
    assert.match(ex.source || "", /export const a/);
    assert.match(ex.related || "", /src\/b\.ts/);
  });
});

describe("Phase B Unit Gen gate", () => {
  it("isIdeCodegenReady is false without bridge (Node test)", () => {
    assert.equal(isIdeCodegenReady(), false);
  });
});
