/**
 * Step 3 — Verify + Auto-Repair loop trên Agent Staging (max 3).
 * Mỗi lần fail: gọi repair (AI CLI/API) → cập nhật staging → Verify lại.
 */
import { runWorkspaceVerify } from "./verifyEngine";
import type { UnitWorkspaceManifest, VerifyReport } from "./types";

export const AUTO_REPAIR_MAX_ATTEMPTS = 3;

export type AutoRepairProgress = {
  attempt: number;
  maxAttempts: number;
  phase: "verify" | "repair" | "done";
  message: string;
};

export type RunVerifyWithAutoRepairInput = {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
  compileCommand?: string;
  testCommand: string;
  coverageCommand?: string;
  maxAttempts?: number;
  /** Trả manifest đã ghi code sửa (cùng runId / targetRel). */
  repair: (manifest: UnitWorkspaceManifest) => Promise<UnitWorkspaceManifest>;
  onProgress?: (p: AutoRepairProgress) => void;
};

export type AutoRepairLoopResult = {
  manifest: UnitWorkspaceManifest;
  report: VerifyReport | undefined;
  attempts: number;
  passed: boolean;
  repaired: boolean;
};

export async function runVerifyWithAutoRepair(
  input: RunVerifyWithAutoRepairInput
): Promise<AutoRepairLoopResult> {
  const maxAttempts = Math.max(1, input.maxAttempts ?? AUTO_REPAIR_MAX_ATTEMPTS);
  let manifest = input.manifest;
  let report: VerifyReport | undefined = manifest.verify;
  let repaired = false;
  let attempts = 0;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    attempts = attempt;
    input.onProgress?.({
      attempt,
      maxAttempts,
      phase: "verify",
      message: `Verify lần ${attempt}/${maxAttempts}…`,
    });

    const verified = await runWorkspaceVerify({
      projectRoot: input.projectRoot,
      manifest,
      compileCommand: input.compileCommand,
      testCommand: input.testCommand,
      coverageCommand: input.coverageCommand,
    });
    manifest = verified.manifest;
    report = verified.report;

    if (verified.report.overallPass) {
      input.onProgress?.({
        attempt,
        maxAttempts,
        phase: "done",
        message: attempt === 1 ? "Verify PASS" : `Verify PASS sau ${attempt - 1} lần repair`,
      });
      return { manifest, report, attempts, passed: true, repaired };
    }

    if (attempt >= maxAttempts) {
      break;
    }

    input.onProgress?.({
      attempt,
      maxAttempts,
      phase: "repair",
      message: `Verify FAIL — AI Auto-Repair ${attempt}/${maxAttempts - 1}…`,
    });

    manifest = await input.repair(manifest);
    repaired = true;
  }

  input.onProgress?.({
    attempt: attempts,
    maxAttempts,
    phase: "done",
    message: `Vẫn FAIL sau ${attempts} lần Verify (đã repair ${Math.max(0, attempts - 1)} lần)`,
  });

  return { manifest, report, attempts, passed: false, repaired };
}
