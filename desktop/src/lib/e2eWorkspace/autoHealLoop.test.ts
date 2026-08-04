import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runE2EWithAutoHeal } from "./autoHealLoop.js";
import type { E2EWorkspaceManifest } from "./types.js";
import { buildE2EEnvConfig, playwrightEnvFromConfig } from "./env.js";

function baseManifest(): E2EWorkspaceManifest {
  return {
    version: 1,
    runId: "r1",
    projectId: "p1",
    testCaseId: "t1",
    createdAt: new Date().toISOString(),
    status: "generated",
    files: [
      {
        path: "AItest/E2ETest/Auth/specs/a.spec.ts",
        content: "x",
        kind: "spec",
      },
    ],
    primarySpecPath: "AItest/E2ETest/Auth/specs/a.spec.ts",
    env: buildE2EEnvConfig({
      targetUrl: "http://localhost:3000",
      useStorageState: true,
      module: "Auth",
    }),
  };
}

describe("e2eWorkspace autoHealLoop", () => {
  it("passes on first headless", async () => {
    const result = await runE2EWithAutoHeal({
      manifest: baseManifest(),
      runHeadless: async () => ({ exitCode: 0, log: "ok", overallPass: true }),
      heal: async () => [],
    });
    assert.equal(result.passed, true);
    assert.equal(result.attempts, 1);
    assert.equal(result.healed, false);
  });

  it("heals then passes", async () => {
    let n = 0;
    let healCalls = 0;
    const result = await runE2EWithAutoHeal({
      manifest: baseManifest(),
      runHeadless: async () => {
        n += 1;
        return n === 1
          ? { exitCode: 1, log: "TimeoutError", overallPass: false }
          : { exitCode: 0, log: "ok", overallPass: true };
      },
      heal: async () => {
        healCalls += 1;
        return [
          {
            path: "AItest/E2ETest/Auth/pages/a.page.ts",
            content: "fixed",
            kind: "page",
          },
        ];
      },
    });
    assert.equal(result.passed, true);
    assert.equal(result.attempts, 2);
    assert.equal(result.healed, true);
    assert.equal(healCalls, 1);
    assert.ok(result.manifest.files.some((f) => f.content === "fixed"));
  });
});

describe("e2eWorkspace env", () => {
  it("builds storageState path and playwright env", () => {
    const env = buildE2EEnvConfig({
      targetUrl: "http://localhost:5173",
      module: "Auth",
      useStorageState: true,
      seedCommand: "npm run seed",
    });
    assert.equal(env.storageStateRel, "./fixtures/storageState.json");
    assert.equal(env.seedCommand, "npm run seed");
    const pe = playwrightEnvFromConfig(env);
    assert.equal(pe.E2E_BASE_URL, "http://localhost:5173");
    assert.equal(pe.E2E_STORAGE_STATE, "./fixtures/storageState.json");
  });

  it("ignores nested AItest module storage paths", () => {
    const env = buildE2EEnvConfig({
      useStorageState: true,
      storageStateRel: "AItest/E2ETest/Vật-chứng/fixtures/storageState.json",
    });
    assert.equal(env.storageStateRel, "./fixtures/storageState.json");
  });
});
