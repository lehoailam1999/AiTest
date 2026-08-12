/**

 * Phase U0 + P3 — Unit job metrics (localStorage).

 * No PII / file contents — only sizes, timings, counts.

 */



export type UnitContextSource =

  | "local-fs"

  | "ide"

  | "agent-ide"

  | "ide-semantic"

  | "implementation-plan"

  | "unknown";



export type UnitJobMetricEvent = {

  at: string;

  projectId: string;

  contextSource: UnitContextSource;

  runnerUsed?: string | null;

  ideConnected?: boolean;

  jobId?: string | null;

  /**
   * ide-extension = Unit code Gen (only UI path).
   * api-legacy = Repair / historical Gen metrics (not offered in Unit Gen UI).
   */
  via?: "ide-extension" | "api-legacy" | null;

  /** Total wall time for gen job (Desktop) */

  durationMs?: number | null;

  failReason?: string | null;

  commandId?: string | null;

  ok?: boolean;

  /** Phase 3 — observability */

  contextSize?: number | null;

  retrievedFiles?: number | null;

  promptTokens?: number | null;

  promptChars?: number | null;

  cliTimeMs?: number | null;

  verifyTimeMs?: number | null;

  applyTimeMs?: number | null;

};



export type UnitJobMetricsSummary = {

  total: number;

  bySource: Record<string, number>;

  localFsPct: number;

  idePct: number;

  /** Jobs that did not need IDE connected (local-fs or unknown without ide flag) */

  noIdePct: number;

  avgCliTimeMs?: number | null;

  avgVerifyTimeMs?: number | null;

  avgApplyTimeMs?: number | null;

  lastAt?: string | null;

};



const STORAGE_KEY = "aitest.unitJobMetrics.v1";

const MAX_EVENTS = 200;



function normalizeSource(raw?: string | null): UnitContextSource {

  const s = (raw || "").toLowerCase().trim();

  if (s === "local-fs" || s === "local_fs" || s === "fs") return "local-fs";

  if (s === "agent-ide" || s === "agent_ide") return "agent-ide";

  if (s === "ide-semantic" || s === "ide_semantic") return "ide-semantic";

  if (s === "implementation-plan" || s === "implementation_plan") {

    return "implementation-plan";

  }

  if (s === "ide-extension" || s === "ide_extension") return "ide";

  if (s === "ide" || s === "code-index") return "ide";

  return "unknown";

}



function isIdeSource(source: UnitContextSource): boolean {

  return (

    source === "ide" ||

    source === "agent-ide" ||

    source === "ide-semantic" ||

    source === "implementation-plan"

  );

}



function readAll(): UnitJobMetricEvent[] {

  try {

    const raw = localStorage.getItem(STORAGE_KEY);

    if (!raw) return [];

    const parsed = JSON.parse(raw) as unknown;

    if (!Array.isArray(parsed)) return [];

    return parsed.filter(

      (e): e is UnitJobMetricEvent =>

        Boolean(e) &&

        typeof e === "object" &&

        typeof (e as UnitJobMetricEvent).projectId === "string" &&

        typeof (e as UnitJobMetricEvent).at === "string"

    );

  } catch {

    return [];

  }

}



function writeAll(events: UnitJobMetricEvent[]): void {

  try {

    localStorage.setItem(STORAGE_KEY, JSON.stringify(events.slice(-MAX_EVENTS)));

  } catch {

    /* quota / private mode */

  }

}



/** Ghi một lần sinh / verify / apply unit. */

export function recordUnitJobMetric(input: {

  projectId: string;

  contextSource?: string | null;

  runnerUsed?: string | null;

  ideConnected?: boolean;

  jobId?: string | null;

  via?: "ide-extension" | "api-legacy" | null;

  durationMs?: number | null;

  failReason?: string | null;

  commandId?: string | null;

  ok?: boolean;

  contextSize?: number | null;

  retrievedFiles?: number | null;

  promptTokens?: number | null;

  promptChars?: number | null;

  cliTimeMs?: number | null;

  verifyTimeMs?: number | null;

  applyTimeMs?: number | null;

}): UnitJobMetricEvent {

  const event: UnitJobMetricEvent = {

    at: new Date().toISOString(),

    projectId: input.projectId,

    contextSource: normalizeSource(input.contextSource),

    runnerUsed: input.runnerUsed ?? null,

    ideConnected: input.ideConnected,

    jobId: input.jobId ?? null,

    via: input.via ?? null,

    durationMs: input.durationMs ?? null,

    failReason: input.failReason ?? null,

    commandId: input.commandId ?? null,

    ok: input.ok,

    contextSize: input.contextSize ?? null,

    retrievedFiles: input.retrievedFiles ?? null,

    promptTokens: input.promptTokens ?? null,

    promptChars: input.promptChars ?? null,

    cliTimeMs: input.cliTimeMs ?? null,

    verifyTimeMs: input.verifyTimeMs ?? null,

    applyTimeMs: input.applyTimeMs ?? null,

  };

  const next = [...readAll(), event];

  writeAll(next);

  return event;

}



