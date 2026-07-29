/** Best-effort sync E2E WorkspaceRun + verify summary → PostgreSQL (EX2). */

import { audit } from "../../api";

export type E2eAuditStage = {
  stage: string;
  success: boolean;
  exitCode?: number;
  command?: string;
};

export function syncE2eWorkspaceRun(opts: {
  projectId: string;
  localRunId: string;
  testCaseId?: string;
  module?: string | null;
  status: string;
  provider?: string | null;
  contextSource?: string;
}): void {
  void audit
    .upsertWorkspaceRun({
      projectId: opts.projectId,
      localRunId: opts.localRunId,
      testType: "e2e",
      testCaseId: opts.testCaseId,
      module: opts.module ?? undefined,
      status: opts.status,
      provider: opts.provider ?? undefined,
      contextSource: opts.contextSource ?? "e2e-console",
    })
    .catch(() => undefined);
}

export function syncE2eVerifyReport(opts: {
  projectId: string;
  localRunId: string;
  testCaseId?: string;
  module?: string | null;
  overallPass: boolean;
  stages: E2eAuditStage[];
  /** Reused as coverageSync slot — e.g. artifactCount / reportId */
  artifactMeta?: Record<string, unknown>;
}): void {
  const payload: Record<string, unknown> = {
    projectId: opts.projectId,
    localRunId: opts.localRunId,
    testType: "e2e",
    testCaseId: opts.testCaseId,
    module: opts.module ?? undefined,
    overallPass: opts.overallPass,
    stages: opts.stages,
  };
  if (opts.artifactMeta) {
    payload.coverageSync = opts.artifactMeta;
  }
  void audit.postVerifyReport(payload).catch(() => undefined);
}

/**
 * EX2.3 — campaign tối thiểu 1 module (khi TC có module).
 * Best-effort; không block job.
 */
export function syncE2eModuleCampaign(opts: {
  projectId: string;
  module: string;
  testCaseId: string;
  localRunId: string;
  status: "ok" | "fail";
  error?: string;
}): void {
  syncE2eModuleBatchCampaign({
    projectId: opts.projectId,
    module: opts.module,
    tasks: [
      {
        testCaseId: opts.testCaseId,
        localRunId: opts.localRunId,
        status: opts.status,
        error: opts.error,
      },
    ],
  });
}

/** EX4.1 — one campaign for a module batch (multiple TC tasks). */
export function syncE2eModuleBatchCampaign(opts: {
  projectId: string;
  module: string;
  tasks: Array<{
    testCaseId: string;
    localRunId: string;
    status: "ok" | "fail";
    error?: string;
  }>;
}): void {
  if (!opts.tasks.length) return;
  void (async () => {
    try {
      const camp = await audit.createCampaign({
        projectId: opts.projectId,
        kind: "e2e",
        scopeLevel: "module",
        scopeLabel: opts.module,
      });
      await audit.addCampaignTasks(
        camp.id,
        opts.tasks.map((t, i) => ({
          testCaseId: t.testCaseId,
          localRunId: t.localRunId,
          status: t.status,
          error: t.error,
          sortOrder: i,
        }))
      );
      const anyFail = opts.tasks.some((t) => t.status === "fail");
      await audit.finishCampaign(camp.id, anyFail ? "Failed" : "Completed");
    } catch {
      /* ignore */
    }
  })();
}
