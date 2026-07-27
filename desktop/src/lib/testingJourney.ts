/** Luồng: Requirement (Design) → Project root → Unit test (AI CLI) → Run */

import { requirementUrl, ROUTES, unitTestUrl } from "./productRoutes";

export type JourneyStepId =
  | "prepare"
  | "spec"
  | "gen-tc"
  | "review"
  | "code"
  | "run";

export type JourneyStep = {
  id: JourneyStepId;
  title: string;
  shortTitle: string;
  description: string;
  path: string;
};

export const JOURNEY_STEPS: JourneyStep[] = [
  {
    id: "prepare",
    title: "1. Chuẩn bị môi trường",
    shortTitle: "Chuẩn bị",
    description: "Chọn dự án và cấu hình AI (Ready).",
    path: ROUTES.projects,
  },
  {
    id: "spec",
    title: "2. Soạn requirement",
    shortTitle: "Requirement",
    description: "Tạo Requirement (upload tài liệu → phân tích).",
    path: requirementUrl({ tab: "home" }),
  },
  {
    id: "gen-tc",
    title: "3. Sinh test case (AI)",
    shortTitle: "Sinh TC",
    description: "Trong Requirement: tài liệu → phân tích → sinh TC.",
    path: ROUTES.requirement,
  },
  {
    id: "review",
    title: "4. Duyệt test case",
    shortTitle: "Duyệt",
    description: "Tab chờ duyệt trong Requirement.",
    path: requirementUrl({ tab: "review" }),
  },
  {
    id: "code",
    title: "5. Unit test",
    shortTitle: "Unit test",
    description:
      "Chọn TC Approved → gắn project root → AI CLI sinh unit → Staging → Verify → Apply. IDE semantic là tuỳ chọn (boost context).",
    path: ROUTES.unitTest,
  },
  {
    id: "run",
    title: "6. Chạy test",
    shortTitle: "Execution",
    description: "Chạy pytest / dotnet test / npm test và lưu kết quả.",
    path: ROUTES.run,
  },
];

export type JourneyStatus = {
  hasProject: boolean;
  aiReady: boolean;
  hasLocalPath: boolean;
  /** Desktop đã Connect IDE bridge (semantic source — tuỳ chọn). */
  ideConnected: boolean;
  /** IDE workspaceRoot vs Root Apply — true when aligned or not comparable. */
  rootsAligned: boolean;
  requirementCount: number;
  testCaseTotal: number;
  draftCount: number;
  approvedCount: number;
  prepareDone: boolean;
  specDone: boolean;
  genTcDone: boolean;
  reviewDone: boolean;
  codeReady: boolean;
  currentStep: JourneyStepId;
  nextStep: JourneyStepId;
  nextLabel: string;
  nextPath: string;
};

export function computeJourneyStatus(input: {
  hasProject: boolean;
  aiReady: boolean;
  hasLocalPath: boolean;
  ideConnected?: boolean;
  /** false when IDE root ≠ Root Apply; default true (no warning). */
  rootsAligned?: boolean;
  requirementCount: number;
  testCaseTotal: number;
  draftCount: number;
  approvedCount: number;
}): JourneyStatus {
  const ideConnected = Boolean(input.ideConnected);
  const rootsAligned = input.rootsAligned !== false;
  const prepareDone = input.hasProject && input.aiReady;
  const specDone = input.requirementCount > 0;
  const genTcDone = input.testCaseTotal > 0;
  const reviewDone = input.approvedCount > 0;
  /** Happy path: project root đủ để sinh (IDE không bắt buộc). */
  const codeReady = prepareDone && reviewDone && input.hasLocalPath;

  const flags: RecordJourneyFlags = {
    prepare: prepareDone,
    spec: specDone,
    "gen-tc": genTcDone,
    review: reviewDone,
    code: false,
    run: false,
  };

  let currentStep: JourneyStepId = "prepare";
  for (const s of JOURNEY_STEPS) {
    if (!flags[s.id] && s.id !== "code" && s.id !== "run") {
      currentStep = s.id;
      break;
    }
    if (s.id === "review" && reviewDone) {
      currentStep = "code";
      break;
    }
  }
  if (prepareDone && specDone && genTcDone && reviewDone) {
    currentStep = "code";
  }

  let nextStep = currentStep;
  let nextLabel = "Tiếp tục";
  let nextPath = JOURNEY_STEPS.find((s) => s.id === currentStep)?.path ?? "/";

  if (!prepareDone) {
    nextStep = "prepare";
    nextLabel = input.hasProject ? "Cấu hình AI" : "Chọn dự án";
    nextPath = input.hasProject ? ROUTES.settingsAi : ROUTES.projects;
  } else if (!specDone) {
    nextStep = "spec";
    nextLabel = "Requirement · tạo mới";
    nextPath = requirementUrl({ tab: "home" });
  } else if (!genTcDone) {
    nextStep = "gen-tc";
    nextLabel = "Requirement · sinh TC";
    nextPath = ROUTES.requirement;
  } else if (!reviewDone) {
    nextStep = "review";
    nextLabel = "Requirement · duyệt TC";
    nextPath = requirementUrl({ tab: "home" });
  } else if (!input.hasLocalPath) {
    nextStep = "code";
    nextLabel = "Gắn project root";
    nextPath = unitTestUrl();
  } else {
    nextStep = "code";
    nextLabel = "Sinh Unit";
    nextPath = unitTestUrl();
  }

  return {
    ...input,
    ideConnected,
    rootsAligned,
    prepareDone,
    specDone,
    genTcDone,
    reviewDone,
    codeReady,
    currentStep,
    nextStep,
    nextLabel,
    nextPath,
  };
}

type RecordJourneyFlags = Record<JourneyStepId, boolean>;

export function generateTcUrl(requirementId?: string, module?: string): string {
  const q = new URLSearchParams();
  if (requirementId) q.set("requirementId", requirementId);
  if (module) {
    q.set("module", module);
    q.set("scope", "module");
  }
  const s = q.toString();
  return s ? `${ROUTES.generateTc}?${s}` : ROUTES.generateTc;
}

export function specReviewUrl(module?: string, _requirementId?: string): string {
  return requirementUrl({
    tab: "review",
    module,
  });
}

/** Deep-link sang module Unit test (Automate). */
export function workspaceUrl(opts?: {
  artifact?: "unit" | "api";
  mode?: "module" | "single";
  module?: string;
  testCaseId?: string;
}): string {
  return unitTestUrl({
    mode: opts?.mode,
    module: opts?.module,
    testCaseId: opts?.testCaseId,
  });
}
