/**
 * Auto-fill E2E context into Test Data before/during Approve sync.
 * Portable: TC markers → moduleMap → never invent VN/module slug routes.
 */
import type { TestCase } from "../../api/types";
import { deriveAuthContextFromTestCase } from "../e2eWorkspace/deriveAuthContextFromTc";
import {
  isUsableFeaturePath,
  normalizeFeaturePath,
} from "../e2eWorkspace/assertTcReadyForE2eGen";
import { lookupModuleMapPath } from "../e2eWorkspace/generateGrounding";
import {
  featureSourcesForPath,
  isPathPlausibleForCatalog,
  matchFeaturePathFromCatalog,
  type E2eRouteCatalog,
} from "../e2eWorkspace/e2eRouteCatalog";

const AUTO_ENRICHED_E2E_RE = /#\s*auto-enriched\s*\(E2E(?: approve)?\)/i;
/** Prefer path/featurePath/route — not bare url/baseURL (those are env). */
const PATH_KV_RE =
  /(?:^|\n)\s*(?:path|featurePath|feature_path|route)\s*[:=]\s*([^\n;,|]+)/i;
const URL_KV_RE = /(?:^|\n)\s*(?:url|baseURL|base_url|targetUrl)\s*[:=]\s*([^\n;,|]+)/i;
const LANDMARK_RE = /(?:^|\n)\s*landmark\s*[:=]\s*([^\n;,|]+)/i;
const KV_RE = /^\s*([A-Za-z_][\w]*)\s*[:=]\s*(.+)$/;
const MISSING_CTX_RE = /\[(?:MISSING CONTEXT|Thiếu Context)\]/i;
const RULE_REF_RE = /\b((?:BR|FR|AC|REQ|UC)-[\w-]+)\b/i;
const LOGIN_TC_RE =
  /(?:^|\b)(?:login|logout|đăng\s*xuất|sign\s*in|public|guest|anonymous|without auth|no auth)\b/i;
const EXPLICIT_LOGIN_TITLE_RE = /^(?:[A-Za-z0-9_-]+\s*-\s*)?(?:đăng\s*nhập|login|log\s*in)$/i;
const POST_LOGIN_RE = /đã\s*đăng\s*nhập|authenticated|logged\s*in/i;
const STD_ACTION_RE =
  /^\s*(?:\d+[\).\-\s]*)?(NAVIGATE|INPUT|SELECT|CHECK|CLICK|SUBMIT|WAIT|ASSERT)\b/i;
const VAGUE_STEP_RE =
  /^\s*(?:\d+[\).\-\s]*)?(?:thực\s*hiện\s*thao\s*tác|tiếp\s*tục|kiểm\s*tra|nhập\s*thông\s*tin\s*cần\s*thiết)\s*$/i;
const INLINE_ROUTE_RE =
  /(?:^|\s)(\/(?:[A-Za-z][\w-]*\/)*[A-Za-z][\w-]*)(?:\s|$|[,;.]|\n)/;

export type E2eMarkerEnrichResult = {
  testData: string;
  steps?: string;
  enriched: boolean;
  path?: string;
  authRole?: string;
  authRequired?: boolean;
  landmark?: string;
  writeBack?: boolean;
  skipReason?: string;
};

export type E2eEnrichOpts = {
  fallbackRole?: string | null;
  analysisActors?: string[] | null;
  moduleMap?: Record<string, string> | null;
  /** Requirement Studio title — secondary moduleMap key */
  requirementTitle?: string | null;
  /** Batch-shared FE route catalog (from source, cached) */
  routeCatalog?: E2eRouteCatalog | null;
  /** Repository-learned label → code identifier aliases (portable VI↔code bridge). */
  semanticAliases?: Record<string, string | string[]> | null;
};

export function hasManualE2eSourceMarkers(testData: string | null | undefined): boolean {
  const td = testData || "";
  if (!td.trim()) return false;
  if (AUTO_ENRICHED_E2E_RE.test(td)) return false;
  const m = PATH_KV_RE.exec(td);
  return Boolean(m?.[1] && normalizeFeaturePath(m[1]));
}

