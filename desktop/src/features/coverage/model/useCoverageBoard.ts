import { useMemo } from "react";
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
  cases: (projectId: string) => [...coverageBoardKeys.all, projectId, "all-tc"] as const,
  /** @deprecated use cases */
  pending: (projectId: string) => [...coverageBoardKeys.all, projectId, "all-tc"] as const,
};

type Options = {
  page?: number;
  pageSize?: number;
  module?: string;
  /** When true, load all TCs for Review queue (default true) */
  includePendingCases?: boolean;
};

/**
 * F6 — Coverage Board from GET /projects/{id}/coverage-board (React Query).
 * Soft-gate: passes hasLocalPath so CTA "Sinh ma" → Workspace when unbound.
 */
export function useCoverageBoard(opts: Options = {}) {
  const { project } = useProject();
  const queryClient = useQueryClient();
  const page = opts.page ?? 1;
  const pageSize = opts.pageSize ?? 50;
  const module = opts.module;
  const includeCases = opts.includePendingCases ?? true;

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

  const casesQuery = useQuery({
    queryKey: project ? coverageBoardKeys.cases(project.id) : ["coverage-board", "cases-none"],
    queryFn: async (): Promise<TestCase[]> => {
      const pageRes = await testcases.list({ projectId: project!.id }, 1, 500);
      return pageRes.items;
    },
    enabled: Boolean(project) && includeCases,
  });

  const board: CoverageBoard | null = boardQuery.data ?? null;
  const allCases = casesQuery.data ?? [];
  const pendingCases = useMemo(
    () => allCases.filter((c) => isTcPendingReview(c.reviewStatus)),
    [allCases]
  );
  const pendingCount = board?.pendingCount ?? pendingCases.length;

  function invalidate() {
    if (!project) return;
    void queryClient.invalidateQueries({ queryKey: coverageBoardKeys.all });
  }

  return {
    project,
    board,
    /** All project test cases (every review status) */
    allCases,
    pendingCases,
    pendingCount,
    loading: boardQuery.isFetching || (includeCases && casesQuery.isFetching),
    error:
      (boardQuery.error instanceof Error ? boardQuery.error.message : null) ||
      (casesQuery.error instanceof Error ? casesQuery.error.message : null),
    refresh: () => {
      void boardQuery.refetch();
      if (includeCases) void casesQuery.refetch();
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
