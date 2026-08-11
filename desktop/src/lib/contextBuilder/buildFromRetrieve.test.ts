/**
 * Index-backed context: nearest existing test → role test-sample.
 */
import assert from "node:assert/strict";
import { describe, it, beforeEach } from "node:test";
import type { CodeIndexIo } from "../codeIndex/types.js";
import { syncProjectIndex } from "../codeIndex/incrementalSync.js";
import { clearUnitPlanCache } from "../testPlanner/contextCache.js";
import { buildIndexBackedContext } from "./buildFromRetrieve.js";

function memoryIo(files: Record<string, string>): CodeIndexIo {
  return {
    listFiles: async () =>
      Object.keys(files).filter((p) => !p.includes(".ai-test/")),
    readFile: async (_r, p) => {
      if (!(p in files)) throw new Error(`missing ${p}`);
      return files[p];
    },
    writeFile: async (_r, p, c) => {
      files[p] = c;
    },
    readFileOptional: async (_r, p) => (p in files ? files[p] : null),
  };
}

describe("buildIndexBackedContext test-sample", () => {
  beforeEach(() => clearUnitPlanCache());

  it("packs primary + test-sample when *Tests.cs exists", async () => {
    const files: Record<string, string> = {
      "src/App/Handlers/CreateItemHandler.cs": `
namespace App.Handlers;
public class CreateItemHandler
{
    public void Handle() { }
}
`,
      "tests/App/Handlers/CreateItemHandlerTests.cs": `
using Xunit;
namespace App.Handlers.Tests;
public class CreateItemHandlerTests
{
    [Fact]
    public void Handle_ok() { }
}
`,
    };
    const io = memoryIo(files);
    const { snapshot } = await syncProjectIndex("/proj-ctx-sample", io);
    const out = await buildIndexBackedContext({
      projectRoot: "/proj-ctx-sample",
      testCase: {
        id: "tc-1",
        testCaseId: "TC-SAMPLE-1",
        title: "Create item success",
        module: "Item",
        type: "Unit",
        testData:
          "path: src/App/Handlers/CreateItemHandler.cs\ncode: CreateItemHandler",
        steps: "Arrange Act Assert",
        expectedResult: "ok",
      } as any,
      io,
      snapshot,
      language: "csharp",
      framework: "xunit",
      testingFramework: "xunit",
    });
    assert.ok(out.packet.files.some((f) => f.role === "primary"));
    const sample = out.packet.files.find((f) => f.role === "test-sample");
    assert.ok(sample, JSON.stringify(out.packet.files.map((f) => f.role)));
    assert.match(sample!.pathRel, /CreateItemHandlerTests/);
    assert.ok(
      out.notes.some((n) => /test-sample=/i.test(n)),
      JSON.stringify(out.notes)
    );
  });
});
