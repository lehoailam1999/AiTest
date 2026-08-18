import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  addSuccessfulOwnership,
  emptyOwnershipRegistry,
  isOwnedUnitTestCodePath,
  planFailedOwnershipCleanup,
} from "./unitArtifactOwnership.ts";

describe("unit artifact ownership", () => {
  it("registers executable Unit files but never scaffolds/configs", () => {
    const registry = addSuccessfulOwnership(emptyOwnershipRegistry(), "tc-1", [
      "AItest/UnitTest/Evidence/EvidenceTests.cs",
      "AItest/UnitTest/aitest.unittests.csproj",
      "AItest/UnitTest/jest.config.ts",
    ]);
    assert.deepEqual(registry.files, {
      "AItest/UnitTest/Evidence/EvidenceTests.cs": ["tc-1"],
    });
    assert.equal(
      isOwnedUnitTestCodePath("AItest/UnitTest/Evidence/evidence.spec.ts"),
      true
    );
    assert.equal(
      isOwnedUnitTestCodePath("AItest/test-cases/UnitTest/Evidence/TC-1.md"),
      false
    );
  });

  it("deletes only files exclusively owned by a failed TC", () => {
    let registry = addSuccessfulOwnership(emptyOwnershipRegistry(), "tc-ok", [
      "AItest/UnitTest/Evidence/SharedTests.cs",
      "AItest/UnitTest/Evidence/OkTests.cs",
    ]);
    registry = addSuccessfulOwnership(registry, "tc-fail", [
      "AItest/UnitTest/Evidence/SharedTests.cs",
      "AItest/UnitTest/Evidence/FailedTests.cs",
    ]);

    const plan = planFailedOwnershipCleanup(registry, ["TC-FAIL"]);
    assert.deepEqual(plan.deletePaths, [
      "AItest/UnitTest/Evidence/FailedTests.cs",
    ]);
    assert.deepEqual(plan.registry.files, {
      "AItest/UnitTest/Evidence/SharedTests.cs": ["tc-ok"],
      "AItest/UnitTest/Evidence/OkTests.cs": ["tc-ok"],
    });
  });

  it("keeps all successful TC files unchanged", () => {
    const registry = addSuccessfulOwnership(emptyOwnershipRegistry(), "tc-ok", [
      "backend/AItest/UnitTest/Evidence/OkTests.cs",
    ]);
    const plan = planFailedOwnershipCleanup(registry, ["tc-other"]);
    assert.deepEqual(plan.deletePaths, []);
    assert.deepEqual(plan.registry, registry);
  });
});
