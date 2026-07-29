/** E2E Job console — phase state (EX1). */

export const E2E_PHASES = [
  "inspect",
  "generate",
  "headless",
  "heal",
  "artifacts",
  "apply",
] as const;

export type E2ePhaseId = (typeof E2E_PHASES)[number];

export type E2ePhaseStatus = "wait" | "process" | "finish" | "error" | "skip";

export type E2ePhaseState = {
  status: E2ePhaseStatus;
  durationMs?: number;
  log: string;
};

export type E2eArtifactItem = {
  kind: string;
  path: string;
  sizeBytes?: number | null;
};

export type E2eJobRunState = {
  phases: Record<E2ePhaseId, E2ePhaseState>;
  current: E2ePhaseId | null;
  elementCount: number | null;
  routeCount: number | null;
  inspectEmpty: boolean;
  /** url:playwright-node | url:http | … */
  inspectSource: string;
  healAttempts: number;
  /** attempts - 1 when PASS after repair */
  healCount: number;
  jobPassed: boolean | null;
  artifacts: E2eArtifactItem[];
  reportId: string | null;
  artifactCount: number;
};

export const E2E_PHASE_LABEL: Record<E2ePhaseId, string> = {
  inspect: "Quét DOM",
  generate: "Sinh code",
  headless: "Chạy test",
  heal: "Tự sửa",
  artifacts: "Kết quả",
  apply: "Áp dụng",
};

export function emptyPhaseState(): E2ePhaseState {
  return { status: "wait", log: "" };
}

export function initialE2eJobRunState(): E2eJobRunState {
  return {
    phases: {
      inspect: emptyPhaseState(),
      generate: emptyPhaseState(),
      headless: emptyPhaseState(),
      heal: emptyPhaseState(),
      artifacts: emptyPhaseState(),
      apply: emptyPhaseState(),
    },
    current: null,
    elementCount: null,
    routeCount: null,
    inspectEmpty: false,
    inspectSource: "",
    healAttempts: 0,
    healCount: 0,
    jobPassed: null,
    artifacts: [],
    reportId: null,
    artifactCount: 0,
  };
}

export function appendPhaseLog(
  prev: E2eJobRunState,
  id: E2ePhaseId,
  line: string
): E2eJobRunState {
  const cur = prev.phases[id];
  return {
    ...prev,
    phases: {
      ...prev.phases,
      [id]: { ...cur, log: cur.log + line },
    },
  };
}

export function setPhaseRunning(
  prev: E2eJobRunState,
  id: E2ePhaseId
): E2eJobRunState {
  return {
    ...prev,
    current: id,
    phases: {
      ...prev.phases,
      [id]: { ...prev.phases[id], status: "process" },
    },
  };
}

export function finishPhase(
  prev: E2eJobRunState,
  id: E2ePhaseId,
  opts: {
    status: "finish" | "error" | "skip";
    durationMs: number;
    logExtra?: string;
  }
): E2eJobRunState {
  const cur = prev.phases[id];
  return {
    ...prev,
    phases: {
      ...prev.phases,
      [id]: {
        ...cur,
        status: opts.status,
        durationMs: opts.durationMs,
        log: opts.logExtra ? cur.log + opts.logExtra : cur.log,
      },
    },
  };
}

/** Soft probe — no-cors: opaque = có phản hồi mạng. */
export async function probeTargetUrl(
  url: string,
  timeoutMs = 2500
): Promise<"ok" | "fail" | "empty"> {
  const u = url.trim();
  if (!u) return "empty";
  try {
    const ctrl = new AbortController();
    const t = window.setTimeout(() => ctrl.abort(), timeoutMs);
    await fetch(u, {
      method: "GET",
      mode: "no-cors",
      cache: "no-store",
      signal: ctrl.signal,
    });
    window.clearTimeout(t);
    return "ok";
  } catch {
    return "fail";
  }
}
