/**
 * Single Unit TC status line — READY | NOT_READY | FEATURE_GAP.
 * Strips dual/conflicting status markers from Test Data.
 */

export type UnitTcReadyStatus =
  | "READY_FOR_CODEGEN"
  | "READY_FOR_GROUNDING"
  | "NOT_READY"
  | "FEATURE_GAP";

const STATUS_LINE_RE = /^\s*status\s*:\s*.+$/gim;

/** Worst wins when multiple statuses appear. */
export function pickCanonicalUnitStatus(
  statuses: Array<UnitTcReadyStatus | null | undefined>
): UnitTcReadyStatus | null {
  const set = new Set(
    statuses.filter((s): s is UnitTcReadyStatus =>
      s === "READY_FOR_CODEGEN" || s === "NOT_READY" || s === "FEATURE_GAP"
      || s === "READY_FOR_GROUNDING"
    )
  );
  if (set.has("FEATURE_GAP")) return "FEATURE_GAP";
  if (set.has("NOT_READY")) return "NOT_READY";
  if (set.has("READY_FOR_GROUNDING")) return "READY_FOR_GROUNDING";
  if (set.has("READY_FOR_CODEGEN")) return "READY_FOR_CODEGEN";
  return null;
}

export function parseAllUnitStatuses(
  blob: string | null | undefined
): UnitTcReadyStatus[] {
  const out: UnitTcReadyStatus[] = [];
  for (const line of String(blob || "").split(/\r?\n/)) {
    const m = line.match(/^\s*status\s*:\s*(\S+)/i);
    if (!m) continue;
    const v = m[1].trim().toUpperCase();
    if (v === "READY_FOR_CODEGEN") out.push("READY_FOR_CODEGEN");
    else if (v === "READY_FOR_GROUNDING") out.push("READY_FOR_GROUNDING");
    else if (v === "NOT_READY") out.push("NOT_READY");
    else if (v === "FEATURE_GAP") out.push("FEATURE_GAP");
  }
  return out;
}

/** Remove every status: line then optionally insert one canonical line. */
export function stripUnitStatusLines(blob: string): string {
  return String(blob || "")
    .replace(STATUS_LINE_RE, "")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * Write exactly one status. READY is allowed only when `allowReady` is true
 * (Approve Decision authoritative / Gen-ready).
 */
export function normalizeUnitTcStatus(
  blob: string | null | undefined,
  opts: {
    status?: UnitTcReadyStatus | null;
    /** When false, READY_FOR_CODEGEN is downgraded to NOT_READY. */
    allowReady?: boolean;
  } = {}
): string {
  const raw = String(blob || "");
  const existing = pickCanonicalUnitStatus(parseAllUnitStatuses(raw));
  let next: UnitTcReadyStatus | null =
    opts.status !== undefined ? opts.status : existing;
  if (next === "READY_FOR_CODEGEN" && opts.allowReady === false) {
    next = "NOT_READY";
  }
  const stripped = stripUnitStatusLines(raw);
  if (!next) return stripped;
  if (!stripped) return `status: ${next}`;
  // Place status near other IR markers when possible.
  const lines = stripped.split(/\r?\n/);
  const insertAt = Math.max(
    0,
    lines.findIndex((l) => /^\s*(primaryBucket|scenario|target\.|trace)\s*:/i.test(l))
  );
  if (
    insertAt >= 0 &&
    /primaryBucket|scenario|target\.|trace/i.test(lines[insertAt] || "")
  ) {
    // After first IR block start — keep status early in Test Data
    const idx = lines.findIndex((l) =>
      /^\s*(scenario|primaryBucket)\s*:/i.test(l)
    );
    const at = idx >= 0 ? idx + 1 : 0;
    lines.splice(at, 0, `status: ${next}`);
    return lines.join("\n").trim();
  }
  return `${stripped}\nstatus: ${next}`.trim();
}

