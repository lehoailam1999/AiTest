/**
 * Parse portable Unit TC markers from Test Data / sync MD (Gen gates).
 */

const STATUS_READY_RE = /^status\s*:\s*READY_FOR_CODEGEN\s*$/im;
const STATUS_NOT_READY_RE = /^status\s*:\s*NOT_READY\s*$/im;
const PLACEHOLDER_FIELD_RE =
  /\[?\s*chưa\s+xác\s+định|not\s+determined|unknown\s+field|\[?\s*tbd\s*\]?/i;

export type UnitTcMarkerSnapshot = {
  status: "READY_FOR_CODEGEN" | "NOT_READY" | null;
  primaryBucket: string | null;
  behaviorId: string | null;
  targetField: string | null;
  targetProperty: string | null;
  targetConstraint: string | null;
  hasSourceSignal: boolean;
};

export function parseUnitTcMarkers(blob: string | null | undefined): UnitTcMarkerSnapshot {
  const out: UnitTcMarkerSnapshot = {
    status: null,
    primaryBucket: null,
    behaviorId: null,
    targetField: null,
    targetProperty: null,
    targetConstraint: null,
    hasSourceSignal: false,
  };
  for (const line of (blob || "").split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    switch (key) {
      case "status":
        if (/^ready_for_codegen$/i.test(val)) out.status = "READY_FOR_CODEGEN";
        else if (/^not_ready$/i.test(val)) out.status = "NOT_READY";
        break;
      case "primarybucket":
        out.primaryBucket = val.toUpperCase();
        break;
      case "behaviorid":
        out.behaviorId = val;
        break;
      case "target.field":
        out.targetField = val;
        break;
      case "target.property":
        out.targetProperty = val;
        break;
      case "target.constraint":
        out.targetConstraint = val;
        break;
      case "sourcesignal":
        out.hasSourceSignal = Boolean(val);
        break;
      default:
        break;
    }
  }
  return out;
}

/** Gen fail-closed when TC explicitly NOT_READY or VALIDATION IR incomplete. */
export function isUnitTcBlockedForGen(blob: string | null | undefined): {
  blocked: boolean;
  reason?: string;
} {
  const raw = blob || "";
  if (STATUS_NOT_READY_RE.test(raw)) {
    return { blocked: true, reason: "FAIL_NOT_READY — TC đánh dấu NOT_READY trong Test Data" };
  }
  const m = parseUnitTcMarkers(raw);
  if (m.status === "NOT_READY") {
    return { blocked: true, reason: "FAIL_NOT_READY — TC đánh dấu NOT_READY" };
  }
  const primary =
    m.primaryBucket ||
    (/trace:\s*VALIDATION_DATA/i.test(raw) ? "VALIDATION_DATA" : null);
  if (primary === "VALIDATION_DATA") {
    if (!m.targetField) {
      return {
        blocked: true,
        reason: "FAIL_VAL_NO_FIELD — VALIDATION thiếu target.field",
      };
    }
    if (PLACEHOLDER_FIELD_RE.test(m.targetField)) {
      return {
        blocked: true,
        reason: "FAIL_FIELD_PLACEHOLDER — target.field chưa xác định",
      };
    }
    if (!m.targetConstraint) {
      return {
        blocked: true,
        reason: "FAIL_VAL_NO_CONSTRAINT — VALIDATION thiếu target.constraint",
      };
    }
    const fieldNeedsBind =
      Boolean(m.targetField) &&
      (!/^[A-Za-z_]\w*$/.test(m.targetField) ||
        /[^\x00-\x7F]/.test(m.targetField));
    if (
      fieldNeedsBind &&
      !m.targetProperty &&
      /input:\s*\{/.test(raw)
    ) {
      const inputKey = raw.match(/input:\s*\{\s*["']?([^"':,\s}]+)/i)?.[1];
      return {
        blocked: true,
        reason:
          `FAIL_FIELD_UNBOUND — ${inputKey ? `Map ${inputKey}→<BEProperty> trong code-aliases.fields; ` : ""}` +
          "target.field VI/label chưa bind target.property; input chưa map BE",
      };
    }
  }
  return { blocked: false };
}

export function parseUnitTcStatus(blob: string | null | undefined): "READY_FOR_CODEGEN" | "NOT_READY" | null {
  const raw = blob || "";
  if (STATUS_NOT_READY_RE.test(raw)) return "NOT_READY";
  if (STATUS_READY_RE.test(raw)) return "READY_FOR_CODEGEN";
  return parseUnitTcMarkers(raw).status;
}