export function stripAutoEnrichedE2eMarkers(testData: string): string {
  if (!AUTO_ENRICHED_E2E_RE.test(testData || "")) return (testData || "").trim();
  return (testData || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*#\s*auto-enriched\s*\(E2E(?: approve)?\)/i.test(line)) return false;
      if (
        /^\s*(?:path|featurePath|route|featureSources|scenarioType|ruleRef|postcondition|requirement|authRole|authRequired|landmark)\s*[:=]/i.test(
          line
        ) &&
        AUTO_ENRICHED_E2E_RE.test(testData)
      ) {
        return false;
      }
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

export function stripMissingContextMarkers(text: string): string {
  return (text || "")
    .split(/\r?\n/)
    .map((ln) => ln.trimEnd())
    .filter((ln) => {
      if (!ln.trim()) return false;
      if (/^\s*\[(?:MISSING CONTEXT|Thiếu Context)\]/i.test(ln)) return false;
      const m = KV_RE.exec(ln.trim());
      if (m && MISSING_CTX_RE.test(m[2] || "")) return false;
      return true;
    })
    .map((ln) => ln.replace(MISSING_CTX_RE, "").trimEnd())
    .filter((ln) => ln.trim())
    .join("\n")
    .trim();
}

/** Drop unusable path:/url: KVs (localhost origin, VN slug, placeholders). */
export function stripUnusablePathMarkers(text: string): string {
  return (text || "")
    .split(/\r?\n/)
    .filter((ln) => {
      const m = /^\s*(path|featurePath|feature_path|route|url)\s*[:=]\s*(.+)$/i.exec(ln.trim());
      if (!m) return true;
      return Boolean(normalizeFeaturePath(m[2]));
    })
    .join("\n")
    .trim();
}

/**
 * Drop path markers that no source route can back (`path: /BR-4` from a trace id).
 * Keeping them would hand Codegen a route that 404s and block re-inference.
 */
export function stripImplausiblePathMarkers(
  text: string,
  catalog?: E2eRouteCatalog | null
): string {
  if (!catalog?.routes?.length) return (text || "").trim();
  return (text || "")
    .split(/\r?\n/)
    .filter((ln) => {
      const m = /^\s*(path|featurePath|feature_path|route)\s*[:=]\s*(.+)$/i.exec(ln.trim());
      if (!m) return true;
      return isPathPlausibleForCatalog(m[2], catalog);
    })
    .join("\n")
    .trim();
}

function hasKv(testData: string, key: string): boolean {
  const k = key.toLowerCase();
  return (testData || "")
    .split(/\r?\n/)
    .some((line) => {
      const m = KV_RE.exec(line.trim());
      return Boolean(
        m && m[1].trim().toLowerCase() === k && !MISSING_CTX_RE.test(m[2] || "")
      );
    });
}

function isPureLoginTc(tc: Pick<TestCase, "title" | "precondition" | "testData" | "steps">): boolean {
  const titleStr = (tc.title || "").trim();
  if (EXPLICIT_LOGIN_TITLE_RE.test(titleStr)) return true;
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title].filter(Boolean).join("\n");
  if (POST_LOGIN_RE.test(blob)) return false;
  return LOGIN_TC_RE.test(titleStr);
}

/**
 * Resolve usable feature path only — never invent /{module-slug}.
 * Order: path/featurePath/route marker → URL pathname → inline /ascii → moduleMap
 * → route catalog (module-first match on source routes).
 */
export function inferE2eRoutePath(
  tc: Pick<TestCase, "title" | "module" | "precondition" | "steps" | "testData">,
  opts?: {
    moduleMap?: Record<string, string> | null;
    requirementTitle?: string | null;
    routeCatalog?: E2eRouteCatalog | null;
    semanticAliases?: Record<string, string | string[]> | null;
  }
): string | null {
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title].filter(Boolean).join("\n");
  const catalog = opts?.routeCatalog || null;
  /** A route from TC text counts only if source routes can back it. */
  const accept = (raw: string | null | undefined): string | null => {
    const n = normalizeFeaturePath(raw || "");
    if (!n) return null;
    return isPathPlausibleForCatalog(n, catalog) ? n : null;
  };

  const pathM = PATH_KV_RE.exec(blob);
  if (pathM?.[1]) {
    const n = accept(pathM[1]);
    if (n) return n;
  }

  const urlM = URL_KV_RE.exec(blob);
  if (urlM?.[1]) {
    const n = accept(urlM[1]);
    if (n) return n;
  }

  const routeMatch = INLINE_ROUTE_RE.exec(blob);
  if (routeMatch?.[1]) {
    const n = accept(routeMatch[1]);
    if (n) return n;
  }

  const map = opts?.moduleMap || {};
  for (const key of [tc.module, opts?.requirementTitle, tc.title]) {
    const hit = lookupModuleMapPath(key, map);
    if (hit && isUsableFeaturePath(hit)) return normalizeFeaturePath(hit);
  }

  // Source routes (routing modules) — cheap match, no Inspect
  if (opts?.routeCatalog?.routes?.length) {
    const matched = matchFeaturePathFromCatalog(tc, opts.routeCatalog, {
      requirementTitle: opts?.requirementTitle,
      semanticAliases: opts?.semanticAliases,
    });
    if (matched.path && !matched.ambiguous && isUsableFeaturePath(matched.path)) {
      return normalizeFeaturePath(matched.path);
    }
  }

  return null;
}

