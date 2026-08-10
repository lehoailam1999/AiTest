import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { newCodegenCommandId, toCodegenFiles } from "./codegenCommands.js";

describe("ideProtocol codegen helpers", () => {
  it("newCodegenCommandId is unique-ish", () => {
    const a = newCodegenCommandId("t");
    const b = newCodegenCommandId("t");
    assert.notEqual(a, b);
    assert.match(a, /^t-/);
  });

  it("toCodegenFiles normalizes paths", () => {
    const files = toCodegenFiles([
      { path: "AItest\\UnitTest\\a.ts", content: "x", kind: "unit" },
      { path: "  ", content: "skip" },
    ]);
    assert.equal(files.length, 1);
    assert.equal(files[0].path, "AItest/UnitTest/a.ts");
  });
});
