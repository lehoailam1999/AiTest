/**
 * Phase U0 — đo nguồn context khi sinh unit (Local FS vs IDE).
 * Lưu localStorage theo project; không gửi PII / nội dung file.
 */

export type UnitContextSource =
  | "local-fs"
  | "ide"
  | "agent-ide"
  | "ide-semantic"
  | "unknown";

export type UnitJobMetricEvent = {
  at: string;
  projectId: string;
  contextSource: UnitContextSource;
  runnerUsed?: string | null;
  ideConnected?: boolean;
};

export type UnitJobMetricsSummary = {
  total: number;
  bySource: Record<string, number>;
  localFsPct: number;
  idePct: number;
  /** Jobs that did not need IDE connected (local-fs or unknown without ide flag) */
  noIdePct: number;
  lastAt?: string | null;
};

const STORAGE_KEY = "aitest.unitJobMetrics.v1";
const MAX_EVENTS = 200;

function normalizeSource(raw?: string | null): UnitContextSource {
  const s = (raw || "").toLowerCase().trim();
  if (s === "local-fs" || s === "local_fs" || s === "fs") return "local-fs";
  if (s === "agent-ide" || s === "agent_ide") return "agent-ide";
  if (s === "ide-semantic" || s === "ide_semantic") return "ide-semantic";
  if (s === "ide") return "ide";
  return "unknown";
}

function isIdeSource(source: UnitContextSource): boolean {
  return source === "ide" || source === "agent-ide" || source === "ide-semantic";
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

/** Ghi một lần sinh unit thành công (hoặc đã tạo workspace). */
export function recordUnitJobMetric(input: {
  projectId: string;
  contextSource?: string | null;
  runnerUsed?: string | null;
  ideConnected?: boolean;
}): UnitJobMetricEvent {
  const event: UnitJobMetricEvent = {
    at: new Date().toISOString(),
    projectId: input.projectId,
    contextSource: normalizeSource(input.contextSource),
    runnerUsed: input.runnerUsed ?? null,
    ideConnected: input.ideConnected,
  };
  const next = [...readAll(), event];
  writeAll(next);
  return event;
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

  for (const e of events) {
    const src = normalizeSource(e.contextSource);
    bySource[src] = (bySource[src] ?? 0) + 1;
    if (isIdeSource(src)) ideN += 1;
    if (src === "local-fs") localN += 1;
    if (src === "local-fs" || e.ideConnected === false) noIdeN += 1;
    else if (!isIdeSource(src) && e.ideConnected !== true) noIdeN += 1;
  }

  const total = events.length;
  const pct = (n: number) => (total ? Math.round((1000 * n) / total) / 10 : 0);

  return {
    total,
    bySource,
    localFsPct: pct(localN),
    idePct: pct(ideN),
    noIdePct: pct(noIdeN),
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

/** Nhãn hiển thị thân thiện (U0 copy). */
export function labelContextSource(source?: string | null): string {
  switch (normalizeSource(source)) {
    case "local-fs":
      return "Local FS";
    case "agent-ide":
      return "IDE packet (tuỳ chọn)";
    case "ide":
    case "ide-semantic":
      return "IDE semantic (tuỳ chọn)";
    default:
      return "Không rõ";
  }
}