export function inferE2eScenarioType(
  tc: Pick<
    TestCase,
    "title" | "module" | "precondition" | "steps" | "testData" | "expectedResult" | "type"
  >
): string {
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title, tc.expectedResult, tc.type]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  if (/scenarioType\s*[:=]/i.test(blob)) return "";
  if (/phủ\s*định|negative|từ\s*chối|invalid|reject|error\s*flow|lỗi/.test(blob)) return "Negative";
  if (/biên|boundary|\bmax\b|\bmin\b|limit|giới\s*hạn/.test(blob)) return "Boundary";
  if (/validation|validate|định\s*dạng|format|required|bắt\s*buộc/.test(blob)) return "Validation";
  if (/exception|ngoại\s*lệ|timeout|crash/.test(blob)) return "Exception";
  return "Positive";
}

function inferRuleRef(
  tc: Pick<TestCase, "title" | "module" | "precondition" | "steps" | "testData">
): string | null {
  const blob = [tc.precondition, tc.testData, tc.steps, tc.title, tc.module].filter(Boolean).join("\n");
  const m = RULE_REF_RE.exec(blob);
  return m?.[1]?.toUpperCase() || null;
}

function inferPostcondition(expectedResult: string | null | undefined): string | null {
  const exp = (expectedResult || "").trim();
  if (!exp) return null;
  if (/không\s*(tạo|cập\s*nhật|xóa)|no\s+(new|update|delete)/i.test(exp)) {
    return "Không tạo/cập nhật dữ liệu mới";
  }
  return `Sau test: ${exp.slice(0, 120)}`;
}

export function normalizeE2eSteps(steps: string, expectedResult?: string | null): string {
  const rawLines = (steps || "")
    .split(/\r?\n/)
    .map((ln) => ln.trim())
    .filter(Boolean);
  if (!rawLines.length) return steps || "";
  if (rawLines.some((ln) => STD_ACTION_RE.test(ln))) return steps;

  const expFallback = (expectedResult || "Kết quả khớp Expected Result").trim();
  const out: string[] = [];
  for (let idx = 0; idx < rawLines.length; idx += 1) {
    const raw = rawLines[idx];
    if (VAGUE_STEP_RE.test(raw)) {
      out.push(raw);
      continue;
    }
    const line = raw.replace(/^\d+[\).\-\s]*/, "").trim();
    const target =
      /(?:nút|button|màn\s*hình|trang)\s+(.+)$/i.exec(line)?.[1]?.trim() || "UI element";

    let norm = "";
    if (/^(?:mở|open|goto|navigate|truy\s*cập|vào)(?:\s|$|[:/])/i.test(line)) {
      norm = `NAVIGATE Target: ${target} Expected: Màn hình/route hiển thị`;
    } else if (/^(?:nhập|điền|fill|enter|type)(?:\s|$)/i.test(line)) {
      norm = `INPUT Target: ${target} Value: theo testData Expected: Giá trị được điền`;
    } else if (/^(?:chọn|select)(?:\s|$)/i.test(line)) {
      norm = `SELECT Target: ${target} Value: theo testData Expected: Lựa chọn được áp dụng`;
    } else if (/^(?:nhấn|bấm|click)(?:\s|$)/i.test(line)) {
      norm = `CLICK Target: ${target} Expected: Thao tác được thực hiện`;
    } else if (/^(?:lưu|save|submit|gửi)(?:\s|$)/i.test(line)) {
      norm = `SUBMIT Target: ${target} Expected: ${expFallback}`;
    } else if (/^(?:kiểm\s*tra|verify|assert|xem|đảm\s*bảo)(?:\s|$)/i.test(line)) {
      norm = `ASSERT Target: ${target} Expected: ${expFallback}`;
    } else {
      out.push(raw);
      continue;
    }
    out.push(`${idx + 1}. ${norm}`);
  }
  return out.length ? out.join("\n") : steps;
}

