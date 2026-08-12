/**
 * Phase C — serialize Approved TestCase → Markdown under `.ai-test/test-cases/`.
 * Artifact for Agent local / Extension Gen — includes grounding hierarchy for SUT resolve.
 *
 * Layout (separate Unit vs E2E):
 *   `.ai-test/test-cases/UnitTest/{function}/{testCaseId}.md`
 *   `.ai-test/test-cases/E2ETest/{function}/{testCaseId}.md`
 *
 * Display labels (sync MD / UI):
 *   Module   = Requirement Studio title (`requirement:`) — scopes source-module family
 *   Function = TC.module (`function:` / legacy `module:`) — ranks files inside that family
 *   Title    = TC title — refine symbol/path inside family
 */
import { AI_TEST_CASES_DIR, assertSafeAiTestCasesRel, extractTcSourceMarkers } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { TEST_CASES_DIR } from "../projectProfile/constants";
import { deriveAuthContextFromTestCase } from "../e2eWorkspace/deriveAuthContextFromTc";
import { normalizeFeaturePath } from "../e2eWorkspace/assertTcReadyForE2eGen";
import { isE2eTestCaseType } from "../testEngine";
import { GENERATED_TEST_FOLDERS } from "../testOutputLayout";

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

/** UnitTest | E2ETest under `.ai-test/test-cases/` (mirrors AItest output folders). */
export function approvedTcKindFolder(
  type?: string | null
): typeof GENERATED_TEST_FOLDERS.unit | typeof GENERATED_TEST_FOLDERS.e2e {
  return isE2eTestCaseType(type)
    ? GENERATED_TEST_FOLDERS.e2e
    : GENERATED_TEST_FOLDERS.unit;
}

/**
 * Relative path:
 * `.ai-test/test-cases/{UnitTest|E2ETest}/{function}/{testCaseId}.md`
 */
export function approvedTcMarkdownRelPath(
  tc: Pick<TestCase, "testCaseId" | "module" | "id" | "type">
): string {
  const kindSeg = approvedTcKindFolder(tc.type);
  const moduleSeg = slugSeg(tc.module || "general", "general");
  const codeSeg = slugSeg(tc.testCaseId || tc.id, tc.id.slice(0, 8));
  const rel = `${TEST_CASES_DIR}/${kindSeg}/${moduleSeg}/${codeSeg}.md`;
  return assertSafeAiTestCasesRel(rel);
}

function yamlEscape(v: string): string {
  if (/[:#\n"'\\]/.test(v) || v.trim() !== v) {
    return JSON.stringify(v);
  }
  return v;
}

export type ApprovedTcMdRenderOpts = {
  /** Owning Module title (Requirement Studio) — scopes Unit SUT / E2E before Function/Title */
  requirementTitle?: string | null;
  fallbackRole?: string | null;
  analysisActors?: string[] | null;
};

/**
 * Progressive grounding block — Extension/Desktop Unit & E2E resolve reads this.
 * Order: markers → Module (requirement) → Function (module) → title.
 * Machine keys: `requirement:` = Module; `function:` / `module:` = Function.
 */
export function parseApprovedTcGrounding(md: string | null | undefined): {
  requirement: string;
  module: string;
  title: string;
  path?: string;
  featurePath?: string;
  authRole?: string;
  authRequired?: boolean;
  landmark?: string;
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
  const authReqRaw = block("authRequired") || fm("authRequired");
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
    path: block("path") || fm("path") || undefined,
    featurePath: block("featurePath") || fm("featurePath") || undefined,
    authRole: block("authRole") || fm("authRole") || undefined,
    authRequired: authReqRaw ? authReqRaw.toLowerCase() === "true" : undefined,
    landmark: block("landmark") || fm("landmark") || undefined,
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
    "(`requirement` = Module; `function`/`module` = Function.) Primary SUT below is authoritative for Gen — do not re-resolve.",
    "",
    ...resolvedLines,
    "",
  ].join("\n");
}

