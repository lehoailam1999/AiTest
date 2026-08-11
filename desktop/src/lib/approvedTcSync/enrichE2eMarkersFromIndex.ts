/**
 * Auto-fill path:/featurePath: and authRole: into Approved E2E TC Test Data upon Approval.
 * Mirrors enrichUnitMarkersFromIndex for E2E Test Cases.
 */
import type { TestCase } from "../../api/types";
import { deriveAuthContextFromTestCase } from "../e2eWorkspace/deriveAuthContextFromTc";

const AUTO_ENRICHED_E2E_RE = /#\s*auto-enriched\s*\(E2E\)/i;
const PATH_MARKER_RE = /(?:^|\n)\s*(?:path|featurePath|route|url)\s*[:=]\s*([^\s\n;,|]+)/i;
const LANDMARK_RE = /(?:^|\n)\s*landmark\s*[:=]\s*([^\n;,|]+)/i;
const LOGIN_TC_RE =
  /(?:^|\b)(?:login|logout|đăng\s*xuất|sign\s*in|public|guest|anonymous|without auth|no auth)\b/i;
const EXPLICIT_LOGIN_TITLE_RE = /^(?:[A-Za-z0-9_-]+\s*-\s*)?(?:đăng\s*nhập|login|log\s*in)$/i;

export type E2eMarkerEnrichResult = {
  testData: string;
  enriched: boolean;
  path?: string;
  authRole?: string;
  authRequired?: boolean;
  landmark?: string;
  writeBack?: boolean;
  skipReason?: string;
};

export function hasManualE2eSourceMarkers(testData: string | null | undefined): boolean {
  const td = testData || "";
  if (!td.trim()) return false;
  if (PATH_MARKER_RE.test(td) && !AUTO_ENRICHED_E2E_RE.test(td)) return true;
  return false;
}

export function stripAutoEnrichedE2eMarkers(testData: string): string {
  if (!AUTO_ENRICHED_E2E_RE.test(testData || "")) return (testData || "").trim();
  return (testData || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*#\s*auto-enriched\s*\(E2E\)/i.test(line)) return false;
      if (/^\s*(?:path|featurePath|route)\s*[:=]/i.test(line) && AUTO_ENRICHED_E2E_RE.test(testData)) return false;
      if (/^\s*(?:authRole|authRequired|landmark)\s*[:=]/i.test(line) && AUTO_ENRICHED_E2E_RE.test(testData)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function slugPathSegment(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/[\\/:*?"<>|]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Infer route path from TC text or module/title when path is not explicitly set.
 */
export function inferE2eRoutePath(tc: Pick<TestCase, "title" | "module" | "precondition" | "steps" | "testData">): string | null {
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title].filter(Boolean).join("\n");
  const m = PATH_MARKER_RE.exec(blob);
  if (m?.[1] && m[1].trim() !== "/") {
    const raw = m[1].trim().replace(/^["']|["']$/g, "");
    return raw.startsWith("/") ? raw : `/${raw}`;
  }

  // Look for inline path patterns e.g. /admin/users or /dashboard or /vats-chung in steps/precondition
  const routeMatch = blob.match(/(?:^|\s)(\/(?:[a-zA-Z0-9_-]+\/)*[a-zA-Z0-9_-]+)(?:\s|$|[,;.]|\n)/);
  if (routeMatch && !routeMatch[1].startsWith("//") && !routeMatch[1].includes("http")) {
    return routeMatch[1];
  }

  // Derive route from module or title if post-login
  const modSlug = slugPathSegment(tc.module || tc.title || "");
  if (modSlug && modSlug !== "general" && modSlug !== "default") {
    return `/${modSlug}`;
  }

  return null;
}

export function enrichTcTestDataWithE2eMarkers(
  tc: TestCase,
  opts?: {
    fallbackRole?: string | null;
    analysisActors?: string[] | null;
  }
): E2eMarkerEnrichResult {
  const tcType = (tc.type || "").trim().toUpperCase();
  if (!["E2E", "E2E_UI", "UI"].includes(tcType)) {
    return { testData: tc.testData || "", enriched: false, writeBack: false };
  }

  let existing = (tc.testData || "").trim();
  if (hasManualE2eSourceMarkers(existing)) {
    return { testData: existing, enriched: false, writeBack: false };
  }

  if (AUTO_ENRICHED_E2E_RE.test(existing)) {
    existing = stripAutoEnrichedE2eMarkers(existing);
  }

  const auth = deriveAuthContextFromTestCase(tc, opts);
  const inferredPath = inferE2eRoutePath(tc);
  const titleStr = (tc.title || "").trim();
  const isPureLoginTc = LOGIN_TC_RE.test(titleStr) || EXPLICIT_LOGIN_TITLE_RE.test(titleStr);

  const landmarkM = LANDMARK_RE.exec(existing);
  const landmark = landmarkM?.[1]?.trim() || undefined;

  const linesToAppend: string[] = [];
  if (inferredPath && !isPureLoginTc) {
    linesToAppend.push(`path: ${inferredPath}`);
  }
  if (auth.role) {
    linesToAppend.push(`authRole: ${auth.role}`);
  }
  const isAuthReq = auth.executionContext.includes("authRequired=true");
  if (isAuthReq) {
    linesToAppend.push(`authRequired: true`);
  }
  if (landmark) {
    linesToAppend.push(`landmark: ${landmark}`);
  }

  if (!linesToAppend.length) {
    return {
      testData: existing,
      enriched: false,
      writeBack: false,
      skipReason: "No new E2E path or auth signals to enrich",
    };
  }

  linesToAppend.push("# auto-enriched (E2E)");
  const block = linesToAppend.join("\n");
  const next = existing ? `${existing}\n${block}` : block;

  return {
    testData: next,
    enriched: true,
    path: inferredPath || undefined,
    authRole: auth.role,
    authRequired: isAuthReq,
    landmark,
    writeBack: true,
  };
}

export async function enrichApprovedCasesWithE2eMarkers(opts: {
  cases: TestCase[];
  fallbackRole?: string | null;
  analysisActors?: string[] | null;
}): Promise<{
  cases: TestCase[];
  enrichedCount: number;
}> {
  let enrichedCount = 0;
  const cases = opts.cases.map((tc) => {
    const tcType = (tc.type || "").trim().toUpperCase();
    if (!["E2E", "E2E_UI", "UI"].includes(tcType)) return tc;

    const res = enrichTcTestDataWithE2eMarkers(tc, opts);
    if (res.enriched && res.writeBack) {
      enrichedCount += 1;
      return { ...tc, testData: res.testData };
    }
    return tc;
  });

  return { cases, enrichedCount };
}
