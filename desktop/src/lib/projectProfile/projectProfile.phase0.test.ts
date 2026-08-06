import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { discoverProjectProfile } from "./discoverProjectProfile.js";
import {
  loadProjectProfile,
  mergeProjectProfile,
  parseProjectProfileJson,
  saveProjectProfile,
} from "./loadSaveProfile.js";
import { renderE2eConventionsMd, renderE2ePlaywrightRunMd } from "./renderConventions.js";
import { discoverAndPersistProjectProfile } from "./index.js";
import type { ProfileIo, ProjectProfile } from "./types.js";

function memoryProfileIo(files: Record<string, string>): ProfileIo {
  return {
    listFiles: async () => Object.keys(files),
    readFile: async (_root, pathRel) => {
      const k = pathRel.replace(/\\/g, "/");
      if (!(k in files)) throw new Error(`missing ${k}`);
      return files[k];
    },
    writeFile: async (_root, pathRel, content) => {
      files[pathRel.replace(/\\/g, "/")] = content;
    },
    readFileOptional: async (_root, pathRel) => {
      const k = pathRel.replace(/\\/g, "/");
      return k in files ? files[k] : null;
    },
    fileExists: async (_root, pathRel) => {
      const k = pathRel.replace(/\\/g, "/");
      return k in files;
    },
  };
}

