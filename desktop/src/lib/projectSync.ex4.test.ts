/**
 * EX4.3 — project meta preserves e2e env across scan rebuild.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { buildProjectMetaFromScan } from "./projectSync";
import type { ProjectMeta } from "../api/types";
import type { ProjectScan } from "../tauri/bridge";

const scanStub = {
  name: "demo",
  frameworks: ["react"],
  testFrameworks: [],
  stacks: [],
  solutionFiles: [],
  csprojFiles: [],
  testProjects: [],
  modules: [],
} as unknown as ProjectScan;

describe("buildProjectMetaFromScan EX4.3", () => {
  it("preserves e2e + codeAliases from previous meta", () => {
    const prev: ProjectMeta = {
      e2e: {
        targetUrl: "http://localhost:5173",
        usePlaywrightInspect: true,
        useStorageState: false,
      },
      codeAliases: { login: ["SignIn"] },
      aiRules: { user: "keep-me", projectExtra: "extra" },
    };
    const next = buildProjectMetaFromScan(scanStub, prev);
    assert.equal(next.e2e?.targetUrl, "http://localhost:5173");
    assert.equal(next.e2e?.usePlaywrightInspect, true);
    assert.deepEqual(next.codeAliases, { login: ["SignIn"] });
    assert.equal(next.aiRules?.user, "keep-me");
    assert.equal(next.aiRules?.projectExtra, "extra");
    assert.ok(next.aiRules?.projectAuto);
    assert.ok(next.syncedAt);
  });

  it("respects lockProjectAuto", () => {
    const prev: ProjectMeta = {
      aiRules: {
        projectAuto: "LOCKED_AUTO",
        lockProjectAuto: true,
        user: "u",
      },
    };
    const next = buildProjectMetaFromScan(scanStub, prev);
    assert.equal(next.aiRules?.projectAuto, "LOCKED_AUTO");
    assert.equal(next.aiRules?.user, "u");
  });
});
