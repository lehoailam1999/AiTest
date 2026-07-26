import { useQuery, useQueryClient } from "@tanstack/react-query";
import { coverageBoard, testcases } from "../../../api";
import type { TestCase } from "../../../api/types";
import { useProject } from "../../../state/ProjectContext";
import { workspace } from "../../../workspace";
import type { CoverageBoard } from "./coverageTypes";
import { isTcPendingReview } from "../../../i18n/labels";

export const coverageBoardKeys = {
  all: ["coverage-board"] as const,
  project: (projectId: string, page: number, pageSize: number, module?: string) =>
    [...coverageBoardKeys.all, projectId, page, pageSize, module ?? ""] as const,
  pending: (projectId: string) =>
    [...coverageBoardKeys.all, projectId, "pending-tc"] as const,
};

type Options = {
  page?: number;
  pageSize?: number;
  module?: string;
  /** When true, also load draft/in-review TCs for Review queue */
  includePendingCases?: boolean;
};

/**
 * F6 — Coverage Board from GET /projects/{id}/coverage-board (React Query).
 * Soft-gate: passes hasLocalPath so CTA «Sinh mã» → Workspace when unbound.
 */
export function useCoverageBoard(opts: Options = {}) {
  const { project } = useProject();
  const queryClient = useQueryClient();
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const module = opts.module;
  const includePending = opts.includePendingCases ?? true;

  const hasLocalPath = Boolean(project && workspace.getLocalPath(project.id));

  const boardQuery = useQuery({
    queryKey: project
      ? [...coverageBoardKeys.project(project.id, page, pageSize, module), hasLocalPath]
      : ["coverage-board", "none"],
    queryFn: () =>
      coverageBoard.get(project!.id, {
        page,
        pageSize,
        module,
        hasLocalPath,
      }),
    enabled: Boolean(project),
  });

  const pendingQuery = useQuery({
    queryKey: project ? coverageBoardKeys.pending(project.id) : ["coverage-board", "pending-none"],
    queryFn: async (): Promise<TestCase[]> => {
      const pageRes = await testcases.list({ projectId: project!.id }, 1, 200);
      return pageRes.items.filter((c) => isTcPendingReview(c.reviewStatus));
    },
    enabled: Boolean(project) && includePending,
  });

  const board: CoverageBoard | null = boardQuery.data ?? null;
  const pendingCases = pendingQuery.data ?? [];
  const pendingCount = board?.pendingCount ?? pendingCases.length;

  function invalidate() {
    if (!project) return;
    void queryClient.invalidateQueries({ queryKey: coverageBoardKeys.all });
  }

  return {
    project,
    board,
    pendingCases,
    pendingCount,
    loading: boardQuery.isFetching || (includePending && pendingQuery.isFetching),
    error:
      (boardQuery.error instanceof Error ? boardQuery.error.message : null) ||
      (pendingQuery.error instanceof Error ? pendingQuery.error.message : null),
    refresh: () => {
      void boardQuery.refetch();
      if (includePending) void pendingQuery.refetch();
    },
    invalidate,
    hasLocalPath,
    page: board?.pageNumber ?? page,
    pageSize: board?.pageSize ?? pageSize,
    totalModules: board?.totalModules ?? board?.modules.length ?? 0,
    hasNext: board?.hasNext ?? false,
    hasPrevious: board?.hasPrevious ?? false,
  };
}
