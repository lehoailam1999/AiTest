/**
 * Unit drafts stay outside the source; Verify restores source after each run.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("cleanupWorkspaceRunAfterApply safety", () => {
  it("deletes the Tool draft, not a source-local run directory", () => {
    const src = readFileSync(join(here, "cleanup.ts"), "utf8");
    const fnStart = src.indexOf("export async function cleanupWorkspaceRunAfterApply");
    const nextExport = src.indexOf("\nexport async function removeAiTestDirAfterApplyBatch");
    const fnBody = src.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 2000);
    assert.match(fnBody, /deleteDraftPath\(projectRoot,\s*runDir\)/);
    assert.doesNotMatch(fnBody, /deleteDir\(projectRoot,\s*runDir\)/);
  });
});

describe("applyManyWorkspacesToRepo batch safety", () => {
  it("writes all overlays before finalize/cleanup", () => {
    const src = readFileSync(join(here, "applyManager.ts"), "utf8");
    assert.match(src, /export async function applyManyWorkspacesToRepo/);
    assert.match(
      src,
      /finalizeAppliedRun[\s\S]*cleanupWorkspaceRunAfterApply/,
      "finalize must cleanup runDir only"
    );
    const fnStart = src.indexOf("export async function applyManyWorkspacesToRepo");
    const nextExport = src.indexOf("\nexport async function applyWorkspaceToRepo", fnStart + 1);
    const fnBody = src.slice(fnStart, nextExport > 0 ? nextExport : fnStart + 6000);
    const writeIdx = fnBody.indexOf("writeManifestOverlay");
    const finalizeIdx = fnBody.indexOf("finalizeAppliedRun");
    assert.ok(writeIdx >= 0, "batch apply must write overlays");
    assert.ok(finalizeIdx >= 0, "batch apply must finalize (cleanup) after write");
    assert.ok(
      writeIdx < finalizeIdx,
      "MUST write all overlays before cleanup (otherwise sibling staging vanishes → 1 file left)"
    );
  });

  it("single Apply delegates to batch pipeline (no duplicate write path)", () => {
    const src = readFileSync(join(here, "applyManager.ts"), "utf8");
    const fnStart = src.indexOf("export async function applyWorkspaceToRepo");
    assert.ok(fnStart >= 0);
    const fnBody = src.slice(fnStart, fnStart + 800);
    assert.match(fnBody, /applyManyWorkspacesToRepo/);
    assert.doesNotMatch(
      fnBody,
      /writeManifestOverlay/,
      "single must not reimplement write — use applyMany"
    );
  });
});

describe("Unit Verify restores source until Update/Apply", () => {
  it("combinedBatchVerify captures backups and restores source", () => {
    const src = readFileSync(join(here, "combinedBatchVerify.ts"), "utf8");
    assert.match(src, /captureStagingBackups/);
    assert.match(src, /restoreSourceAfterVerify/);
  });

  it("verifyEngine rolls temporary targets back", () => {
    const src = readFileSync(join(here, "verifyEngine.ts"), "utf8");
    assert.match(src, /captureStagingBackups/);
    assert.match(src, /rollbackStaging/);
  });

  it("staging helper exposes source restoration", () => {
    const src = readFileSync(join(here, "staging.ts"), "utf8");
    assert.match(src, /export async function restoreSourceAfterVerify/);
    assert.match(src, /rollbackStaging/);
  });
});

describe("Apply removes .ai-test folder", () => {
  it("applyMany sweeps .ai-test after per-run cleanup", () => {
    const src = readFileSync(join(here, "applyManager.ts"), "utf8");
    assert.match(src, /removeAiTestDirAfterApplyBatch/);
    const fnStart = src.indexOf("export async function applyManyWorkspacesToRepo");
    const fnBody = src.slice(fnStart, fnStart + 5500);
    const cleanIdx = fnBody.indexOf("finalizeAppliedRun");
    const sweepIdx = fnBody.indexOf("removeAiTestDirAfterApplyBatch");
    assert.ok(cleanIdx >= 0 && sweepIdx >= 0);
    assert.ok(
      cleanIdx < sweepIdx,
      "sweep .ai-test only after per-run cleanup"
    );
  });

  it("removeAiTestDirAfterApplyBatch wipes staging and logs, keeps test-cases", () => {
    const src = readFileSync(join(here, "cleanup.ts"), "utf8");
    const fnStart = src.indexOf("export async function removeAiTestDirAfterApplyBatch");
    const fnBody = src.slice(fnStart);
    assert.match(fnBody, /AI_TEST_STAGING_DIR/);
    assert.match(fnBody, /AI_TEST_LOGS_DIR/);
    assert.match(
      fnBody,
      /deleteDir\(\s*projectRoot\s*,\s*`\$\{root\}\/\$\{AI_TEST_STAGING_DIR\}`\s*\)/,
      "batch finish must full-delete leftover staging/"
    );
    assert.match(
      fnBody,
      /deleteDir\(\s*projectRoot\s*,\s*`\$\{root\}\/\$\{AI_TEST_LOGS_DIR\}`\s*\)/,
      "batch finish must full-delete leftover logs/"
    );
    assert.doesNotMatch(
      fnBody,
      /deleteDir\(\s*projectRoot\s*,\s*root\s*\)/,
      "must not wipe entire .ai-test (test-cases / aliases stay)"
    );
    assert.match(fnBody, /deleteDir\(\s*projectRoot\s*,\s*root\s*,\s*\{\s*emptyOnly:\s*true/);
  });
});
