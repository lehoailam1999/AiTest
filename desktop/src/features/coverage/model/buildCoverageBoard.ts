import type { Execution, Requirement, TestCase, WorkspaceRunAudit } from "../../../api/types";
import { workspaceUrl } from "../../../lib/testingJourney";
import { ROUTES } from "../../../lib/productRoutes";
import { functionMergeKey, normalizeFunctionLabel } from "../../../lib/normalizeFunctionLabel";
import {
  UNMODULED,
  type CodeCellStatus,
  type CoverageBoard,
  type CoverageModuleRow,
  type CoverageNextAction,
  type RunCellStatus,
  type SpecCellStatus,
  type TcCellStatus,
} from "./coverageTypes";

export function normalizeModuleKey(raw: string | null | undefined): string {
  const t = normalizeFunctionLabel(raw);
  if (!t) return UNMODULED;
  return t;
}

/** Case-insensitive merge key (+ và space coi là một) */
export function moduleMergeKey(display: string): string {
  return functionMergeKey(display, UNMODULED);
}

type Bucket = {
  displayName: string;
  requirementIds: Set<string>;
  tcs: TestCase[];
  codeApplied: number;
  codeStaged: number;
  codeVerified: number;
};

function ensureBucket(map: Map<string, Bucket>, displayName: string): Bucket {
  const mk = moduleMergeKey(displayName);
  let b = map.get(mk);
  if (!b) {
    b = {
      displayName,
      requirementIds: new Set(),
      tcs: [],
      codeApplied: 0,
      codeStaged: 0,
      codeVerified: 0,
    };
    map.set(mk, b);
  } else if (b.displayName === UNMODULED && displayName !== UNMODULED) {
    b.displayName = displayName;
  }
  return b;
}

function tcStatus(total: number, approved: number, draft: number): TcCellStatus {
  if (total === 0) return "none";
  if (approved === 0) return "draft_heavy";
  if (draft > 0 || approved < total) return "partial";
  return "ready";
}

function codeStatus(
  approved: number,
  applied: number,
  staged: number,
  verified: number
): CodeCellStatus {
  if (applied >= approved && approved >= 1) return "applied";
  if (applied > 0 && applied < approved) return "applied_partial";
  if (verified > 0) return "verified";
  if (staged > 0) return "staged";
  return "none";
}

function projectRunStatus(execs: Execution[]): RunCellStatus {
  if (!execs.length) return "none";
  const latest = execs[0];
  const s = (latest.status || "").toLowerCase();
  if (s === "passed" || s === "pass" || s === "success") return "passing";
  if (s === "failed" || s === "fail" || s === "error") return "failing";
  return "none";
}

/** F0.3 CTA priority */
export function resolveNextAction(row: {
  specStatus: SpecCellStatus;
  tcTotal: number;
  tcApproved: number;
  tcDraft: number;
  codeStatus: CodeCellStatus;
  runStatus: RunCellStatus;
  requirementIds: string[];
  displayName: string;
  hasLocalPath: boolean;
}): { action: CoverageNextAction; label: string; path: string } {
  const mod = row.displayName === UNMODULED ? undefined : row.displayName;

  if (row.specStatus === "missing") {
    return {
      action: "create_spec",
      label: "Mở Studio",
      path: ROUTES.requirement,
    };
  }
  if (row.tcTotal === 0) {
    return {
      action: "generate_tc",
      label: "Sinh TC (Studio)",
      path: ROUTES.requirement,
    };
  }
  if (row.tcDraft > 0) {
    const q = new URLSearchParams();
    q.set("tab", "home");
    if (mod) q.set("module", mod);
    return {
      action: "review_tc",
      label: "Duyệt TC",
      path: `/requirement?${q.toString()}`,
    };
  }
  if (row.tcApproved >= 1 && row.codeStatus !== "applied") {
    if (!row.hasLocalPath) {
      return {
        action: "generate_code",
        label: "Connect IDE",
        path: ROUTES.unitTest,
      };
    }
    return {
      action: "generate_code",
      label: "Unit test",
      path: workspaceUrl({ mode: "module", module: mod, artifact: "unit" }),
    };
  }
  if (
    row.codeStatus === "applied" &&
    (row.runStatus === "none" || row.runStatus === "failing")
  ) {
    return { action: "run_tests", label: "Chạy test", path: "/run" };
  }
  if (row.codeStatus === "applied" && row.runStatus === "passing") {
    return { action: "reports", label: "Xem báo cáo", path: "/reports" };
  }
  return { action: "none", label: "—", path: "/requirement" };
}

