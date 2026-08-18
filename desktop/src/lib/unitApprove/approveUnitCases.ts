import {
  validateUnitApprovalDecision,
  type UnitApprovalDecision,
  type UnitApproveTcIr,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { buildUnitApproveTcIr } from "./buildTcIr";
import { resolveUnitApprovalViaIde } from "./resolveViaIde";

export type ApproveUnitCaseResult =
  | {
      ok: true;
      tc: TestCase;
      decision: UnitApprovalDecision;
    }
  | {
      ok: false;
      tc: TestCase;
      error: string;
    };

/**
 * Approve resolves one TC at a time through the IDE, so the caller can only show
 * real progress if each TC reports when it starts and when it settles.
 */
export type ApproveUnitProgress = {
  phase: "start" | "done";
  /** 0-based position of this TC in the requested batch. */
  index: number;
  total: number;
  tc: TestCase;
  /** Present on `done` only. */
  result?: ApproveUnitCaseResult;
};

export type ApproveUnitCasesDeps = {
  buildIr?: (
    tc: TestCase,
    opts?: { requirementTitle?: string | null }
  ) => UnitApproveTcIr;
  resolve?: typeof resolveUnitApprovalViaIde;
  persist?: (input: {
    projectId: string;
    projectRoot: string;
    tc: TestCase;
    decision: UnitApprovalDecision;
    requirementTitle?: string | null;
    deletePaths?: string[];
  }) => Promise<TestCase>;
};

export async function approveUnitCases(input: {
  projectId: string;
  projectRoot: string;
  cases: TestCase[];
  requirementTitle?: string | null;
  requirementTitleByCaseKey?: Record<string, string> | null;
  deletePathsByCaseKey?: Record<string, string[]> | null;
  onProgress?: (event: ApproveUnitProgress) => void;
  deps?: ApproveUnitCasesDeps;
}): Promise<ApproveUnitCaseResult[]> {
  const buildIr = input.deps?.buildIr || buildUnitApproveTcIr;
  const resolve = input.deps?.resolve || resolveUnitApprovalViaIde;
  const persist =
    input.deps?.persist ||
    (await import("./persistDecision")).persistUnitApprovalDecision;
  const results: ApproveUnitCaseResult[] = [];
  const total = input.cases.length;

  for (const [index, tc] of input.cases.entries()) {
    input.onProgress?.({ phase: "start", index, total, tc });
    try {
      const requirementTitle =
        input.requirementTitleByCaseKey?.[tc.id] ||
        input.requirementTitleByCaseKey?.[tc.testCaseId] ||
        input.requirementTitle;
      const tcIr = buildIr(tc, { requirementTitle });
      const decision = await resolve({
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        tc,
        tcIr,
      });
      const validation = validateUnitApprovalDecision(decision);
      if (!validation.ok) {
        throw new Error(`Invalid Unit Approve decision: ${validation.code}`);
      }
      // Persist READY (authoritative) and FEATURE_GAP/NOT_READY (nearest SUT retained).
      if (
        decision.outcome === "READY" &&
        !validateUnitApprovalDecision(decision, { requireAuthoritative: true })
          .ok
      ) {
        throw new Error(
          "READY Unit Approve decision failed authoritative validation"
        );
      }
      const approved = await persist({
        projectId: input.projectId,
        projectRoot: input.projectRoot,
        tc,
        decision,
        requirementTitle,
        deletePaths:
          input.deletePathsByCaseKey?.[tc.id] ||
          input.deletePathsByCaseKey?.[tc.testCaseId],
      });
      const result: ApproveUnitCaseResult = {
        ok: true,
        tc: approved,
        decision,
      };
      results.push(result);
      input.onProgress?.({ phase: "done", index, total, tc, result });
    } catch (error) {
      const result: ApproveUnitCaseResult = {
        ok: false,
        tc,
        error: error instanceof Error ? error.message : String(error),
      };
      results.push(result);
      input.onProgress?.({ phase: "done", index, total, tc, result });
    }
  }
  return results;
}
