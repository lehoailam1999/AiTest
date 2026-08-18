/**
 * Parse portable Unit TC markers from Test Data / sync MD (Gen gates).
 */

import {
  parseAllUnitStatuses,
  pickCanonicalUnitStatus,
  type UnitTcReadyStatus,
} from "./normalizeUnitTcStatus";

export type UnitTcMarkerSnapshot = {
  status: UnitTcReadyStatus | null;
  primaryBucket: string | null;
  behaviorId: string | null;
  targetField: string | null;
  targetProperty: string | null;
  /** Comma/space-separated bound properties when multi-field TC. */
  targetProperties: string[];
  targetConstraint: string | null;
  targetScope: string | null;
  hasSourceSignal: boolean;
};

export function parseUnitTcMarkers(blob: string | null | undefined): UnitTcMarkerSnapshot {
  const out: UnitTcMarkerSnapshot = {
    status: null,
    primaryBucket: null,
    behaviorId: null,
    targetField: null,
    targetProperty: null,
    targetProperties: [],
    targetConstraint: null,
    targetScope: null,
    hasSourceSignal: false,
  };
  const statuses: UnitTcReadyStatus[] = [];
  for (const line of (blob || "").split(/\r?\n/)) {
    const m = line.match(/^([^:]+):\s*(.+)$/);
    if (!m) continue;
    const key = m[1].trim().toLowerCase();
    const val = m[2].trim();
    switch (key) {
      case "status": {
        const v = val.toUpperCase();
        if (v === "READY_FOR_CODEGEN") statuses.push("READY_FOR_CODEGEN");
        else if (v === "READY_FOR_GROUNDING") statuses.push("READY_FOR_GROUNDING");
        else if (v === "NOT_READY") statuses.push("NOT_READY");
        else if (v === "FEATURE_GAP") statuses.push("FEATURE_GAP");
        break;
      }
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
      case "target.properties": {
        out.targetProperties = val
          .split(/[,;\s]+/)
          .map((s) => s.trim())
          .filter((s) => /^[A-Za-z_]\w*$/.test(s));
        break;
      }
      case "target.constraint":
        out.targetConstraint = val;
        break;
      case "target.scope":
        out.targetScope = val.toLowerCase();
        break;
      case "sourcesignal":
        out.hasSourceSignal = Boolean(val);
        break;
      default:
        break;
    }
  }
  out.status = pickCanonicalUnitStatus(statuses.length ? statuses : parseAllUnitStatuses(blob));
  if (!out.targetProperties.length && out.targetProperty) {
    out.targetProperties = [out.targetProperty];
  }
  return out;
}

export function parseUnitTcStatus(
  blob: string | null | undefined
): UnitTcReadyStatus | null {
  return parseUnitTcMarkers(blob).status;
}

