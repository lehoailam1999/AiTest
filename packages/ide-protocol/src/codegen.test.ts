/**
 * Codegen schema + path jail contract tests.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  IdeMethods,
  IdeNotifications,
  assertSafeAitestTargetRel,
  assertSafeAiTestCasesRel,
  assertSafeAiTestCasesReadRel,
  isAllowedE2eEnvKey,
  isAllowedUnitLayoutPath,
  type CodegenApplyFilesParams,
  type CodegenResultCallback,
} from "./index.js";

describe("ide-protocol codegen schema", () => {
  it("exposes codegen method names", () => {
    assert.equal(IdeMethods.codegenApplyFiles, "aitest/codegen.applyFiles");
    assert.equal(IdeMethods.codegenRunTests, "aitest/codegen.runTests");
    assert.equal(IdeMethods.codegenGenerateE2eBatch, "aitest/codegen.generateE2eBatch");
    assert.equal(IdeNotifications.codegenProgress, "aitest/codegen.progress");
    assert.equal(IdeNotifications.codegenResult, "aitest/codegen.result");
  });

  it("round-trips apply payload shape", () => {
    const payload: CodegenApplyFilesParams = {
      commandId: "cmd-1",
      action: "APPLY_FILES",
      projectId: "p1",
      projectRoot: "D:/proj",
      layout: "e2e",
      projectRules: "",
      projectRulesSource: "none",
      files: [
        {
          path: "AItest/E2ETest/Req/TC/specs/x.spec.ts",
          content: "import { test } from '@playwright/test';",
          kind: "spec",
        },
      ],
    };
    const json = JSON.parse(JSON.stringify(payload)) as CodegenApplyFilesParams;
    assert.equal(json.files[0].path.includes("AItest/E2ETest"), true);
    assert.equal(json.action, "APPLY_FILES");
  });

  it("round-trips result callback shape", () => {
    const cb: CodegenResultCallback = {
      commandId: "cmd-1",
      status: "COMPLETED",
      workspaceTree: {
        testRoot: "AItest/E2ETest",
        generatedFiles: [{ path: "AItest/E2ETest/a.spec.ts", status: "CREATED", size: 10 }],
      },
      files: [
        {
          path: "AItest/UnitTest/Mod/foo.test.ts",
          content: "test('x', () => {});",
          kind: "unit",
        },
      ],
      testRunReport: {
        passed: 1,
        failed: 0,
        skipped: 0,
        durationMs: 100,
        errors: [],
      },
    };
    assert.equal(JSON.parse(JSON.stringify(cb)).status, "COMPLETED");
    assert.equal(cb.files?.[0]?.kind, "unit");
  });

  it("exposes generateUnitBatch method", () => {
    assert.equal(IdeMethods.codegenGenerateUnitBatch, "aitest/codegen.generateUnitBatch");
  });

  it("round-trips optional agentExecutable on generate batch", () => {
    const payload: import("./codegenTypes.js").CodegenGenerateUnitBatchParams = {
      commandId: "cmd-1",
      action: "GENERATE_UNIT_BATCH",
      projectId: "p1",
      projectRoot: "/sut",
      items: [{ testCaseId: "TC-1", title: "x" }],
      agentExecutable: "/home/user/.local/bin/agent",
    };
    const json = JSON.parse(JSON.stringify(payload)) as typeof payload;
    assert.equal(json.agentExecutable, "/home/user/.local/bin/agent");
  });

  it("path jail accepts AItest layout and rejects production mirrors", () => {
    assert.equal(
      assertSafeAitestTargetRel("AItest/E2ETest/Req/TC/specs/x.spec.ts"),
      "AItest/E2ETest/Req/TC/specs/x.spec.ts"
    );
    assert.throws(() => assertSafeAitestTargetRel("src/app/foo.ts"));
    assert.throws(() => assertSafeAitestTargetRel("AItest/src/evil.ts"));
    assert.throws(() => assertSafeAitestTargetRel("../AItest/x.ts"));
  });

  it("unit layout allows UnitTest + AItest-root csproj scaffold", () => {
    assert.equal(isAllowedUnitLayoutPath("AItest/UnitTest/Mod/x.cs"), true);
    assert.equal(isAllowedUnitLayoutPath("AItest/AItest.UnitTests.csproj"), true);
    assert.equal(isAllowedUnitLayoutPath("backend/AItest/AItest.UnitTests.csproj"), true);
    assert.equal(isAllowedUnitLayoutPath("AItest/jest.config.cjs"), true);
    assert.equal(
      isAllowedUnitLayoutPath("AItest/test-cases/UnitTest/Mod/TC-1.md"),
      false
    );
    assert.equal(isAllowedUnitLayoutPath("AItest/src/evil.cs"), false);
    assert.equal(isAllowedUnitLayoutPath("AItest/Other/foo.cs"), false);
  });

  it("allowlists E2E env keys", () => {
    assert.equal(isAllowedE2eEnvKey("E2E_BASE_URL"), true);
    assert.equal(isAllowedE2eEnvKey("E2E_ADMIN_USERNAME"), true);
    assert.equal(isAllowedE2eEnvKey("E2E_SECRET_TOKEN"), false);
  });

  it("exposes tc.syncApprovedMd and jails AItest/test-cases", () => {
    assert.equal(IdeMethods.tcSyncApprovedMd, "aitest/tc.syncApprovedMd");
    assert.equal(
      assertSafeAiTestCasesRel("AItest/test-cases/UnitTest/account/TC-1.md"),
      "AItest/test-cases/UnitTest/account/TC-1.md"
    );
    assert.equal(
      assertSafeAiTestCasesRel("AItest/test-cases/E2ETest/account/TC-1.md"),
      "AItest/test-cases/E2ETest/account/TC-1.md"
    );
    assert.equal(
      assertSafeAiTestCasesReadRel(
        ".ai-test/test-cases/UnitTest/account/TC-1.md"
      ),
      ".ai-test/test-cases/UnitTest/account/TC-1.md"
    );
    assert.throws(() =>
      assertSafeAiTestCasesRel(".ai-test/test-cases/UnitTest/account/TC-1.md")
    );
    assert.throws(() => assertSafeAiTestCasesRel("AItest/E2ETest/x.md"));
    assert.throws(() => assertSafeAiTestCasesRel(".ai-test/evil.json"));
    assert.throws(() => assertSafeAiTestCasesRel("../.ai-test/test-cases/x.md"));
  });
});
