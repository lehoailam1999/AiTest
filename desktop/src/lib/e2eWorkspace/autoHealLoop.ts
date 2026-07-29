/**
 * E2E Headless + Auto-Heal loop trên staging (max 3).
 * Mirror unitWorkspace/autoRepairLoop — verify via injectable runner.
 */
import type { E2EFileEntry, E2EWorkspaceManifest } from "./types";

export const E2E_AUTO_HEAL_MAX_ATTEMPTS = 3;

export type AutoHealProgress = {
  attempt: number;
  maxAttempts: number;
  phase: "verify" | "heal" | "done";
  message: string;
};

export type RunHeadlessResult = {
  exitCode: number;
  log: string;
  overallPass: boolean;
};

export type RunE2EWithAutoHealInput = {
  manifest: E2EWorkspaceManifest;
  maxAttempts?: number;
  /** Run playwright (or mock) against current manifest files. */
  runHeadless: (manifest: E2EWorkspaceManifest) => Promise<RunHeadlessResult>;
  /**
   * AI heal — returns updated files (merged into manifest).
   * Called only when verify fails and attempts remain.
   */
  heal: (
    manifest: E2EWorkspaceManifest,
    errorLog: string,
    attempt: number
  ) => Promise<E2EFileEntry[]>;
  onProgress?: (p: AutoHealProgress) => void;
};

export type AutoHealLoopResult = {
  manifest: E2EWorkspaceManifest;
  attempts: number;
  passed: boolean;
  healed: boolean;
  lastLog: string;
};

export async function runE2EWithAutoHeal(
  input: RunE2EWithAutoHealInput
): Promise<AutoHealLoopResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? E2E_AUTO_HEAL_MAX_ATTEMPTS);
  let manifest = input.manifest;
  let healed = false;
  let attempts = 0;
  let lastLog = "";

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    input.onProgress?.({
      attempt,
      maxAttempts,
      phase: "verify",
      message: `Headless lần ${attempt}/${maxAttempts}…`,
    });

    const result = await input.runHeadless(manifest);
    lastLog = result.log;
    if (result.overallPass) {
      manifest = {
        ...manifest,
        status: "pass",
        autoHealAttempts: attempt,
      };
      input.onProgress?.({
        attempt,
        maxAttempts,
        phase: "done",
        message:
          attempt === 1
            ? "E2E PASS"
            : `E2E PASS sau ${attempt - 1} lần auto-heal`,
      });
      return { manifest, attempts, passed: true, healed, lastLog };
    }

    if (attempt >= maxAttempts) break;

    input.onProgress?.({
      attempt,
      maxAttempts,
      phase: "heal",
      message: `FAIL — AI Auto-Heal ${attempt}/${maxAttempts - 1}…`,
    });

    const fixed = await input.heal(manifest, result.log, attempt);
    const byPath = new Map(manifest.files.map((f) => [f.path, f]));
    for (const f of fixed) {
      byPath.set(f.path, f);
    }
    manifest = {
      ...manifest,
      files: [...byPath.values()],
      status: "verifying",
      autoHealAttempts: attempt,
    };
    healed = true;
  }

  manifest = { ...manifest, status: "fail", autoHealAttempts: attempts };
  input.onProgress?.({
    attempt: attempts,
    maxAttempts,
    phase: "done",
    message: `Vẫn FAIL sau ${attempts} lần Headless`,
  });
  return { manifest, attempts, passed: false, healed, lastLog };
}
