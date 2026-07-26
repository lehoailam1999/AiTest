/**
 * Local heuristic Business Analyzer (P9 shell) — no LLM.
 * Replaced by Backend Analyzer when P9 API ships.
 */
import type { BusinessIntent } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";

const ACTION_MAP: { re: RegExp; action: string }[] = [
  { re: /tạo|create|thêm|add|insert|đăng\s*ký/i, action: "Create" },
  { re: /cập\s*nhật|update|sửa|edit|modify/i, action: "Update" },
  { re: /xóa|xoá|delete|remove/i, action: "Delete" },
  { re: /xem|get|đọc|read|list|tìm|search|query/i, action: "Read" },
  { re: /đăng\s*nhập|login|auth|sign\s*in/i, action: "Authenticate" },
  { re: /duyệt|approve|reject|phê\s*duyệt/i, action: "Approve" },
  { re: /upload|tải\s*lên/i, action: "Upload" },
];

/** Very light VN/EN noun guess from title after stripping action verbs. */
function guessEntity(title: string): string {
  const cleaned = title
    .replace(
      /tạo|create|thêm|cập\s*nhật|update|xóa|xoá|delete|xem|get|thành\s*công|thất\s*bại|khi|với|của|một|các/gi,
      " "
    )
    .replace(/\s+/g, " ")
    .trim();
  const parts = cleaned.split(" ").filter((p) => p.length > 2);
  if (parts.length === 0) return "Unknown";
  const raw = parts[parts.length - 1]!;
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

function extractExpected(tc: TestCase): string[] {
  const out: string[] = [];
  const exp = (tc.expectedResult || "").trim();
  if (exp) {
    for (const line of exp.split(/\r?\n|;|•|\|/)) {
      const t = line.trim();
      if (t.length > 2) out.push(t);
    }
  }
  if (out.length === 0 && /thành\s*công|success/i.test(tc.title)) {
    out.push("Operation succeeds");
  }
  return out.slice(0, 8);
}

function searchHints(action: string, entity: string, terms: string[]): string[] {
  const hints = new Set<string>();
  hints.add(entity);
  hints.add(`${entity}Service`);
  hints.add(`${entity}Command`);
  hints.add(`${entity}Handler`);
  hints.add(`${entity}Repository`);
  hints.add(`${entity}Controller`);
  if (action === "Create") hints.add(`Create${entity}`);
  if (action === "Update") hints.add(`Update${entity}`);
  if (action === "Delete") hints.add(`Delete${entity}`);
  for (const t of terms) {
    if (t.length > 2) hints.add(t);
  }
  return [...hints].slice(0, 16);
}

export function analyzeBusinessIntentLocal(tc: TestCase): BusinessIntent {
  const blob = [tc.title, tc.precondition, tc.steps, tc.expectedResult, tc.testData]
    .filter(Boolean)
    .join("\n");

  let action = "Process";
  for (const row of ACTION_MAP) {
    if (row.re.test(blob)) {
      action = row.action;
      break;
    }
  }

  const entity = guessEntity(tc.title || tc.module || "Target");
  const expectedResults = extractExpected(tc);
  const domainTerms = [
    ...(tc.module ? [tc.module] : []),
    entity,
    ...expectedResults.map((e) => e.split(/\s+/).slice(0, 3).join(" ")),
  ].slice(0, 12);

  const businessRules: string[] = [];
  const validationRules: string[] = [];
  if (/bắt\s*buộc|required|không\s*được\s*rỗng/i.test(blob)) {
    validationRules.push("Required fields must be present");
  }
  if (/quyền|permission|role|authorize/i.test(blob)) {
    businessRules.push("Authorization / role check");
  }

  const externalDeps: string[] = [];
  if (/email|mail|smtp/i.test(blob)) externalDeps.push("Email");
  if (/upload|file|ảnh|image|s3|blob/i.test(blob)) externalDeps.push("FileStorage");
  if (/audit|nhật\s*ký|log/i.test(blob)) externalDeps.push("AuditLog");

  return {
    action,
    entity,
    expectedResults,
    businessRules,
    validationRules,
    externalDeps,
    domainTerms,
    searchHints: searchHints(action, entity, domainTerms),
  };
}