function avgOf(nums: number[]): number | null {

  if (!nums.length) return null;

  return Math.round(nums.reduce((a, b) => a + b, 0) / nums.length);

}



export function summarizeUnitJobMetrics(opts?: {

  projectId?: string | null;

  /** Lookback window; default all stored */

  sinceMs?: number;

}): UnitJobMetricsSummary {

  const since = opts?.sinceMs ? Date.now() - opts.sinceMs : 0;

  let events = readAll();

  if (opts?.projectId) {

    events = events.filter((e) => e.projectId === opts.projectId);

  }

  if (since > 0) {

    events = events.filter((e) => Date.parse(e.at) >= since);

  }



  const bySource: Record<string, number> = {};

  let ideN = 0;

  let localN = 0;

  let noIdeN = 0;

  const cliTimes: number[] = [];

  const verifyTimes: number[] = [];

  const applyTimes: number[] = [];



  for (const e of events) {

    const src = normalizeSource(e.contextSource);

    bySource[src] = (bySource[src] ?? 0) + 1;

    if (isIdeSource(src)) ideN += 1;

    if (src === "local-fs") localN += 1;

    if (src === "local-fs" || e.ideConnected === false) noIdeN += 1;

    else if (!isIdeSource(src) && e.ideConnected !== true) noIdeN += 1;

    if (typeof e.cliTimeMs === "number" && e.cliTimeMs >= 0) cliTimes.push(e.cliTimeMs);

    if (typeof e.verifyTimeMs === "number" && e.verifyTimeMs >= 0) {

      verifyTimes.push(e.verifyTimeMs);

    }

    if (typeof e.applyTimeMs === "number" && e.applyTimeMs >= 0) {

      applyTimes.push(e.applyTimeMs);

    }

  }



  const total = events.length;

  const pct = (n: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);



  return {

    total,

    bySource,

    localFsPct: pct(localN),

    idePct: pct(ideN),

    noIdePct: pct(noIdeN),

    avgCliTimeMs: avgOf(cliTimes),

    avgVerifyTimeMs: avgOf(verifyTimes),

    avgApplyTimeMs: avgOf(applyTimes),

    lastAt: events.length ? events[events.length - 1]!.at : null,

  };

}



export function clearUnitJobMetrics(projectId?: string | null): void {

  if (!projectId) {

    writeAll([]);

    return;

  }

  writeAll(readAll().filter((e) => e.projectId !== projectId));

}



/** Lấy metric gần nhất cho project (ưu tiên bản ghi có phase metrics). */
export function latestUnitJobMetric(projectId?: string | null): UnitJobMetricEvent | null {

  const pid = (projectId || "").trim();

  const events = readAll().filter((e) => !pid || e.projectId === pid);

  if (!events.length) return null;

  for (let i = events.length - 1; i >= 0; i -= 1) {

    const e = events[i]!;

    if (
      typeof e.cliTimeMs === "number" ||
      typeof e.promptChars === "number" ||
      typeof e.contextSize === "number" ||
      typeof e.retrievedFiles === "number"
    ) {
      return e;
    }

  }

  return events[events.length - 1] ?? null;

}

/** Get metric by unit jobId (Gen → Verify correlation). */
export function unitJobMetricByJobId(
  unitJobId?: string | null
): UnitJobMetricEvent | null {
  const id = (unitJobId || "").trim();
  if (!id) return null;
  const events = readAll().filter((e) => e.jobId === id);
  if (!events.length) return null;
  return events[events.length - 1] ?? null;
}

/** Nhãn hiển thị thân thiện (U0 copy). */

export function labelContextSource(source?: string | null): string {

  switch (normalizeSource(source)) {

    case "local-fs":

      return "Local FS";

    case "agent-ide":

      return "IDE packet (tuỳ chọn)";

    case "implementation-plan":

      return "Implementation Planner";

    case "ide":

    case "ide-semantic":

      return "IDE semantic (tuỳ chọn)";

    default:

      return "Không rõ";

  }

}


