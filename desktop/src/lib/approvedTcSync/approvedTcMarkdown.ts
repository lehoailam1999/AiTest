/**
 * Phase C — serialize Approved TestCase → Markdown under `.ai-test/test-cases/`.
 * Artifact for Agent local / Extension Gen — includes grounding hierarchy for SUT resolve.
 *
 * Display labels (sync MD / UI):
 *   Module   = Requirement Studio title (`requirement:`) — scopes source-module family
 *   Function = TC.module (`function:` / legacy `module:`) — ranks files inside that family
 *   Title    = TC title — refine symbol/path inside family
 */
import { AI_TEST_CASES_DIR, assertSafeAiTestCasesRel, extractTcSourceMarkers } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { TEST_CASES_DIR } from "../projectProfile/constants";

function slugSeg(raw: string, fallback: string): string {
  const s = (raw || "")
    .trim()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 80);
  return s || fallback;
}

/** Relative path: `.ai-test/test-cases/{function}/{testCaseId}.md` (folder = TC.module) */
export function approvedTcMarkdownRelPath(tc: Pick<TestCase, "testCaseId" | "module" | "id">): string {
  const moduleSeg = slugSeg(tc.module || "general", "general");
  const codeSeg = slugSeg(tc.testCaseId || tc.id, tc.id.slice(0, 8));
  const rel = `${TEST_CASES_DIR}/${moduleSeg}/${codeSeg}.md`;
  return assertSafeAiTestCasesRel(rel);
}