export function buildCoverageBoard(input: {
  requirements: Requirement[];
  /** topic titles per requirement id */
  topicsByReqId: Record<string, string[]>;
  testCases: TestCase[];
  workspaceRuns: WorkspaceRunAudit[];
  executions: Execution[];
  hasLocalPath: boolean;
}): CoverageBoard {
  const map = new Map<string, Bucket>();

  for (const req of input.requirements) {
    const topics = input.topicsByReqId[req.id] ?? [];
    const fromEmbedded = (req.topics ?? []).map((t) => t.title);
    const names = [...topics, ...fromEmbedded].map(normalizeModuleKey);
    const unique = names.length ? [...new Set(names.map(moduleMergeKey))] : [moduleMergeKey(UNMODULED)];
    for (const mk of unique) {
      const display =
        names.find((n) => moduleMergeKey(n) === mk) ??
        (mk === moduleMergeKey(UNMODULED) ? UNMODULED : mk);
      const b = ensureBucket(map, display);
      b.requirementIds.add(req.id);
    }
    // Spec without topics still counts as unmoduled coverage
    if (names.length === 0) {
      ensureBucket(map, UNMODULED).requirementIds.add(req.id);
    }
  }

  for (const tc of input.testCases) {
    const display = normalizeModuleKey(tc.module);
    const b = ensureBucket(map, display);
    b.tcs.push(tc);
  }

  for (const run of input.workspaceRuns) {
    const display = normalizeModuleKey(run.module);
    const b = ensureBucket(map, display);
    const st = (run.status || "").toLowerCase();
    if (st === "applied") b.codeApplied += 1;
    else if (st === "pass" || st === "verified") b.codeVerified += 1;
    else if (st === "generated" || st === "ok" || st === "running") b.codeStaged += 1;
  }

  const runStatus = projectRunStatus(input.executions);
  const runPass = input.executions.filter((e) =>
    /pass/i.test(e.status || "")
  ).length;
  const runFail = input.executions.filter((e) =>
    /fail|error/i.test(e.status || "")
  ).length;

  const modules: CoverageModuleRow[] = [...map.values()]
    .map((b) => {
      const tcTotal = b.tcs.length;
      const tcApproved = b.tcs.filter((t) => t.reviewStatus === "Approved").length;
      const tcDraft = b.tcs.filter(
        (t) => t.reviewStatus === "Draft" || t.reviewStatus === "InReview"
      ).length;
      const specStatus: SpecCellStatus =
        b.requirementIds.size > 0 ? "ready" : "missing";
      const tcs = tcStatus(tcTotal, tcApproved, tcDraft);
      // If no approved TCs, don't treat applied>=approved
      const codeFinal: CodeCellStatus =
        tcApproved === 0
          ? b.codeApplied > 0
            ? "applied_partial"
            : b.codeVerified > 0
              ? "verified"
              : b.codeStaged > 0
                ? "staged"
                : "none"
          : codeStatus(tcApproved, b.codeApplied, b.codeStaged, b.codeVerified);

      const next = resolveNextAction({
        specStatus,
        tcTotal,
        tcApproved,
        tcDraft,
        codeStatus: codeFinal,
        runStatus,
        requirementIds: [...b.requirementIds],
        displayName: b.displayName,
        hasLocalPath: input.hasLocalPath,
      });

      return {
        key: moduleMergeKey(b.displayName),
        displayName: b.displayName,
        specStatus,
        requirementIds: [...b.requirementIds],
        tcTotal,
        tcApproved,
        tcDraft,
        tcStatus: tcs,
        codeApplied: b.codeApplied,
        codeStaged: b.codeStaged + b.codeVerified,
        codeStatus: codeFinal,
        runPass,
        runFail,
        runStatus,
        nextAction: next.action,
        nextLabel: next.label,
        nextPath: next.path,
      };
    })
    .sort((a, b) => {
      if (a.displayName === UNMODULED) return 1;
      if (b.displayName === UNMODULED) return -1;
      return a.displayName.localeCompare(b.displayName, "vi");
    });

  // Spec-only project with zero modules from empty data
  if (modules.length === 0 && input.requirements.length === 0) {
    return {
      modules: [],
      totals: {
        moduleCount: 0,
        gapCount: 0,
        requirementCount: 0,
        tcTotal: 0,
        tcApproved: 0,
      },
      projectRunStatus: runStatus,
    };
  }

  const gapCount = modules.filter((m) => m.nextAction !== "none" && m.nextAction !== "reports")
    .length;

  return {
    modules,
    totals: {
      moduleCount: modules.length,
      gapCount,
      requirementCount: input.requirements.length,
      tcTotal: input.testCases.length,
      tcApproved: input.testCases.filter((t) => t.reviewStatus === "Approved").length,
    },
    projectRunStatus: runStatus,
  };
}