export function enrichTcTestDataWithE2eMarkers(
  tc: TestCase,
  opts?: E2eEnrichOpts
): E2eMarkerEnrichResult {
  const tcType = (tc.type || "").trim().toUpperCase();
  if (!["E2E", "E2E_UI", "UI"].includes(tcType)) {
    return { testData: tc.testData || "", enriched: false, writeBack: false };
  }

  let existing = stripImplausiblePathMarkers(
    stripUnusablePathMarkers(stripMissingContextMarkers((tc.testData || "").trim())),
    opts?.routeCatalog
  );
  const manualPath = hasManualE2eSourceMarkers(existing);

  if (AUTO_ENRICHED_E2E_RE.test(existing)) {
    existing = stripAutoEnrichedE2eMarkers(existing);
  }

  const normalizedSteps = normalizeE2eSteps(tc.steps || "", tc.expectedResult);
  const stepsChanged = normalizedSteps !== (tc.steps || "");

  const auth = deriveAuthContextFromTestCase(tc, opts);
  const inferredPath = inferE2eRoutePath(tc, opts);
  const pureLogin = isPureLoginTc(tc);
  const blob = [tc.precondition, existing, tc.steps, tc.title].filter(Boolean).join("\n");
  const postLogin = POST_LOGIN_RE.test(blob) || Boolean(auth.role) || !pureLogin;

  const landmarkM = LANDMARK_RE.exec(existing);
  const landmark = landmarkM?.[1]?.trim() || undefined;

  const linesToAppend: string[] = [];
  if (inferredPath && !pureLogin && !manualPath) {
    linesToAppend.push(`path: ${inferredPath}`);
  }
  // Feature code behind the route — Codegen reads real templates instead of guessing.
  const featureSources = featureSourcesForPath(
    inferredPath || normalizeFeaturePath(PATH_KV_RE.exec(existing)?.[1] || ""),
    opts?.routeCatalog
  );
  if (featureSources.length && !pureLogin && !hasKv(existing, "featureSources")) {
    linesToAppend.push(`featureSources: ${featureSources.join(", ")}`);
  }
  if (auth.role && !hasKv(existing, "authRole")) {
    linesToAppend.push(`authRole: ${auth.role}`);
  }

  const explicitAuthFalse = /authRequired\s*[:=]\s*(false|no|0)/i.test(blob);
  const isAuthReq =
    auth.executionContext.includes("authRequired=true") ||
    (postLogin && !pureLogin && !explicitAuthFalse);
  if (isAuthReq && !hasKv(existing, "authRequired")) {
    linesToAppend.push(`authRequired: true`);
  }
  if (landmark) {
    linesToAppend.push(`landmark: ${landmark}`);
  }

  const scenario = inferE2eScenarioType(tc);
  if (scenario && !hasKv(existing, "scenarioType")) {
    linesToAppend.push(`scenarioType: ${scenario}`);
  }
  const ruleRef = inferRuleRef(tc);
  if (ruleRef && !hasKv(existing, "ruleRef")) {
    linesToAppend.push(`ruleRef: ${ruleRef}`);
  } else if ((tc.module || "").trim() && !hasKv(existing, "requirement")) {
    linesToAppend.push(`requirement: ${(tc.module || "").trim()}`);
  }
  const post = inferPostcondition(tc.expectedResult);
  if (post && !hasKv(existing, "postcondition")) {
    linesToAppend.push(`postcondition: ${post}`);
  }

  let next = existing;
  if (linesToAppend.length) {
    linesToAppend.push("# auto-enriched (E2E approve)");
    const block = linesToAppend.join("\n");
    next = existing ? `${existing}\n${block}` : block;
  }

  // Strip DoR soft-flags only when we have a usable path (or login/public exempt).
  const usableAfter = Boolean(
    inferredPath || normalizeFeaturePath(PATH_KV_RE.exec(next)?.[1] || "")
  );
  if (usableAfter || pureLogin) {
    next = stripMissingContextMarkers(next);
  }

  const enriched = stepsChanged || next !== (tc.testData || "").trim();
  if (!enriched) {
    return {
      testData: existing,
      steps: stepsChanged ? normalizedSteps : undefined,
      enriched: false,
      writeBack: false,
      skipReason: "No new E2E context to enrich",
    };
  }

  return {
    testData: next,
    steps: stepsChanged ? normalizedSteps : undefined,
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
  moduleMap?: Record<string, string> | null;
  requirementTitle?: string | null;
  requirementTitleByCaseKey?: Record<string, string> | null;
  routeCatalog?: E2eRouteCatalog | null;
  semanticAliases?: Record<string, string | string[]> | null;
}): Promise<{
  cases: TestCase[];
  enrichedCount: number;
}> {
  let enrichedCount = 0;
  const cases = opts.cases.map((tc) => {
    const tcType = (tc.type || "").trim().toUpperCase();
    if (!["E2E", "E2E_UI", "UI"].includes(tcType)) return tc;

    const reqTitle =
      opts.requirementTitleByCaseKey?.[tc.id] ||
      opts.requirementTitleByCaseKey?.[tc.testCaseId] ||
      opts.requirementTitle ||
      null;

    const res = enrichTcTestDataWithE2eMarkers(tc, {
      fallbackRole: opts.fallbackRole,
      analysisActors: opts.analysisActors,
      moduleMap: opts.moduleMap,
      requirementTitle: reqTitle,
      routeCatalog: opts.routeCatalog,
      semanticAliases: opts.semanticAliases,
    });
    if (res.enriched && res.writeBack) {
      enrichedCount += 1;
      return {
        ...tc,
        testData: res.testData,
        ...(res.steps ? { steps: res.steps } : {}),
      };
    }
    return tc;
  });

  return { cases, enrichedCount };
}
