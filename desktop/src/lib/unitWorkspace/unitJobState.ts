/**
 * Unit job status transitions (pure — safe for Node tests).
 */
import type { UnitWorkspaceStatus } from "./types";

export const UNIT_JOB_TRANSITIONS: Record<UnitWorkspaceStatus, UnitWorkspaceStatus[]> = {
  draft: ["generating", "discarded"],
  generating: ["generated", "gen_failed", "discarded"],
  generated: ["verifying", "discarded"],
  gen_failed: ["generating", "discarded"],
  verifying: ["pass", "fail"],
  pass: ["applied", "verifying"],
  fail: ["verifying", "discarded"],
  applied: [],
  discarded: [],
};

export function canTransitionUnitJob(
  from: UnitWorkspaceStatus,
  to: UnitWorkspaceStatus
): boolean {
  return (UNIT_JOB_TRANSITIONS[from] || []).includes(to);
}
