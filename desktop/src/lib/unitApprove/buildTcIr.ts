import {
  UNIT_TC_IR_SCHEMA,
  type UnitApprovePrimaryBucket,
  type UnitApproveScenario,
  type UnitApproveTargetScope,
  type UnitApproveTcIr,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { parseUnitTcMarkers } from "../unitWorkspace/parseUnitTcMarkers";

const PRIMARY_BUCKETS = new Set<UnitApprovePrimaryBucket>([
  "BUSINESS_RULES",
  "VALIDATION_DATA",
  "ERROR_HANDLING",
  "ACCEPTANCE",
]);

const SCENARIOS = new Set<UnitApproveScenario>([
  "POSITIVE",
  "NEGATIVE",
  "BOUNDARY",
  "NULL",
  "EMPTY",
  "BLANK",
  "DUPLICATE",
  "NOT_FOUND",
  "AUTHORIZATION",
  "INVALID_STATE",
  "DEPENDENCY_FAILURE",
]);

function marker(blob: string, key: string): string | undefined {
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return blob.match(new RegExp(`^\\s*${escaped}\\s*:\\s*(.+)$`, "im"))?.[1]?.trim();
}

function jsonMarker(blob: string, key: string): Record<string, unknown> | undefined {
  const raw = marker(blob, key);
  if (!raw) return undefined;
  try {
    const value = JSON.parse(raw) as unknown;
    return value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : undefined;
  } catch {
    throw new Error(`Unit TC ${key} must be valid JSON`);
  }
}

function lines(value: string | null | undefined): string[] {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[-*]|\d+[.)])\s*/, "").trim())
    .filter(Boolean);
}

function inferScenario(tc: TestCase, blob: string): UnitApproveScenario {
  const explicit = marker(blob, "scenario")?.toUpperCase() as UnitApproveScenario;
  if (SCENARIOS.has(explicit)) return explicit;
  const text = `${tc.type}\n${tc.title}\n${tc.steps}\n${tc.expectedResult}`.toLowerCase();
  if (/\bnull\b|giá trị null/.test(text)) return "NULL";
  if (/\bblank\b|chỉ khoảng trắng/.test(text)) return "BLANK";
  if (/\bempty\b|rỗng/.test(text)) return "EMPTY";
  if (/\bduplicate\b|trùng/.test(text)) return "DUPLICATE";
  if (/not found|không tìm thấy/.test(text)) return "NOT_FOUND";
  if (/unauthori|phân quyền|không có quyền/.test(text)) return "AUTHORIZATION";
  if (/boundary|biên|giới hạn/.test(text)) return "BOUNDARY";
  if (/dependency|phụ thuộc.*(?:lỗi|fail)/.test(text)) return "DEPENDENCY_FAILURE";
  if (/invalid state|trạng thái không hợp lệ/.test(text)) return "INVALID_STATE";
  if (/negative|phủ định|không hợp lệ|thất bại/.test(text)) return "NEGATIVE";
  return "POSITIVE";
}

function inferPrimaryBucket(blob: string): UnitApprovePrimaryBucket {
  const parsed = parseUnitTcMarkers(blob).primaryBucket;
  const traced = marker(blob, "trace")?.split(/[/:]/)[0]?.trim().toUpperCase();
  const value = (parsed || traced || "ACCEPTANCE") as UnitApprovePrimaryBucket;
  return PRIMARY_BUCKETS.has(value) ? value : "ACCEPTANCE";
}

function expectedType(description: string, blob: string): string {
  const explicit = marker(blob, "expected.type");
  if (explicit) return explicit;
  if (/throw|exception|lỗi|error/i.test(description)) return "exception";
  if (/status/i.test(description)) return "status";
  return "value";
}

export function buildUnitApproveTcIr(
  tc: TestCase,
  opts?: { requirementTitle?: string | null }
): UnitApproveTcIr {
  const blob = tc.testData || "";
  const parsed = parseUnitTcMarkers(blob);
  // Approve stamps its own outcome back into the TC, so every post-analysis
  // status must stay re-resolvable; only a TC that never went through analysis
  // is refused here.
  if (!parsed.status) {
    throw new Error(
      `Unit TC ${tc.testCaseId} has no status marker — re-run Unit analysis before Approve`
    );
  }

  const fieldLabels = (parsed.targetField || "")
    .split(/[,;]+/)
    .map((field) => field.trim())
    .filter(Boolean);
  const explicitScope = parsed.targetScope as UnitApproveTargetScope | null;
  const scope: UnitApproveTargetScope =
    explicitScope === "field" ||
    explicitScope === "multi" ||
    explicitScope === "aggregate"
      ? explicitScope
      : fieldLabels.length > 1
        ? "multi"
        : fieldLabels.length === 1
          ? "field"
          : "aggregate";
  const input = jsonMarker(blob, "input");
  const existingState = jsonMarker(blob, "existingState");
  const stepLines = lines(tc.steps);
  const prepare = stepLines.filter((line) =>
    /^(?:given|prepare|arrange|setup|tạo|chuẩn bị|thiết lập)\b/i.test(line)
  );
  const execute = stepLines.filter((line) => !prepare.includes(line));
  const primaryBucket = inferPrimaryBucket(blob);
  const categories = (marker(blob, "categories") || tc.type || "Unit")
    .split(/[,;]+/)
    .map((category) => category.trim())
    .filter(Boolean);
  const requirementIds = [
    tc.sourceId,
    tc.requirementSnapshotId,
  ].filter((id): id is string => Boolean(id));

  const target =
    fieldLabels.length ||
    parsed.targetConstraint ||
    marker(blob, "target.boundary") ||
    marker(blob, "target.value")
      ? {
          scope,
          fields: fieldLabels,
          ...(parsed.targetConstraint
            ? { constraint: parsed.targetConstraint }
            : {}),
          ...(marker(blob, "target.boundary")
            ? { boundary: marker(blob, "target.boundary") }
            : {}),
          ...(marker(blob, "target.value")
            ? { value: parseMarkerValue(marker(blob, "target.value")!) }
            : {}),
        }
      : undefined;

  return {
    schema: UNIT_TC_IR_SCHEMA,
    testCaseId: tc.id,
    title: tc.title,
    requirement: {
      ...(opts?.requirementTitle?.trim()
        ? { title: opts.requirementTitle.trim() }
        : {}),
      requirementIds,
      behaviorId: marker(blob, "behaviorId") || tc.testCaseId,
    },
    ...(tc.module?.trim() ? { module: tc.module.trim() } : {}),
    primaryBucket,
    scenario: inferScenario(tc, blob),
    categories,
    preconditions: lines(tc.precondition),
    steps: {
      prepare,
      execute: execute.length ? execute : stepLines,
    },
    expected: {
      type: expectedType(tc.expectedResult, blob),
      description: tc.expectedResult.trim(),
      observable:
        marker(blob, "expected.observable") || tc.expectedResult.trim(),
    },
    testData: {
      ...(target ? { target } : {}),
      ...(input ? { input } : {}),
      ...(existingState ? { existingState } : {}),
    },
    ...(marker(blob, "layer") || marker(blob, "sourceSignal")
      ? {
          hints: {
            ...(marker(blob, "layer")
              ? {
                  layer: marker(blob, "layer") as
                    | "dto"
                    | "validator"
                    | "service"
                    | "handler"
                    | "repository",
                }
              : {}),
            ...(marker(blob, "sourceSignal")
              ? { sourceSignal: marker(blob, "sourceSignal") }
              : {}),
          },
        }
      : {}),
    readiness: "READY_FOR_GROUNDING",
  };
}

function parseMarkerValue(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
