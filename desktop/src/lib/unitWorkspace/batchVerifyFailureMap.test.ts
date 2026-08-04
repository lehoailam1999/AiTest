/**
 * Per-unit attribution of batch Verify failures (Jest + .NET/xUnit).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  batchVerifyPass,
  extractFailedPathTokens,
  extractUnitFailureExcerpt,
  rowMatchesFailedTokens,
} from "./batchVerifyFailureMap.js";
import type { UnitWorkspaceManifest } from "./types.js";

function manifest(
  runId: string,
  targetRel: string,
  overallPass = false
): UnitWorkspaceManifest {
  return {
    version: 1,
    runId,
    projectId: "p1",
    testCaseId: runId,
    createdAt: new Date().toISOString(),
    status: overallPass ? "pass" : "fail",
    files: [
      {
        op: "new",
        targetRel,
        workspaceRel: `overlay/${targetRel}`,
      },
    ],
    verify: {
      ranAt: new Date().toISOString(),
      overallPass,
      stages: [],
    },
  };
}

const DOTNET_LOG = `
  Failed Forensic.Infrastructure.AItest.UnitTest.StorageProviderFactoryTests_d363eb05.Create_WhenMinio_ShouldReturnS3Provider [26 ms]
  Failed Forensic.Infrastructure.AItest.UnitTest.StorageProviderFactoryTests_d363eb05.Create_WhenAwsS3_ShouldReturnS3Provider [1 s]
  Failed Forensic.Infrastructure.AItest.UnitTest.StorageProviderFactoryTests_ca4c339f.Create_WhenStorageTypeIsMinioAwsOrCloud_ShouldReturnS3StorageProvider(storageType: CLOUD) [2 s]
  at Forensic.Infrastructure.AItest.UnitTest.StorageProviderFactoryTests_d363eb05.Create_WhenMinio_ShouldReturnS3Provider() in D:\\Xlab\\Forensic\\forensic\\src\\Forensic.Infrastructure\\AItest\\UnitTest\\Vật-chứng\\StorageProviderFactoryTests_d363eb05.cs:line 40
[xUnit.net 00:00:04.04]     Forensic.Infrastructure.AItest.UnitTest.StorageProviderFactoryTests_ca4c339f.Create_WhenStorageTypeIsMinioAwsOrCloud_ShouldReturnS3StorageProvider(storageType: MINIO) [FAIL]
Failed!  - Failed:     6, Passed:    31, Skipped:     1, Total:    38, Duration: 3 s
`;

describe("extractFailedPathTokens (.NET)", () => {
  it("extracts class and .cs tokens from xUnit Failed lines", () => {
    const tokens = extractFailedPathTokens(DOTNET_LOG);
    assert.ok(tokens.some((t) => t.includes("storageproviderfactorytests_d363eb05")));
    assert.ok(tokens.some((t) => t.includes("storageproviderfactorytests_ca4c339f")));
    assert.ok(tokens.some((t) => t.endsWith(".cs")));
    // Must not treat summary banner as a failure token
    assert.ok(!tokens.some((t) => t === "failed!" || t.startsWith("failed:")));
  });

  it("still extracts Jest FAIL paths", () => {
    const tokens = extractFailedPathTokens(
      "FAIL src/AItest/UnitTest/foo_abc.test.ts\n  ● foo\n"
    );
    assert.ok(tokens.some((t) => t.includes("foo_abc.test.ts")));
  });
});

describe("batchVerifyPass (.NET attribution)", () => {
  it("fails only units whose class appears in the log", () => {
    const failA = manifest(
      "d363eb05",
      "AItest/UnitTest/Vật-chứng/StorageProviderFactoryTests_d363eb05.cs"
    );
    const failB = manifest(
      "ca4c339f",
      "AItest/UnitTest/Vật-chứng/StorageProviderFactoryTests_ca4c339f.cs"
    );
    const passOther = manifest(
      "e4e88801",
      "AItest/UnitTest/Vật-chứng/CaseRecordEvidenceRepositoryTests_e4e88801.cs"
    );

    const tokens = extractFailedPathTokens(DOTNET_LOG);
    assert.ok(tokens.length > 0);
    const hasMapped = tokens.length > 0;

    assert.equal(
      batchVerifyPass({ testCaseId: "d363eb05" }, failA, tokens, hasMapped),
      false
    );
    assert.equal(
      batchVerifyPass({ testCaseId: "ca4c339f" }, failB, tokens, hasMapped),
      false
    );
    assert.equal(
      batchVerifyPass({ testCaseId: "e4e88801" }, passOther, tokens, hasMapped),
      true
    );
  });

  it("fails all units when no failure tokens can be mapped", () => {
    const m = manifest("x", "AItest/UnitTest/Foo.cs");
    assert.equal(
      batchVerifyPass({ testCaseId: "x" }, m, [], false),
      false
    );
  });

  it("respects overallPass on manifest", () => {
    const m = manifest("x", "AItest/UnitTest/Foo.cs", true);
    assert.equal(batchVerifyPass({ testCaseId: "x" }, m, [], false), true);
  });

  it("rowMatchesFailedTokens matches .cs basename to class token", () => {
    const m = manifest(
      "d363eb05",
      "AItest/UnitTest/StorageProviderFactoryTests_d363eb05.cs"
    );
    assert.equal(
      rowMatchesFailedTokens(
        { testCaseId: "d363eb05" },
        m,
        ["storageproviderfactorytests_d363eb05"]
      ),
      true
    );
  });

  it("extractUnitFailureExcerpt keeps Error Message for matched class", () => {
    const m = manifest(
      "d363eb05",
      "AItest/UnitTest/StorageProviderFactoryTests_d363eb05.cs"
    );
    const tokens = extractFailedPathTokens(DOTNET_LOG);
    const excerpt = extractUnitFailureExcerpt(
      DOTNET_LOG,
      { testCaseId: "d363eb05" },
      m,
      tokens
    );
    assert.ok(excerpt.includes("StorageProviderFactoryTests_d363eb05"));
    assert.ok(!excerpt.includes("CaseRecordEvidence"));
  });
});
