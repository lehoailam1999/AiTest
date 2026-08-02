/**
 * Unit workspace cleanup — must never wipe sibling staging runs.
 * Unit Verify must not wipe staged AItest/UnitTest (only Apply/Discard).
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));

describe("cleanupWorkspaceRunAfterApply safety", () => {
  it("source deletes only runDir then emptyOnly parents (not wipe all staging)", () => {
    const src = readFileSync(join(here, "cleanup.ts"), "utf8");
    assert.match(src, /emptyOnly:\s*true/);
    const wipeAll = src.match(
      /deleteDir\(\s*projectRoot\s*,\s*`\$\{aiTestDir\([^)]*\)\}\/\$\{AI_TEST_STAGING_DIR\}`\s*\)/
    );
    assert.equal(
      wipeAll,
      null,
      "Must not remove_dir_all the entire staging/ folder (kills sibling Apply overlays)"
    );
    assert.match(
      src,
      /deleteDir\(\s*projectRoot\s*,\s*`\$\{aiTestDir\([^)]*\)\}\/\$\{AI_TEST_STAGING_DIR\}`\s*,\s*\{\s*emptyOnly:\s*true/
    );
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

describe("Unit Verify preserves staged AItest files", () => {
  it("combinedBatchVerify re-stages overlays instead of rollback wipe", () => {
    const src = readFileSync(join(here, "combinedBatchVerify.ts"), "utf8");
    assert.match(src, /preserveStagedOverlays/);
    assert.doesNotMatch(
      src,
      /rollbackStaging\(/,
      "batch Verify must not rollback (that wiped UnitTest after PASS)"
    );
  });

  it("verifyEngine re-stages overlays instead of rollback wipe", () => {
    const src = readFileSync(join(here, "verifyEngine.ts"), "utf8");
    assert.match(src, /preserveStagedOverlays/);
    assert.doesNotMatch(src, /rollbackStaging\(/);
  });

  it("preserveStagedOverlays is the Verify keep-disk API", () => {
    const src = readFileSync(join(here, "staging.ts"), "utf8");
    assert.match(src, /export async function preserveStagedOverlays/);
    assert.match(src, /stageOverlayToTargets/);
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

  it("removeAiTestDirAfterApplyBatch full-deletes aiTestDir", () => {
    const src = readFileSync(join(here, "cleanup.ts"), "utf8");
    assert.match(src, /export async function removeAiTestDirAfterApplyBatch/);
    assert.match(
      src,
      /deleteDir\(\s*projectRoot\s*,\s*root\s*\)/,
      "must remove_dir_all .ai-test (not emptyOnly only)"
    );
  });
});