function yamlEscape(v: string): string {
  if (/[:#\n"'\\]/.test(v) || v.trim() !== v) {
    return JSON.stringify(v);
  }
  return v;
}

export type ApprovedTcMdRenderOpts = {
  /** Owning Module title (Requirement Studio) — scopes Unit SUT before Function/Title */
  requirementTitle?: string | null;
};

/**
 * Progressive grounding block — Extension/Desktop Unit resolve reads this.
 * Order: markers → Module (requirement) → Function (module) → title.
 * Machine keys: `requirement:` = Module; `function:` / `module:` = Function.
 */
export function parseApprovedTcGrounding(md: string | null | undefined): {
  requirement: string;
  module: string;
  title: string;
} {
  const text = md || "";
  const fm = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
    return (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
  };
  const block = (key: string) => {
    const m = text.match(
      new RegExp(`##\\s*Grounding[\\s\\S]*?^${key}:\\s*(.+)$`, "im")
    );
    return (m?.[1] || "").trim();
  };
  return {
    // Module (Studio) — prefer requirement:; legacy never used module: for this
    requirement: block("requirement") || fm("requirement"),
    // Function — prefer function: / chức năng:; `module:` is legacy Function key
    module:
      block("function") ||
      block("chức năng") ||
      block("chuc nang") ||
      block("module") ||
      fm("module"),
    title: block("title") || fm("title"),
  };
}

export function renderUnitGroundingBlock(
  tc: Pick<TestCase, "title" | "module" | "testData">,
  requirementTitle?: string | null
): string {
  const modDoc = (requirementTitle || "").trim() || "—";
  const fn = (tc.module || "").trim() || "—";
  const title = (tc.title || "").trim() || "—";
  const markers = extractTcSourceMarkers(tc.testData || "");
  const skip =
    (tc.testData || "").match(/^\s*#\s*sut-resolve:\s*skipped\s*—\s*(.+)$/im)?.[1]?.trim() ||
    "";

  // Display-only: path/code/related come from Approve auto-enrich — not hardcoded here.
  const resolvedLines: string[] = ["### Resolved SUT", ""];
  if (markers.paths[0] || markers.codes[0]) {
    if (markers.paths[0]) resolvedLines.push(`path: ${markers.paths[0]}`);
    if (markers.codes[0]) resolvedLines.push(`code: ${markers.codes[0]}`);
    if (markers.related.length) {
      resolvedLines.push(`related: ${markers.related.join(", ")}`);
    }
  } else if (skip) {
    resolvedLines.push(`_(unresolved)_ ${skip}`);
  } else {
    resolvedLines.push(
      "_(unresolved)_ — Approve chưa khớp được SUT từ index (Module → Function → Title)."
    );
  }

  return [
    "## Grounding (Unit Gen)",
    "",
    `requirement: ${modDoc}`,
    `module: ${fn}`,
    `function: ${fn}`,
    `title: ${title}`,
    "",
    "SUT resolve (tự động khi Approve): Module → Function → Title → index/path-index → body-rule.",
    "(`requirement` = Module / tài liệu Studio; `function`/`module` = Function / chức năng TC.)",
    "Module khoanh vùng source-module trên index; Function + Title xếp file/symbol trong vùng đó.",
    "Kết quả ghi vào Test Data (`path:` / `code:` / optional `related:`) khi đủ tin cậy — không hardcode trong template.",
    "",
    ...resolvedLines,
    "",
  ].join("\n");
}

export function renderApprovedTestCaseMarkdown(
  tc: TestCase,
  opts?: ApprovedTcMdRenderOpts
): string {
  const requirementTitle =
    (opts?.requirementTitle || "").trim() || "";

  const lines: string[] = [
    "---",
    `id: ${yamlEscape(tc.id)}`,
    `testCaseId: ${yamlEscape(tc.testCaseId)}`,
    `title: ${yamlEscape(tc.title)}`,
    `module: ${yamlEscape(tc.module || "")}`,
    `requirement: ${yamlEscape(requirementTitle)}`,
    `type: ${yamlEscape(tc.type)}`,
    `priority: ${yamlEscape(tc.priority)}`,
    `severity: ${yamlEscape(tc.severity)}`,
    `reviewStatus: ${yamlEscape(tc.reviewStatus)}`,
    `projectId: ${yamlEscape(tc.projectId)}`,
    "---",
    "",
    `# ${tc.title}`,
    "",
    "## Meta",
    "",
    `| Field | Value |`,
    `| --- | --- |`,
    `| Code | \`${tc.testCaseId}\` |`,
    `| Module | ${requirementTitle || "—"} |`,
    `| Function | ${tc.module || "—"} |`,
    `| Type | ${tc.type} |`,
    `| Priority | ${tc.priority} |`,
    `| Severity | ${tc.severity} |`,
    `| Review | ${tc.reviewStatus} |`,
    "",
    renderUnitGroundingBlock(tc, requirementTitle).trimEnd(),
    "",
    "## Precondition",
    "",
    (tc.precondition || "").trim() || "_(none)_",
    "",
    "## Steps",
    "",
    (tc.steps || "").trim() || "_(none)_",
    "",
    "## Expected Result",
    "",
    (tc.expectedResult || "").trim() || "_(none)_",
    "",
  ];
  if ((tc.testData || "").trim()) {
    lines.push("## Test Data", "", (tc.testData || "").trim(), "");
  }
  lines.push(
    "<!-- aitest:approved-tc-artifact — SoT Gen vẫn là DB Approved; file này đồng bộ cho Agent/IDE -->",
    "<!-- aitest:unit-grounding — Module (requirement) → Function (module) → title for SUT resolve -->",
    ""
  );
  return lines.join("\n");
}

export type ApprovedTcMdFile = { path: string; content: string; testCaseId: string };

export type BuildApprovedTcMdOpts = {
  /** Per-case Module title (testCaseId or id → title) */
  requirementTitleByCaseKey?: Record<string, string> | null;
  /** Single Module title when syncing under one Studio workspace */
  requirementTitle?: string | null;
};

function resolveRequirementTitle(tc: TestCase, opts?: BuildApprovedTcMdOpts): string {
  const map = opts?.requirementTitleByCaseKey || {};
  const fromMap =
    map[tc.testCaseId] ||
    map[tc.id] ||
    (tc.requirementSnapshotId ? map[tc.requirementSnapshotId] : "") ||
    (tc.sourceId ? map[tc.sourceId] : "") ||
    "";
  // Do NOT fall back to Function (tc.module) — Module entity title ≠ Function name.
  return (
    (fromMap || "").trim() ||
    (opts?.requirementTitle || "").trim() ||
    ""
  );
}

/** Only Approved (case-insensitive) — empty list if none. */
export function buildApprovedTcMarkdownFiles(
  cases: TestCase[],
  opts?: BuildApprovedTcMdOpts
): ApprovedTcMdFile[] {
  const out: ApprovedTcMdFile[] = [];
  for (const tc of cases) {
    if (String(tc.reviewStatus || "").toLowerCase() !== "approved") continue;
    const path = approvedTcMarkdownRelPath(tc);
    out.push({
      path,
      content: renderApprovedTestCaseMarkdown(tc, {
        requirementTitle: resolveRequirementTitle(tc, opts),
      }),
      testCaseId: tc.testCaseId,
    });
  }
  return out;
}

export { AI_TEST_CASES_DIR, TEST_CASES_DIR };
