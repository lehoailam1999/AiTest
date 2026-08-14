import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { CodeIndexSnapshot } from "../codeIndex/types.js";
import {
  parseCodeMarker,
  preferredCodeMarkerFromIndex,
} from "./progressiveSeedFromCodeIndex.js";

function snapWith(
  pathRel: string,
  symbols: CodeIndexSnapshot["symbolsByFile"][string]
): CodeIndexSnapshot {
  const now = new Date().toISOString();
  return {
    meta: {
      schema: "aitest-code-index-v1",
      createdAt: now,
      updatedAt: now,
      fileCount: 1,
      symbolCount: symbols.length,
      edgeCount: 0,
      parser: "test",
    },
    files: {
      [pathRel]: {
        pathRel,
        language: "cs",
        contentHash: "x",
        byteSize: 1,
        symbolCount: symbols.length,
        importCount: 0,
        indexedAt: now,
      },
    },
    symbolsByFile: { [pathRel]: symbols },
    importsByFile: {},
    exportsByFile: {},
    symbolIndex: {},
    dependencyGraph: {},
  };
}

describe("parseCodeMarker / preferredCodeMarkerFromIndex (Layer 1)", () => {
  it("parseCodeMarker splits Type.Method", () => {
    assert.deepEqual(parseCodeMarker("FooHandler.Handle"), {
      typeName: "FooHandler",
      methodName: "Handle",
    });
    assert.deepEqual(parseCodeMarker("FooHandler"), { typeName: "FooHandler" });
    assert.deepEqual(parseCodeMarker(""), { typeName: "" });
  });

  it("emits Type.Handle for CQRS handler with single entry method", () => {
    const pathRel = "src/App/WidgetCreateCommandHandler.cs";
    const snap = snapWith(pathRel, [
      { name: "WidgetCreateCommandHandler", kind: "class", line: 1, endLine: 20 },
      {
        name: "Handle",
        kind: "method",
        line: 5,
        endLine: 18,
        parent: "WidgetCreateCommandHandler",
      },
    ]);
    const code = preferredCodeMarkerFromIndex(snap, pathRel, {
      preferTokens: [],
      crudVerb: "create",
      title: "Tạo mới widget",
    });
    assert.equal(code, "WidgetCreateCommandHandler.Handle");
  });

  it("picks CRUD method on multi-method service", () => {
    const pathRel = "src/Services/WidgetService.cs";
    const snap = snapWith(pathRel, [
      { name: "WidgetService", kind: "class", line: 1, endLine: 80, exported: true },
      {
        name: "CreateAsync",
        kind: "method",
        line: 10,
        endLine: 20,
        parent: "WidgetService",
      },
      {
        name: "UpdateAsync",
        kind: "method",
        line: 30,
        endLine: 50,
        parent: "WidgetService",
      },
      {
        name: "DeleteAsync",
        kind: "method",
        line: 60,
        endLine: 70,
        parent: "WidgetService",
      },
    ]);
    assert.equal(
      preferredCodeMarkerFromIndex(snap, pathRel, {
        crudVerb: "update",
        title: "Cập nhật widget",
        functionTitle: "Cập nhật",
      }),
      "WidgetService.UpdateAsync"
    );
  });

  it("keeps Type only when methods are ambiguous", () => {
    const pathRel = "src/Services/WidgetService.cs";
    const snap = snapWith(pathRel, [
      { name: "WidgetService", kind: "class", line: 1, exported: true },
      { name: "CreateAsync", kind: "method", line: 10, parent: "WidgetService" },
      { name: "UpdateAsync", kind: "method", line: 20, parent: "WidgetService" },
    ]);
    // No CRUD verb, no title tokens → fail-closed Type only
    assert.equal(
      preferredCodeMarkerFromIndex(snap, pathRel, {
        preferTokens: [],
        title: "Kiểm tra widget",
      }),
      "WidgetService"
    );
  });
});
