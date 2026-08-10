/**
 * Unit job timeline event names + helpers (architecture observability).
 */

export type UnitJobEventName =
  | "job.queued"
  | "job.gen.started"
  | "job.gen.progress"
  | "job.gen.completed"
  | "job.gen.failed"
  | "job.gen.context_truncated"
  | "job.transform"
  | "job.verify.started"
  | "job.verify.completed"
  | "job.verify.failed"
  | "job.apply.started"
  | "job.apply.completed"
  | "job.apply.failed"
  | "job.cancelled";

export type UnitJobTimelineEntry = {
  at: string;
  event: UnitJobEventName;
  detail?: string;
};

/**
 * How Unit *code* was produced.
 * - ide-extension: Desktop orchestrates → Extension → Cursor CLI (only Gen path for Unit)
 * - api-legacy: historical Gen / Repair metrics (Repair still uses API ↔ AI CLI)
 */
export type UnitGenVia = "ide-extension" | "api-legacy";

export type UnitTransformName =
  | "rewriteSutImports"
  | "jestPreamble"
  | "csharpSanitize";

export function pushTimeline(
  timeline: UnitJobTimelineEntry[],
  event: UnitJobEventName,
  detail?: string
): UnitJobTimelineEntry[] {
  return [
    ...timeline,
    {
      at: new Date().toISOString(),
      event,
      detail: detail?.slice(0, 500),
    },
  ];
}
