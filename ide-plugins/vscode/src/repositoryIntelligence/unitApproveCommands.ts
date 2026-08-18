import {
  DEFAULT_UNIT_APPROVE_LIMITS,
  UNIT_APPROVE_REQUEST_SCHEMA,
  UNIT_APPROVE_RESPONSE_SCHEMA,
  type RepositoryRevision,
  type UnitApproveReason,
  type UnitApproveResolveParams,
  type UnitApproveResolveResult,
} from "@aitest/ide-protocol";
import {
  repositoryMemoKey,
  sharedApproveCliMemo,
  type ApproveCliMemo,
} from "./approveCliMemo";
import { extractBehaviorEvidence } from "./behaviorEvidence";
import { buildDecision } from "./buildDecision";
import { findExistingTests } from "./existingTests";
import { sha256 } from "./hash";
import {
  captureRepositoryRevision,
  compareRepositoryRevision,
} from "./revision";
import {
  resolveBindings,
  type FieldBindingPicker,
} from "./resolveBindings";
import { resolvePrimary } from "./resolvePrimary";
import type { RepositoryRuntime } from "./runtime";
import type { SymbolProposer } from "./symbolProposer";

const SUPPORTED_LANGUAGES = new Set([
  "csharp",
  "typescript",
  "typescriptreact",
  "javascript",
  "javascriptreact",
  "java",
  "kotlin",
  "python",
  "go",
]);

class ResolverTimeoutError extends Error {}

function fallbackRepository(runtime: RepositoryRuntime): RepositoryRevision {
  const root = runtime.workspaceRoot() || "";
  return {
    workspaceId: sha256(root.replace(/\\/g, "/").toLowerCase()),
    vcs: "none",
    dirty: false,
    capturedAt: runtime.now().toISOString(),
  };
}

function boundedLimits(params: UnitApproveResolveParams) {
  const requested = params.limits || {};
  const bounded = <K extends keyof typeof DEFAULT_UNIT_APPROVE_LIMITS>(key: K) => {
    const value = requested[key];
    const hard = DEFAULT_UNIT_APPROVE_LIMITS[key];
    return typeof value === "number" && Number.isFinite(value) && value > 0
      ? Math.min(Math.floor(value), hard)
      : hard;
  };
  return {
    maxSymbolCandidates: bounded("maxSymbolCandidates"),
    maxReferences: bounded("maxReferences"),
    maxImplementations: bounded("maxImplementations"),
    maxRelatedFiles: bounded("maxRelatedFiles"),
    maxExistingTests: bounded("maxExistingTests"),
    maxEvidencePerFile: bounded("maxEvidencePerFile"),
    maxFileBytes: bounded("maxFileBytes"),
    deadlineMs: bounded("deadlineMs"),
  };
}

