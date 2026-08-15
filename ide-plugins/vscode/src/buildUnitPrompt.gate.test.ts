import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildUnitPrompt } from "./cursorAgentCliEngine.ts";

describe("buildUnitPrompt gatePassed", () => {
  const base = {
    item: { testCaseId: "TC-1", title: "t" },
    projectRules: "# rules",
    conventions: "",
    tcMd: "path: src/A.cs\ncode: A",
    tcMdPath: ".ai-test/test-cases/TC-1.md",
    primaryPath: "src/Wrong/WrongHandler.cs",
    source: "class WrongHandler {}",
    suggestedPath: "AItest/UnitTest/M/x.cs",
  };

  it("omits only-allowed-primary line when gatePassed=false", () => {
    const { prompt } = buildUnitPrompt({ ...base, gatePassed: false });
    assert.doesNotMatch(prompt, /only allowed primary SUT/i);
  });

  it("includes only-allowed-primary when gatePassed=true", () => {
    const { prompt } = buildUnitPrompt({ ...base, gatePassed: true });
    assert.match(prompt, /only allowed primary SUT/i);
  });

  it("omits Request meta when slim MD already has title and id", () => {
    const { prompt } = buildUnitPrompt({
      ...base,
      gatePassed: true,
      tcMd: "# Room reset\nid: TC-1\ntestCaseId: TC-1\n## Steps\n1. Change room\n",
    });
    assert.doesNotMatch(prompt, /## Request meta/);
  });
});
