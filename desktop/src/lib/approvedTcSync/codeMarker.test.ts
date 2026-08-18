import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCodeMarker } from "./codeMarker";

describe("parseCodeMarker", () => {
  it("parses projected Type and Type.Method markers", () => {
    assert.deepEqual(parseCodeMarker("FooHandler.Handle"), {
      typeName: "FooHandler",
      methodName: "Handle",
    });
    assert.deepEqual(parseCodeMarker("FooHandler"), {
      typeName: "FooHandler",
    });
    assert.deepEqual(parseCodeMarker(""), { typeName: "" });
  });
});
