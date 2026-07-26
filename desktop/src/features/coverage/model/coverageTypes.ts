/** Tiến độ kiểm thử — Yêu cầu → Chức năng → Test case (F0.3) */

export type SpecCellStatus = "missing" | "ready";
export type TcCellStatus = "none" | "draft_heavy" | "partial" | "ready";
export type CodeCellStatus =
  | "none"
  | "staged"
  | "verified"
  | "applied_partial"
  | "applied";
export type RunCellStatus = "none" | "failing" | "passing";

export type CoverageNextAction =
  | "create_spec"
  | "generate_tc"
  | "review_tc"
  | "generate_code"
  | "run_tests"
  | "reports"
  | "none";

export type CoverageModuleRow = {
  key: string;
  displayName: string;
  /** Chức năng (topic / module TC) */
  functionName?: string;
  rowKind?: "requirement" | "function";
  specStatus: SpecCellStatus;
  requirementIds: string[];
  requirementId?: string | null;
  tcTotal: number;
  tcApproved: number;
  tcDraft: number;
  tcStatus: TcCellStatus;
  codeApplied: number;
  codeStaged: number;
  codeStatus: CodeCellStatus;
  runPass: number;
  runFail: number;
  runStatus: RunCellStatus;
  nextAction: CoverageNextAction;
  nextLabel: string;
  nextPath: string;
  functionCount?: number;
  children?: CoverageModuleRow[];
  functions?: CoverageModuleRow[];
};

export type CoverageRequirementGroup = {
  id: string;
  title: string;
  key: string;
  rowKind: "requirement";
  displayName: string;
  functionCount: number;
  tcTotal: number;
  tcApproved: number;
  tcDraft: number;
  tcStatus: TcCellStatus;
  specStatus: SpecCellStatus;
  requirementIds: string[];
  codeStatus: CodeCellStatus;
  codeApplied: number;
  codeStaged: number;
  runStatus: RunCellStatus;
  runPass: number;
  runFail: number;
  nextAction: CoverageNextAction;
  nextLabel: string;
  nextPath: string;
  functions: CoverageModuleRow[];
  children: CoverageModuleRow[];
};

export type CoverageBoard = {
  modules: CoverageModuleRow[];
  requirements?: CoverageRequirementGroup[];
  totals: {
    moduleCount: number;
    gapCount: number;
    requirementCount: number;
    tcTotal: number;
    tcApproved: number;
    modules?: number;
    gaps?: number;
    readyModules?: number;
    functionCount?: number;
  };
  projectRunStatus: RunCellStatus;
  projectId?: string;
  pageNumber?: number;
  pageSize?: number;
  totalModules?: number;
  totalRequirements?: number;
  hasPrevious?: boolean;
  hasNext?: boolean;
  pendingCount?: number;
  nextProjectAction?: {
    action: string;
    label: string;
    path: string;
  } | null;
};

/** Chức năng chưa đặt tên (topic/module trống) */
export const UNMODULED = "(chưa gán chức năng)";
