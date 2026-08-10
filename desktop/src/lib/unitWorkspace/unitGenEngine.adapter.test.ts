/**
 * Mock UnitGenEngine — swap without Desktop changes (interface contract).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

interface UnitGenEngine {
  readonly name: string;
  generate(
    item: { testCaseId: string; title: string },
    ctx: {
      primaryPath: string;
      suggestedPath: string;
    }
  ): Promise<{ files: Array<{ path: string; content: string }>; sourceFileName: string }>;
}

class MockEngine implements UnitGenEngine {
  readonly name = "mock";
  async generate(item: { testCaseId: string; title: string }, ctx: { primaryPath: string; suggestedPath: string }) {
    return {
      files: [
        {
          path: ctx.suggestedPath,
          content: `// mock for ${item.testCaseId}`,
        },
      ],
      sourceFileName: ctx.primaryPath,
    };
  }
}

describe("UnitGenEngine adapter contract", () => {
  it("mock engine returns file + sourceFileName", async () => {
    const eng = new MockEngine();
    const out = await eng.generate(
      { testCaseId: "TC-MOCK", title: "Mock" },
      {
        primaryPath: "src/svc.ts",
        suggestedPath: "AItest/UnitTest/m/TC-MOCK.test.ts",
      }
    );
    assert.equal(eng.name, "mock");
    assert.equal(out.files.length, 1);
    assert.equal(out.sourceFileName, "src/svc.ts");
    assert.match(out.files[0]!.content, /TC-MOCK/);
  });
});
