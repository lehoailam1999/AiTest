import { jobs, requirements, testcases, audit } from "../../../api";
import type { CoverageModuleRow } from "./coverageTypes";
import { UNMODULED } from "./coverageTypes";
import { normalizeFunctionLabel } from "../../../lib/normalizeFunctionLabel";
import { topicScopeForJob } from "../../../components/RequirementTopicsPanel";
import { waitForJob } from "../../../lib/waitForJob";
import type { BatchRunControl } from "../../../lib/batchRunControl";

export type TcGapTarget = {
  moduleDisplay: string;
  requirementId: string;
  requirementTitle: string;
  topicId?: string;
  topicTitle?: string;
};

/** Modules/chức năng with Spec ready and zero TCs (F0 / F3 policy). */
export function listTcGaps(modules: CoverageModuleRow[]): CoverageModuleRow[] {
  return modules.filter(
    (m) =>
      m.rowKind !== "requirement" &&
      Boolean(m.functionName) &&
      m.specStatus === "ready" &&
      m.tcTotal === 0
  );
}

/** Chức năng có Approved TC và code chưa fully applied. */
export function listCodeGaps(modules: CoverageModuleRow[]): CoverageModuleRow[] {
  return modules.filter(
    (m) =>
      m.rowKind !== "requirement" &&
      m.tcApproved >= 1 &&
      m.codeStatus !== "applied"
  );
}

/** Expand board rows → concrete job targets (req × optional topic). */
export async function expandTcGapTargets(
  gaps: CoverageModuleRow[]
): Promise<TcGapTarget[]> {
  const out: TcGapTarget[] = [];
  for (const row of gaps) {
    const reqIds = row.requirementIds.length ? row.requirementIds : [];
    for (const requirementId of reqIds) {
      let requirementTitle = requirementId.slice(0, 8);
      try {
        const detail = await requirements.get(requirementId);
        requirementTitle = detail.title;
        const topics = detail.topics?.length
          ? detail.topics
          : (await requirements.getTopics(requirementId)).topics;
        const match =
          row.displayName !== UNMODULED
            ? topics.find(
                (t) =>
                  normalizeFunctionLabel(t.title).toLowerCase() ===
                  normalizeFunctionLabel(row.displayName).toLowerCase()
              )
            : undefined;
        if (match) {
          out.push({
            moduleDisplay: row.displayName,
            requirementId,
            requirementTitle,
            topicId: match.id,
            topicTitle: match.title,
          });
        } else if (row.displayName === UNMODULED || topics.length === 0) {
          out.push({
            moduleDisplay: row.displayName,
            requirementId,
            requirementTitle,
          });
        } else {
          // Spec module row from topic name but get by req — still enqueue with topic match miss → system job once
          out.push({
            moduleDisplay: row.displayName,
            requirementId,
            requirementTitle,
          });
        }
      } catch {
        out.push({
          moduleDisplay: row.displayName,
          requirementId,
          requirementTitle,
        });
      }
    }
  }
  // Dedupe same req+topic
  const seen = new Set<string>();
  return out.filter((t) => {
    const k = `${t.requirementId}::${t.topicId ?? ""}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export type GapFillProgress = {
  current: number;
  total: number;
  label: string;
};

/**
 * Sequential TC gap-fill campaign (F3).
 * Creates audit campaign kind=tc, one job per target, records tasks.
 */
export async function runTcGapFillCampaign(opts: {
  projectId: string;
  targets: TcGapTarget[];
  onProgress: (p: GapFillProgress) => void;
  /** Cooperative pause between jobs (optional). */
  control?: BatchRunControl;
}): Promise<{ ok: number; fail: number; campaignId?: string }> {
  const { projectId, targets, onProgress, control } = opts;
  if (targets.length === 0) return { ok: 0, fail: 0 };

  let campaignId: string | undefined;
  try {
    const camp = await audit.createCampaign({
      projectId,
      kind: "tc",
      scopeLevel: "project",
      scopeLabel: `gap-fill TC · ${targets.length} job`,
    });
    campaignId = camp.id;
  } catch {
    campaignId = undefined;
  }

  let ok = 0;
  let fail = 0;
  control?.start();

  try {
    for (let i = 0; i < targets.length; i++) {
      await control?.waitIfPaused();
      const t = targets[i];
      onProgress({
        current: i + 1,
        total: targets.length,
        label: `${t.requirementTitle}${t.topicTitle ? ` · ${t.topicTitle}` : ""}`,
      });
      try {
        let topicScope: Record<string, unknown> | undefined;
        if (t.topicId) {
          const { topics } = await requirements.getTopics(t.requirementId);
          const topic = topics.find((x) => x.id === t.topicId);
          if (topic) {
            topicScope = topicScopeForJob(topic) as unknown as Record<string, unknown>;
          }
        }
        const job = await jobs.create({
          projectId,
          sourceId: t.requirementId,
          mode: "append",
          topicScope,
        });
        const done = await waitForJob(job.id);
        if (done.status === "Failed") {
          fail += 1;
          if (campaignId) {
            void audit.addCampaignTasks(campaignId, [
              {
                status: "fail",
                error: done.error ?? "Job Failed",
                sortOrder: i,
              },
            ]);
          }
        } else {
          const count = (await testcases.list({ jobId: job.id }, 1, 200)).items.length;
          ok += 1;
          if (campaignId) {
            void audit.addCampaignTasks(campaignId, [
              {
                status: "ok",
                error: count ? `+${count} TC` : undefined,
                sortOrder: i,
              },
            ]);
          }
        }
      } catch (e) {
        fail += 1;
        if (campaignId) {
          void audit.addCampaignTasks(campaignId, [
            {
              status: "fail",
              error: e instanceof Error ? e.message : "error",
              sortOrder: i,
            },
          ]);
        }
      }
    }

    if (campaignId) {
      void audit.finishCampaign(campaignId, fail > 0 ? (ok > 0 ? "Partial" : "Failed") : "Completed");
    }

    return { ok, fail, campaignId };
  } finally {
    control?.reset();
  }
}
