import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  classifyExecutionLane,
  e2eSuiteRel,
  resolveE2eRunCommand,
  resolveUnitRunCommand,
  summarizeExecutions,
} from "./presets.ts";
import type { Project } from "../../api/types.ts";

describe("runCenter presets", () => {
  it("builds E2E suite path and playwright command", () => {
    assert.equal(e2eSuiteRel(null), "AItest/E2ETest");
    assert.equal(e2eSuiteRel("backend"), "backend/AItest/E2ETest");
    assert.match(resolveE2eRunCommand("backend"), /playwright test "backend\/AItest\/E2ETest"/);
  });

  it("resolves C# unit onto AItest.UnitTests.csproj", () => {
    const p = {
      id: "1",
      name: "x",
      language: "C#",
      framework: "net8.0",
      isActive: true,
      requirementCount: 0,
      testCaseCount: 0,
      createdAt: "",
    } as Project;
    assert.equal(
      resolveUnitRunCommand(p, null),
      `dotnet test "AItest/AItest.UnitTests.csproj" --nologo`
    );
    assert.equal(
      resolveUnitRunCommand(p, "src/Lib"),
      `dotnet test "src/Lib/AItest/AItest.UnitTests.csproj" --nologo`
    );
  });

  it("classifies execution lanes", () => {
    assert.equal(classifyExecutionLane('npx playwright test "AItest/E2ETest"'), "e2e");
    assert.equal(
      classifyExecutionLane('dotnet test "AItest/AItest.UnitTests.csproj"'),
      "unit"
    );
    assert.equal(classifyExecutionLane("custom-script.cmd"), "advanced");
  });

  it("summarizes execution history", () => {
    const s = summarizeExecutions([
      {
        status: "Passed",
        command: "dotnet test AItest/AItest.UnitTests.csproj",
        passed: 3,
        failed: 0,
        total: 3,
      },
      {
        status: "Failed",
        command: "npx playwright test AItest/E2ETest",
        passed: 1,
        failed: 2,
        total: 3,
      },
    ]);
    assert.equal(s.totalRuns, 2);
    assert.equal(s.passedRuns, 1);
    assert.equal(s.failedRuns, 1);
    assert.equal(s.unitRuns, 1);
    assert.equal(s.e2eRuns, 1);
    assert.equal(s.testsTotal, 6);
  });
});