describe("projectProfile Sprint 0", () => {
  it("parses playwright config and detects packageRoot", async () => {
    const files: Record<string, string> = {
      "node_modules/@playwright/test/package.json": '{"name":"@playwright/test"}',
      "playwright.config.ts": `
import { defineConfig } from '@playwright/test';
export default defineConfig({
  use: { baseURL: 'http://localhost:4200', storageState: './fixtures/auth.json' },
  workers: 2,
  timeout: 60000,
  globalSetup: './global-setup.ts',
});
`,
      "src/app/home.component.html": '<div data-cy="home">Hi</div>',
      "AItest/E2ETest/_shared/fixtures/auth.helper.ts": "export {}",
    };
    const io = memoryProfileIo(files);
    const { profile, notes } = await discoverProjectProfile("/proj", io);
    assert.equal(profile.runner, "playwright");
    assert.equal(profile.playwrightRun?.packageRoot, "");
    assert.equal(profile.playwrightRun?.defaultBaseURL, "http://localhost:4200");
    assert.equal(profile.playwrightRun?.storageState.canonicalRel, "./fixtures/auth.json");
    assert.equal(profile.playwrightRun?.run.workers, 2);
    assert.equal(profile.playwrightRun?.seed.globalSetupRel, "./global-setup.ts");
    assert.equal(profile.playwrightRun?.testIdAttribute, "data-cy");
    assert.ok(notes.some((n) => n.includes("playwright")));
  });

  it("merge keeps user moduleMap keys", () => {
    const discovered: ProjectProfile = {
      schema: "aitest-project-profile-v1",
      runner: "playwright",
      testRoot: "AItest/E2ETest",
      moduleMap: { evidence: "/admin/evidence" },
      reuseRoots: [],
      auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
      locatorPolicy: ["testid"],
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const existing: ProjectProfile = {
      ...discovered,
      moduleMap: { "Vật-chứng": "/admin/digital-file" },
      updatedAt: "2025-01-01T00:00:00.000Z",
    };
    const merged = mergeProjectProfile(existing, discovered);
    assert.equal(merged.moduleMap["Vật-chứng"], "/admin/digital-file");
    assert.equal(merged.moduleMap.evidence, "/admin/evidence");
  });

  it("persist writes profile json and convention md", async () => {
    const files: Record<string, string> = {
      "node_modules/@playwright/test/package.json": "{}",
      "playwright.config.ts": "export default { use: { baseURL: 'http://x' } };",
    };
    const io = memoryProfileIo(files);
    const result = await discoverAndPersistProjectProfile("/proj", io);
    assert.ok(files[".ai-test/project.profile.json"]);
    assert.ok(files[".ai-test/e2e-conventions.md"]);
    assert.ok(files[".ai-test/e2e-playwright-run.md"]);
    const loaded = parseProjectProfileJson(files[".ai-test/project.profile.json"]);
    assert.equal(loaded?.schema, "aitest-project-profile-v1");
    assert.equal(result.profile.runner, "playwright");
  });

  it("render md includes testIdAttribute", () => {
    const profile = parseProjectProfileJson(
      JSON.stringify({
        schema: "aitest-project-profile-v1",
        runner: "playwright",
        testRoot: "AItest/E2ETest",
        playwrightRun: {
          packageRoot: "apps/web",
          workCwd: "per-tc-config",
          configPattern: "**/playwright.config.ts",
          baseURLEnv: "E2E_BASE_URL",
          defaultBaseURL: "http://localhost:4200",
          testIdAttribute: "data-testid",
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
          envAllowlist: ["E2E_BASE_URL"],
        },
        auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
        locatorPolicy: ["testid"],
        moduleMap: {},
        reuseRoots: [],
        updatedAt: "2026-01-01",
      })
    )!;
    const md = renderE2eConventionsMd(profile);
    assert.match(md, /data-testid/);
    const runMd = renderE2ePlaywrightRunMd(profile);
    assert.match(runMd, /apps\/web/);
  });

  it("loadProjectProfile returns null when missing", async () => {
    const io = memoryProfileIo({});
    const p = await loadProjectProfile("/proj", io);
    assert.equal(p, null);
  });

  it("suggests moduleMap from route catalog with strong score", async () => {
    const files: Record<string, string> = {
      "node_modules/@playwright/test/package.json": "{}",
      "src/app/features/evidence/evidence-list.component.ts": "export class X {}",
      "src/app/features/rooms/rooms-list.component.ts": "export class Y {}",
      "src/app/app-routing.module.ts": `
const routes = [
  { path: 'admin/evidence', component: EvidenceListComponent },
  { path: 'admin/rooms', component: RoomsListComponent },
];
`,
    };
    const io = memoryProfileIo(files);
    const { profile } = await discoverProjectProfile("/proj", io);
    assert.equal(profile.moduleMap.evidence, "/admin/evidence");
    assert.equal(profile.moduleMap.rooms, "/admin/rooms");
  });

  it("keeps user moduleMap keys after discover suggest", async () => {
    const files: Record<string, string> = {
      "node_modules/@playwright/test/package.json": "{}",
      "src/app/features/evidence/evidence-list.component.ts": "export class X {}",
      "src/app/app-routing.module.ts": `
const routes = [
  { path: 'admin/evidence', component: EvidenceListComponent },
];
`,
      ".ai-test/project.profile.json": JSON.stringify({
        schema: "aitest-project-profile-v1",
        runner: "playwright",
        testRoot: "AItest/E2ETest",
        moduleMap: { Evidence: "/custom/evidence" },
        reuseRoots: [],
        auth: { strategy: "storageState", storageDir: ".ai-test/auth", roles: [] },
        locatorPolicy: ["testid"],
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
    };
    const io = memoryProfileIo(files);
    const persisted = await discoverAndPersistProjectProfile("/proj", io);
    assert.equal(persisted.profile.moduleMap.Evidence, "/custom/evidence");
    assert.equal(persisted.profile.moduleMap.evidence, "/admin/evidence");
  });

  it("detects unit frameworks and renders unit conventions", async () => {
    const files: Record<string, string> = {
      "node_modules/@playwright/test/package.json": "{}",
      "vitest.config.ts": "export default {};",
      "pyproject.toml": "[tool.pytest.ini_options]\naddopts='-q'",
      "tests/test_health.py": "def test_health(): assert True",
      "src/MyApp.UnitTests/MyApp.UnitTests.csproj":
        "<Project><ItemGroup><PackageReference Include=\"xunit\" Version=\"2.6.6\" /></ItemGroup></Project>",
    };
    const io = memoryProfileIo(files);
    const { profile } = await discoverProjectProfile("/proj", io);
    assert.ok(profile.unit?.testFrameworks?.includes("vitest"));
    assert.ok(profile.unit?.testFrameworks?.includes("pytest"));
    assert.ok(profile.unit?.testFrameworks?.includes("xunit"));
  });
});