async function withDeadline<T>(promise: Promise<T>, deadlineAt: number): Promise<T> {
  const remaining = deadlineAt - Date.now();
  if (remaining <= 0) throw new ResolverTimeoutError("Unit Approve resolver timed out");
  let timer: NodeJS.Timeout | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<T>((_, reject) => {
        timer = setTimeout(
          () => reject(new ResolverTimeoutError("Unit Approve resolver timed out")),
          remaining
        );
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function refusal(
  requestId: string,
  repository: RepositoryRevision,
  status: "STALE" | "NOT_READY" | "FEATURE_GAP" | "UNSUPPORTED",
  reasons: readonly UnitApproveReason[],
  retryable: boolean
): UnitApproveResolveResult {
  return {
    schema: UNIT_APPROVE_RESPONSE_SCHEMA,
    requestId,
    status,
    repository,
    reasons,
    retryable,
  };
}

export function createUnitApproveResolver(
  runtime: RepositoryRuntime,
  options?: {
    pickFields?: FieldBindingPicker;
    proposeSymbols?: SymbolProposer;
    /** Shares AI CLI answers across the TCs of one Approve batch. */
    memo?: ApproveCliMemo;
  }
) {
  return async function resolve(
    params: UnitApproveResolveParams
  ): Promise<UnitApproveResolveResult> {
    const requestId = typeof params?.requestId === "string" ? params.requestId : "";
    let repository = fallbackRepository(runtime);
    if (
      !params ||
      params.schema !== UNIT_APPROVE_REQUEST_SCHEMA ||
      !requestId ||
      !params.tcIr ||
      !params.testCaseRevision?.contentHash
    ) {
      return refusal(
        requestId,
        repository,
        "UNSUPPORTED",
        [{ code: "VALIDATION_FAILED", message: "Invalid Unit Approve v2 request." }],
        false
      );
    }
    if (!runtime.workspaceRoot()) {
      return refusal(
        requestId,
        repository,
        "UNSUPPORTED",
        [{ code: "WORKSPACE_MISMATCH", message: "No workspace folder is open." }],
        false
      );
    }

    const limits = boundedLimits(params);
    const deadlineAt = Date.now() + limits.deadlineMs;
    try {
      repository = await withDeadline(captureRepositoryRevision(runtime), deadlineAt);
      const staleReasons = compareRepositoryRevision(
        repository,
        params.expectedRepository
      );
      if (staleReasons.length) {
        return refusal(
          requestId,
          repository,
          "STALE",
          staleReasons,
          staleReasons.every((reason) => reason.retryable !== false)
        );
      }

      const revisionKey = repositoryMemoKey(repository);
      const proposeSymbols =
        options?.memo?.wrapProposer(options?.proposeSymbols, revisionKey) ??
        options?.proposeSymbols;
      const pickFields =
        options?.memo?.wrapPicker(options?.pickFields, revisionKey) ??
        options?.pickFields;

      const primaryResult = await withDeadline(
        resolvePrimary(params, runtime, limits, {
          proposeSymbols,
          remainingMs: Math.max(0, deadlineAt - Date.now()),
        }),
        deadlineAt
      );
      const primaryDoc = primaryResult.primary
        ? primaryResult.documents.get(primaryResult.primary.pathRel.toLowerCase())
        : undefined;
      if (
        primaryDoc &&
        !SUPPORTED_LANGUAGES.has(primaryDoc.language.toLowerCase())
      ) {
        return refusal(
          requestId,
          repository,
          "UNSUPPORTED",
          [
            {
              code: "UNSUPPORTED_LANGUAGE",
              message: `Language '${primaryDoc.language}' is not supported by Unit Approve v2.`,
              pathRel: primaryDoc.pathRel,
            },
          ],
          false
        );
      }

      const binding = primaryResult.primary
        ? await withDeadline(
            resolveBindings(
              params,
              primaryResult.primary,
              primaryResult.relatedPaths,
              runtime,
              limits,
              primaryResult.documents,
              pickFields,
              Math.max(0, deadlineAt - Date.now())
            ),
            deadlineAt
          )
        : null;
      const bindings = binding?.bindings || [];
      // Existing tests enrich codegen but never gate readiness, so they are the
      // first thing dropped when the deadline gets tight.
      const existingTests =
        primaryResult.primary && deadlineAt - Date.now() > 5_000
          ? await withDeadline(
              findExistingTests(primaryResult.primary, runtime, limits),
              deadlineAt
            )
          : [];
      const evidence = extractBehaviorEvidence(
        params,
        bindings,
        primaryResult.documents,
        limits.maxEvidencePerFile
      );
      const decision = buildDecision({
        params,
        repository,
        primary: primaryResult.primary,
        relatedPaths: primaryResult.relatedPaths,
        bindings,
        fieldBinding: binding?.diagnostics,
        evidence,
        existingTests,
        documents: primaryResult.documents,
        ambiguousPrimary: primaryResult.ambiguous,
        proposal: primaryResult.proposal,
        sourceDiscovery: primaryResult.sourceDiscovery,
        symbolIndex: primaryResult.symbolIndex,
        hintIgnored: primaryResult.hintIgnored,
      });
      if (decision.outcome === "READY") {
        return {
          schema: UNIT_APPROVE_RESPONSE_SCHEMA,
          requestId,
          status: "RESOLVED",
          decision,
        };
      }
      return {
        schema: UNIT_APPROVE_RESPONSE_SCHEMA,
        requestId,
        status: decision.outcome,
        repository,
        reasons: decision.refusalReasons,
        retryable: decision.refusalReasons.some((reason) => reason.retryable === true),
        decision,
      };
    } catch (error) {
      const timeout = error instanceof ResolverTimeoutError;
      return refusal(
        requestId,
        repository,
        timeout ? "NOT_READY" : "UNSUPPORTED",
        [
          {
            code: timeout ? "TIMEOUT" : "VALIDATION_FAILED",
            message: timeout
              ? "Repository intelligence exceeded its bounded deadline."
              : error instanceof Error
                ? error.message
                : "Repository intelligence failed.",
            retryable: timeout,
          },
        ],
        timeout
      );
    }
  };
}

export async function handleUnitApproveResolve(
  params: UnitApproveResolveParams
): Promise<UnitApproveResolveResult> {
  const { vscodeRepositoryRuntime } = await import("./vscodeRuntime");
  const { pickFieldBindingsWithCursor } = await import(
    "./cursorFieldBindingPicker"
  );
  const { proposeSymbolsWithCursor } = await import("./cursorSymbolProposer");
  return createUnitApproveResolver(vscodeRepositoryRuntime, {
    pickFields: pickFieldBindingsWithCursor,
    proposeSymbols: proposeSymbolsWithCursor,
    memo: sharedApproveCliMemo,
  })(params);
}
