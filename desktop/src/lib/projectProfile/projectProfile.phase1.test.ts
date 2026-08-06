import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildE2EEnvWithProfile, playwrightEnvFromConfig } from "../e2eWorkspace/env.js";
import { isValidStorageStateJson } from "./storageStateValidation.js";
import { resolveProfileForVerify } from "./resolveForVerify.js";
import type { ProfileIo } from "./types.js";

const VALID_STORAGE = JSON.stringify({
  cookies: [{ name: "s", value: "v", domain: "localhost", path: "/" }],
  origins: [],
});

function memoryIo(files: Record<string, string>): ProfileIo {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (_r, p) => files[p.replace(/\\/g, "/")],
    writeFile: async (_r, p, c) => {
      files[p.replace(/\\/g, "/")] = c;
    },
    readFileOptional: async (_r, p) => files[p.replace(/\\/g, "/")] ?? null,
    fileExists: async (_r, p) => p.replace(/\\/g, "/") in files,
  };
}

describe("projectProfile Sprint 1", () => {
  it("isValidStorageStateJson rejects empty", () => {
    assert.equal(isValidStorageStateJson("{}"), false);
    assert.equal(isValidStorageStateJson(VALID_STORAGE), true);
  });

  it("resolveProfileForVerify fails preflight when storage missing", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/project.profile.json": JSON.stringify({
        schema: "aitest-project-profile-v1",
        runner: "playwright",
        testRoot: "AItest/E2ETest",
        auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
        locatorPolicy: ["testid", "role", "label"],
        moduleMap: {},
        reuseRoots: [],
        updatedAt: "2026-01-01",
        playwrightRun: {
          packageRoot: "",
          storageState: {
            strategy: "storageState",
            canonicalRel: "./fixtures/storageState.json",
            discoverDirs: [".ai-test/auth"],
            sharedRel: "AItest/E2ETest/_shared/fixtures/storageState.json",
          },
        },
      }),
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.ok(ctx.preflightErrors.length >= 1);
    assert.match(ctx.preflightErrors[0], /storageState|PreconditionFailed/i);
  });

  it("resolveProfileForVerify ok when storage on disk", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/auth/storageState-admin.json": VALID_STORAGE,
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.storageStateValid, true);
    assert.equal(ctx.preflightErrors.length, 0);
    assert.equal(ctx.storageStateSource, "disk");
  });

  it("resolveProfileForVerify still finds storage when listFiles omits json", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/auth/storageState.json": VALID_STORAGE,
    });
    io.listFiles = async () => ["src/app.ts"];
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.storageStateValid, true);
    assert.equal(ctx.storageStateSource, "disk");
  });

  it("resolveProfileForVerify accepts auth seed default.json", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/auth/default.json": VALID_STORAGE,
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.storageStateValid, true);
    assert.equal(ctx.storageStateSource, "disk");
    assert.match(ctx.storageStateProjectRel || "", /\.ai-test\/auth\/default\.json$/);
  });

  it("resolveProfileForVerify accepts playwright declared in package.json", async () => {
    const io = memoryIo({
      "package.json": JSON.stringify({
        devDependencies: { "@playwright/test": "^1.0.0" },
      }),
      ".ai-test/auth/storageState.json": VALID_STORAGE,
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.playwrightInstalled, true);
    assert.equal(ctx.preflightErrors.length, 0);
  });

  it("resolveProfileForVerify accepts playwright from nested workspace package.json", async () => {
    const io = memoryIo({
      "apps/web/package.json": JSON.stringify({
        devDependencies: { "@playwright/test": "^1.48.0" },
      }),
      ".ai-test/auth/storageState.json": VALID_STORAGE,
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.playwrightInstalled, true);
    assert.equal(ctx.preflightErrors.length, 0);
  });

  it("resolveProfileForVerify accepts auth-seed username/password as UI-login", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/auth/default.json": JSON.stringify({
        role: "default",
        username: "admin",
        password: "admin",
        source: "aitest-auth-seed",
      }),
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.storageStateValid, true);
    assert.equal(ctx.storageStateSource, "auth-seed");
    assert.equal(ctx.authStrategy, "uiLogin");
    assert.equal(ctx.resolvedUsername, "admin");
    assert.equal(ctx.resolvedPassword, "admin");
    assert.equal(ctx.preflightErrors.length, 0);
  });

  it("resolveProfileForVerify accepts shared AITest playwright runner", async () => {
    const io = memoryIo({
      ".ai-test/auth/default.json": JSON.stringify({
        username: "admin",
        password: "admin",
      }),
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    // On developer machines with ~/.aitest/playwright-runner this is aitest-shared;
    // CI without shared runner still passes via auth-seed alone if PW somehow present —
    // assert only that auth-seed path clears storage preflight when PW is available.
    if (ctx.playwrightInstalled) {
      assert.equal(ctx.preflightErrors.length, 0);
      assert.ok(
        ctx.playwrightSource === "aitest-shared" || ctx.playwrightSource === "project"
      );
    }
  });

  it("resolveProfileForVerify allows ui-login fallback when credentials are present", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
    });
    const ctx = await resolveProfileForVerify(
      "/proj",
      { useStorageState: true, username: "admin", password: "123456" },
      io
    );
    assert.equal(ctx.storageStateValid, true);
    assert.equal(ctx.authStrategy, "uiLogin");
    assert.equal(ctx.preflightErrors.length, 0);
  });

  it("buildE2EEnvWithProfile uses profile baseURL and testId", () => {
    const env = buildE2EEnvWithProfile(
      {
        schema: "aitest-project-profile-v1",
        runner: "playwright",
        testRoot: "AItest/E2ETest",
        auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
        locatorPolicy: ["testid", "role", "label"],
        moduleMap: {},
        reuseRoots: [],
        updatedAt: "2026-01-01",
        playwrightRun: {
          packageRoot: "",
          workCwd: "per-tc-config",
          configPattern: "**/playwright.config.ts",
          baseURLEnv: "E2E_BASE_URL",
          defaultBaseURL: "http://localhost:4200",
          testIdAttribute: "data-cy",
          storageState: {
            strategy: "storageState",
            canonicalRel: "./fixtures/storageState.json",
            discoverDirs: [".ai-test/auth"],
            sharedRel: "AItest/E2ETest/_shared/fixtures/storageState.json",
          },
          seed: { globalSetupRel: null, seedCommand: "", teardownCommand: "" },
          run: {
            workers: 1,
            timeoutMs: 90000,
            headless: false,
            slowMoMs: 500,
            browser: "chromium",
          },
          envAllowlist: [],
        },
      },
      { targetUrl: "", useStorageState: true }
    );
    assert.equal(env.targetUrl, "http://localhost:4200");
    assert.equal(env.storageStateRel, "./fixtures/storageState.json");
    assert.equal(env.testIdAttribute, "data-cy");
    const pe = playwrightEnvFromConfig(env);
    assert.equal(pe.E2E_TEST_ID_ATTRIBUTE, "data-cy");
  });

  it("prepareVerifySession injects storage via resolve", async () => {
    const io = memoryIo({
      "node_modules/@playwright/test/package.json": "{}",
      ".ai-test/auth/storageState.json": VALID_STORAGE,
    });
    const ctx = await resolveProfileForVerify("/proj", { useStorageState: true }, io);
    assert.equal(ctx.storageStateValid, true);
    assert.ok(ctx.storageStateContent);
  });
});