export function renderE2eGroundingBlock(
  tc: Pick<TestCase, "title" | "module" | "precondition" | "steps" | "testData">,
  requirementTitle?: string | null,
  opts?: { fallbackRole?: string | null; analysisActors?: string[] | null }
): string {
  const modDoc = (requirementTitle || "").trim() || "—";
  const fn = (tc.module || "").trim() || "—";
  const title = (tc.title || "").trim() || "—";
  const auth = deriveAuthContextFromTestCase(tc, opts);
  const td = tc.testData || "";
  const pathMatch = td.match(/(?:^|\n)\s*(?:path|featurePath|feature_path|route)\s*[:=]\s*([^\n;,|]+)/i);
  const urlMatch = td.match(/(?:^|\n)\s*(?:url|baseURL|base_url)\s*[:=]\s*([^\n;,|]+)/i);
  const landmarkMatch = td.match(/(?:^|\n)\s*landmark\s*[:=]\s*([^\n;,|]+)/i);
  const path =
    normalizeFeaturePath(pathMatch?.[1]) ||
    normalizeFeaturePath(urlMatch?.[1]) ||
    "";
  const landmark = landmarkMatch?.[1]?.trim() || "";
  const skip =
    td.match(/^\s*#\s*e2e-grounding:\s*skipped\s*—\s*(.+)$/im)?.[1]?.trim() || "";

  const isLogin =
    /^(?:[a-z0-9_-]+\s*-\s*)?(?:đăng\s*nhập|login|log\s*in)$/i.test(title) ||
    /\b(public|guest|anonymous)\b/i.test([tc.precondition, td, title].join("\n"));
  const explicitAuthFalse = /authRequired\s*[:=]\s*(false|no|0)/i.test(
    [tc.precondition, td].join("\n")
  );
  const isAuthReq =
    auth.executionContext.includes("authRequired=true") ||
    (!isLogin && !explicitAuthFalse);

  const resolvedLines: string[] = ["### Resolved E2E Route & Auth", ""];
  if (path) {
    resolvedLines.push(`path: ${path}`);
  }
  if (landmark) {
    resolvedLines.push(`landmark: ${landmark}`);
  }
  if (auth.role) {
    resolvedLines.push(`authRole: ${auth.role}`);
  } else if (isAuthReq && !isLogin) {
    resolvedLines.push("authRole: _(unresolved)_ — bổ sung từ Analysis actors / Auth Discover");
  }
  if (auth.roles.length > 1) {
    resolvedLines.push(`roles: ${auth.roles.join(", ")}`);
  }
  if (isLogin && !isAuthReq) {
    resolvedLines.push(`authRequired: false`);
  } else if (isAuthReq) {
    resolvedLines.push(`authRequired: true`);
  } else {
    resolvedLines.push(`authRequired: _(unresolved)_`);
  }
  if (auth.roleSource) {
    resolvedLines.push(`roleSource: ${auth.roleSource}`);
  }
  if (!path && !landmark && !auth.role && skip) {
    resolvedLines.push(`_(unresolved)_ ${skip}`);
  } else if (!path && !landmark) {
    resolvedLines.push(
      "_(unresolved)_ — Approve chưa có path/featurePath usable (moduleMap / Output AbsolutePath)."
    );
  }

  return [
    "## Grounding (E2E Gen)",
    "",
    `requirement: ${modDoc}`,
    `module: ${fn}`,
    `function: ${fn}`,
    `title: ${title}`,
    "",
    "(`requirement` = Module; `function`/`module` = Function.) E2E route path & auth context below are authoritative for Codegen.",
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
  const tcType = (tc.type || "").trim().toUpperCase();
  const isE2e = ["E2E", "E2E_UI", "UI"].includes(tcType);
  const groundingBlock = isE2e
    ? renderE2eGroundingBlock(tc, requirementTitle, {
        fallbackRole: opts?.fallbackRole,
        analysisActors: opts?.analysisActors,
      })
    : renderUnitGroundingBlock(tc, requirementTitle);

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
    groundingBlock.trimEnd(),
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
  const groundingTag = isE2e
    ? "<!-- aitest:e2e-grounding — Route path + auth context for E2E Codegen -->"
    : "<!-- aitest:unit-grounding — Module (requirement) → Function (module) → title for SUT resolve -->";
  lines.push(
    "<!-- aitest:approved-tc-artifact — SoT Gen vẫn là DB Approved; file này đồng bộ cho Agent/IDE -->",
    groundingTag,
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
  fallbackRole?: string | null;
  analysisActors?: string[] | null;
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
        fallbackRole: opts?.fallbackRole,
        analysisActors: opts?.analysisActors,
      }),
      testCaseId: tc.testCaseId,
    });
  }
  return out;
}

export { AI_TEST_CASES_DIR, TEST_CASES_DIR };
