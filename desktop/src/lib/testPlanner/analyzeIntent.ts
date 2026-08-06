/**
 * Intent analyzer — heuristic (Phase 2). Optional slim LLM can wrap later;
 * keep pure so Unit/E2E gen + retrieve share one SoT planner.
 */
import type {
  AnalyzeIntentResult,
  PlannerRequirementInput,
  PlannerTestCaseInput,
  PlannerTestType,
} from "./types";

const PATH_MARKER_RE =
  /(?:^|[\n;,|])\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)/i;

const E2E_TYPE_RE = /\be2e\b|end[\s-]?to[\s-]?end|playwright|cypress|ui[\s-]?test/i;
const UNIT_TYPE_RE = /\bunit\b|unittest|functional(?!\s*e2e)/i;
const API_TYPE_RE = /\bapi\b|rest|graphql|http\s*test|contract/i;
const INTEGRATION_TYPE_RE = /\bintegration\b|integ\b|component[\s-]?test/i;

const UI_STEP_RE =
  /\b(click|tap|type|fill|navigate|goto|visit|open\s+page|locator|getby|data-testid|data-cy|screenshot|browser|đăng\s*nhập|nhấn|điền|mở\s+trang)\b/i;
const UNIT_STEP_RE =
  /\b(mock|stub|spy|arrange|act|assert|sut|service\.|repository\.|unittest|jest\.|vitest|pytest|xunit)\b/i;
const API_STEP_RE =
  /\b(GET|POST|PUT|PATCH|DELETE)\s+\/[^\s]+|\bstatus\s*code\b|\bjson\s*body\b|\bendpoint\b|\bswagger\b/i;
const MULTI_SERVICE_RE =
  /\b(and|và)\s+(?:the\s+)?(?:payment|inventory|user|order|auth|email|notification)\b/i;

const STOP_KEYWORDS = new Set(
  [
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "when",
    "then",
    "should",
    "must",
    "user",
    "test",
    "case",
    "step",
    "steps",
    "verify",
    "check",
    "ensure",
    "valid",
    "invalid",
    "success",
    "fail",
    "error",
    "null",
    "true",
    "false",
    "và",
    "của",
    "cho",
    "khi",
    "thì",
    "một",
    "các",
    "được",
    "không",
  ].map((s) => s.toLowerCase())
);

function blobOf(tc: PlannerTestCaseInput): string {
  return [tc.title, tc.type, tc.module, tc.precondition, tc.steps, tc.expectedResult, tc.testData]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");
}

