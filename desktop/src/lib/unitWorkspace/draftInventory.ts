/**
 * Draft inventory — how much work a Gen-OK row still carries after the user
 * edited or deleted generated files in the Tool draft.
 *
 * Row status alone records "Generate succeeded once", so counting it as work to
 * verify keeps offering a run for a test case whose draft is already empty.
 */
import type { UnitWorkspaceManifest } from "./types";

export type DraftEntryCounts = Readonly<Record<string, number>>;

type DraftJob = {
  key: string;
  manifest: Pick<UnitWorkspaceManifest, "files"> | null;
};

type DraftRow = {
  key: string;
  status: "ok" | "fail";
  workspaceRunId?: string;
};

/**
 * rowKey → draft entries still pending. Deletions count as work because
 * Update must remove those files from `AItest/`.
 */
export function draftEntryCounts(jobs: readonly DraftJob[]): DraftEntryCounts {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    if (!job.manifest) continue;
    counts[job.key] = job.manifest.files.length;
  }
  return counts;
}

/** rowKey → draft entries that a test run can execute (deletions excluded). */
export function runnableDraftCounts(jobs: readonly DraftJob[]): DraftEntryCounts {
  const counts: Record<string, number> = {};
  for (const job of jobs) {
    if (!job.manifest) continue;
    counts[job.key] = job.manifest.files.filter((file) => file.op !== "delete").length;
  }
  return counts;
}

/**
 * A missing count means the manifest was never loaded, which must not hide the
 * row: unknown is treated as pending so Verify/Update stay reachable.
 */
export function hasPendingDraft(rowKey: string, counts?: DraftEntryCounts): boolean {
  const count = counts?.[rowKey];
  return count === undefined || count > 0;
}

/** Gen-OK rows that still hold draft entries — the real Verify/Update work. */
export function rowsWithPendingDraft<T extends DraftRow>(
  rows: readonly T[],
  counts?: DraftEntryCounts
): T[] {
  return rows.filter(
    (row) =>
      row.status === "ok" &&
      Boolean(row.workspaceRunId) &&
      hasPendingDraft(row.key, counts)
  );
}

/** Gen-OK rows whose draft the user emptied — surfaced so they are not silent. */
export function emptiedDraftRowCount<T extends DraftRow>(
  rows: readonly T[],
  counts?: DraftEntryCounts
): number {
  return rows.filter(
    (row) =>
      row.status === "ok" &&
      Boolean(row.workspaceRunId) &&
      !hasPendingDraft(row.key, counts)
  ).length;
}
