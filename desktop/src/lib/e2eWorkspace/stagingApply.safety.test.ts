/**
 * E2E overlay must not leak into the SUT as `{project}/unit-runs`.
 * Drafts live in OS temp (like Unit); Verify/Apply write AItest/E2ETest.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { e2eSuiteRoot } from "../testOutputLayout";

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, "stagingApply.ts"), "utf8");

describe("E2E overlay stays out of project unit-runs", () => {
  it("writeE2eOverlay uses Tool drafts, not project writeTextFile", () => {
    const fnStart = src.indexOf("export async function writeE2eOverlay");
    const next = src.indexOf("\nexport async function stageE2eOverlayToTargets");
    const body = src.slice(fnStart, next > 0 ? next : fnStart + 2500);
    assert.match(body, /writeDraftText\(/);
    assert.doesNotMatch(body, /writeTextFile\(projectRoot,\s*f\.workspaceRel/);
    assert.match(body, /removeLegacyProjectUnitRuns/);
  });

  it("Apply reads overlay from draft (with legacy fallback)", () => {
    assert.match(src, /readE2eOverlayText\(/);
    assert.match(src, /readDraftText\(/);
  });

  it("Verify copies overlay onto AItest/E2ETest", () => {
    assert.match(src, /export async function stageE2eOverlayToTargets/);
    assert.match(src, /export async function prepareE2eVerifyWorkspace/);
    const stageStart = src.indexOf("export async function stageE2eOverlayToTargets");
    const body = src.slice(stageStart, stageStart + 800);
    assert.match(body, /writeTextFileIfChanged\(projectRoot,\s*targetRel/);
  });

  it("stagingDirHint uses e2eSuiteRoot, not unit-runs", () => {
    const fnStart = src.indexOf("export function stagingDirHint");
    const body = src.slice(fnStart, fnStart + 400);
    assert.match(body, /e2eSuiteRoot/);
    assert.doesNotMatch(body, /workspaceRunDir/);
    assert.equal(e2eSuiteRoot(), "AItest/E2ETest");
    assert.equal(e2eSuiteRoot({ packagePrefix: "frontend" }), "frontend/AItest/E2ETest");
  });
});