export function extractFeaturePath(tc: PlannerTestCaseInput): string | undefined {
  const blob = [tc.testData, tc.precondition, tc.steps, tc.title]
    .map((v) => (v || "").trim())
    .filter(Boolean)
    .join("\n");
  const m = PATH_MARKER_RE.exec(blob);
  if (!m?.[1]) return undefined;
  let p = m[1].trim().replace(/^["'`]|["'`]$/g, "");
  p = p.replace(/^[a-z]+:\/\/[^/]+/i, "");
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (!p || p === "/") return undefined;
  // Reject soft-DoR / LLM placeholders mistaken as routes (path: [Thiếu Context])
  if (
    /thi[eế]u\s*context|missing\s*context|[\[\]]|featurepath\s*$/i.test(p) ||
    !/^\/[A-Za-z][\w\-./]*$/.test(p)
  ) {
    return undefined;
  }
  return p;
}

function scoreTypeFromField(typeField: string | null | undefined): {
  type: PlannerTestType | null;
  conf: number;
  reason?: string;
} {
  const t = (typeField || "").trim();
  if (!t) return { type: null, conf: 0 };
  if (E2E_TYPE_RE.test(t)) return { type: "E2E", conf: 0.95, reason: `tc.type=${t}` };
  if (API_TYPE_RE.test(t) && !/e2e/i.test(t))
    return { type: "API", conf: 0.9, reason: `tc.type=${t}` };
  if (INTEGRATION_TYPE_RE.test(t))
    return { type: "Integration", conf: 0.88, reason: `tc.type=${t}` };
  if (UNIT_TYPE_RE.test(t) || /^functional$/i.test(t))
    return { type: "Unit", conf: 0.85, reason: `tc.type=${t}` };
  return { type: null, conf: 0 };
}

function extractKeywords(
  tc: PlannerTestCaseInput,
  req?: PlannerRequirementInput | null
): string[] {
  const raw: string[] = [];
  if (tc.module?.trim()) raw.push(tc.module.trim());
  for (const f of req?.featureNames || []) {
    if (f?.trim()) raw.push(f.trim());
  }
  const text = [tc.title, tc.module, tc.steps, tc.expectedResult, req?.title, req?.summary]
    .filter(Boolean)
    .join(" ");
  // PascalCase / camel tokens + words ≥ 3
  const pascal = text.match(/\b[A-Z][a-z0-9]+(?:[A-Z][a-z0-9]+)+\b/g) || [];
  const words = text.match(/[A-Za-zÀ-ỹ_][A-Za-zÀ-ỹ0-9_]{2,}/g) || [];
  for (const p of pascal) raw.push(p);
  for (const w of words) {
    if (STOP_KEYWORDS.has(w.toLowerCase())) continue;
    if (/^\d+$/.test(w)) continue;
    raw.push(w);
  }
  const path = extractFeaturePath(tc);
  if (path) {
    for (const seg of path.split("/")) {
      if (seg.length >= 2 && !/^\d+$/.test(seg)) raw.push(seg);
    }
  }
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of raw) {
    const key = k.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(k);
    if (out.length >= 12) break;
  }
  return out;
}

function guessAction(tc: PlannerTestCaseInput, keywords: string[]): string {
  const title = (tc.title || "").trim();
  // Prefer verb+noun from title
  const m = title.match(
    /\b(create|update|delete|get|list|add|remove|login|logout|register|submit|approve|reject|pay|cancel|tạo|sửa|xóa|xem|đăng\s*nhập)\b\s+([A-Za-zÀ-ỹ0-9_\s]{2,40})/i
  );
  if (m) {
    const verb = m[1].replace(/\s+/g, "");
    const noun = m[2]
      .trim()
      .split(/\s+/)
      .slice(0, 3)
      .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
      .join("");
    const v =
      verb.charAt(0).toUpperCase() +
      verb.slice(1).replace(/\s+/g, "");
    return `${v}${noun}`.replace(/[^A-Za-z0-9]/g, "").slice(0, 48) || "Execute";
  }
  const pascal = keywords.find((k) => /[A-Z][a-z]+[A-Z]/.test(k));
  if (pascal) return pascal.slice(0, 48);
  if (tc.module?.trim()) return `${tc.module.trim()}Action`.slice(0, 48);
  return "Execute";
}

/**
 * Classify Unit | Integration | E2E | API from TC (+ optional requirement context).
 */
export function analyzeIntent(
  tc: PlannerTestCaseInput,
  req?: PlannerRequirementInput | null
): AnalyzeIntentResult {
  const reasons: string[] = [];
  const blob = blobOf(tc);
  const featurePath = extractFeaturePath(tc);
  const keywords = extractKeywords(tc, req);

  const fromType = scoreTypeFromField(tc.type);
  if (fromType.type && fromType.conf >= 0.85) {
    reasons.push(fromType.reason || "type field");
    if (featurePath) reasons.push(`path=${featurePath}`);
    return {
      testType: fromType.type,
      confidence: fromType.conf,
      reasons,
      featurePath,
      keywords,
      actionHint: guessAction(tc, keywords),
    };
  }

  let unit = 0;
  let e2e = 0;
  let api = 0;
  let integ = 0;

  if (featurePath) {
    e2e += 3;
    reasons.push(`path hint ${featurePath}`);
  }
  if (UI_STEP_RE.test(blob)) {
    e2e += 3;
    reasons.push("UI/browser steps");
  }
  if (UNIT_STEP_RE.test(blob)) {
    unit += 3;
    reasons.push("unit/mock/assert signals");
  }
  if (API_STEP_RE.test(blob)) {
    api += 3;
    reasons.push("HTTP/API signals");
  }
  if (MULTI_SERVICE_RE.test(blob) || /\b(integration|across\s+services)\b/i.test(blob)) {
    integ += 2;
    reasons.push("multi-service / integration cues");
  }
  if (/\bplaywright\b|\bpage\.|locator\(/i.test(blob)) {
    e2e += 2;
    reasons.push("playwright markers");
  }
  if (fromType.type === "Unit") unit += 2;
  if (fromType.type === "E2E") e2e += 2;
  if (fromType.type === "API") api += 2;
  if (fromType.type === "Integration") integ += 2;

  const scores: { type: PlannerTestType; n: number }[] = [
    { type: "E2E", n: e2e },
    { type: "API", n: api },
    { type: "Integration", n: integ },
    { type: "Unit", n: unit },
  ];
  scores.sort((a, b) => b.n - a.n);
  const best = scores[0];
  const second = scores[1];
  let testType: PlannerTestType = best.n > 0 ? best.type : "Unit";
  if (best.n === 0) {
    reasons.push("default Unit (no strong signal)");
  }
  // Tie-break: prefer explicit weaker type field
  if (best.n > 0 && second && best.n === second.n && fromType.type) {
    testType = fromType.type;
    reasons.push("tie-break via tc.type");
  }

  const maxScore = Math.max(best.n, 1);
  const confidence = Math.min(0.95, 0.45 + maxScore * 0.12);

  return {
    testType,
    confidence,
    reasons,
    featurePath,
    keywords,
    actionHint: guessAction(tc, keywords),
  };
}
