/**
 * DoR gate before E2E Gen — fail-closed when TC lacks path / seed / actionable steps.
 * Login / PUBLIC TCs are exempt from path + seed (same as E2ECG grounding).
 */

const PATH_MARKER_RE =
  /(?:^|\n)\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)/i;

/** Reject LLM placeholders / soft-DoR notes mistaken as routes (e.g. path: [Thiếu Context]). */
export function isUsableFeaturePath(raw: string | null | undefined): boolean {
  const normalized = coerceToPathname(raw);
  let p = (normalized || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  // Strip trailing auto-tags / comments: "/admin/x [auto:fe]" or "/admin/x # note"
  p = p.replace(/\s*[\[(#].*$/, "").trim();
  if (!p || p === "/") return false;
  const low = p.toLowerCase().replace(/\\/g, "/");
  if (/thi[eế]u\s*context|missing\s*context|\[thi[eế]u|todo|tbd|n\/a|null|undefined/i.test(low)) {
    return false;
  }
  if (/[\[\]{}]|featurepath\s*$/i.test(low)) return false;
  if (/^(login|signin|sign-in|auth|register)$/i.test(low.replace(/^\//, ""))) return false;
  // Must look like a real UI path segment (ASCII letters only — rejects VN slug invent)
  if (!/^\/?[A-Za-z][\w\-./]*$/.test(p.replace(/\s/g, ""))) return false;
  return true;
}

/** http(s)://host/foo → /foo; bare origin → "" (not a feature path). */
export function coerceToPathname(raw: string | null | undefined): string {
  let p = (raw || "").trim().replace(/^["'`]+|["'`]+$/g, "");
  if (!p) return "";
  if (/^https?:\/\//i.test(p)) {
    try {
      const u = new URL(p);
      p = u.pathname || "";
    } catch {
      return "";
    }
  }
  return p;
}

/** Normalize raw path capture for storage / compare. */
export function normalizeFeaturePath(raw: string | null | undefined): string {
  let p = coerceToPathname(raw);
  p = p.replace(/\s*[\[(#].*$/, "").trim();
  if (!p) return "";
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return isUsableFeaturePath(p) ? p : "";
}

const EXPECTED_OUTCOME_RE =
  /(?:expectedOutcome|expected\s*result|expected|kết\s*quả\s*mong\s*đợi)\s*[:=]/i;

const PATH_ONLY_KEYS =
  /^(path|route|url|featurePath|feature_path|authRole|auth_role|role|roles|authRequired|auth_required|landmark|multiRole|trace)$/i;

/** Vague-only steps — no concrete control / data. */
const VAGUE_STEP_RE =
  /^(?:\d+[\).\]]?\s*)?(?:kiểm\s*tra|verify|check|assert|xem|đảm\s*bảo|ensure|validate)\b/i;

/** Actionable: verb + object/control/data signal. */
const ACTIONABLE_STEP_RE =
  /(?:nhấn|bấm|click|chọn|select|điền|fill|nhập|type|enter|mở|open|tạo|create|thêm|add|xóa|delete|upload|lưu|save|submit|goto|navigate|đăng\s*nhập|login)\b/i;

export type TcReadyInput = {
  title?: string | null;
  module?: string | null;
  precondition?: string | null;
  testData?: string | null;
  steps?: string | null;
  expectedResult?: string | null;
  type?: string | null;
};

function tcTextBlob(tc: TcReadyInput): string {
  return [tc.precondition, tc.testData, tc.steps, tc.title, tc.expectedResult, tc.module]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");
}

export type TcReadyAssertOptions = {
  /** Route inferred from FE source / Code Index — counts as path when allowInferredPath */
  inferredFeaturePath?: string | null;
  /** Allow inferred path (not yet in testData) to satisfy DoR path requirement */
  allowInferredPath?: boolean;
};

export type E2EProfileGateInput = {
  runner?: string | null;
  authStrategy?: string | null;
};

/** Sprint 3 gate hints — warning only, does not block generation. */
export function profileGateWarningsForE2eGen(input: E2EProfileGateInput): string[] {
  const warns: string[] = [];
  const runner = (input.runner || "").trim().toLowerCase();
  const authStrategy = (input.authStrategy || "").trim().toLowerCase();
  if (!runner || runner === "unknown") {
    warns.push("profile runner missing/unknown");
  }
  if (!authStrategy) {
    warns.push("profile auth.strategy missing");
  }
  return warns;
}

/** Append featurePath to testData when TC has no usable path marker (in-memory enrich for Gen). */
export function enrichTestDataWithFeaturePath(
  testData: string | null | undefined,
  featurePath: string,
  sourceNote = "FE source"
): string {
  const path = normalizeFeaturePath(featurePath);
  if (!path) return (testData || "").trim();
  if (hasPathMarker({ testData })) return (testData || "").trim();
  // Drop unusable path:/ placeholders (e.g. path: [Thiếu Context]) so LLM sees one real route
  const cleaned = stripUnusablePathMarkers(testData || "");
  const line = `featurePath: ${path}`;
  const note = `# auto-enriched from ${sourceNote}`;
  const td = cleaned.trim();
  return td ? `${td}\n${line}\n${note}` : `${line}\n${note}`;
}

/** Remove path/route lines whose value is a DoR placeholder, not a real UI path. */
export function stripUnusablePathMarkers(testData: string): string {
  return (testData || "")
    .split(/\r?\n/)
    .filter((line) => {
      const m = /^(?:\s*)(?:path|route|url|featurePath|feature_path)\s*[:=]\s*(.+)$/i.exec(
        line
      );
      if (!m) return true;
      return Boolean(normalizeFeaturePath(m[1]));
    })
    .join("\n");
}

export function mergeTcWithInferredFeaturePath(
  tc: TcReadyInput,
  featurePath: string | undefined,
  sourceNote = "FE source"
): TcReadyInput {
  const path = normalizeFeaturePath(featurePath);
  if (!path || hasPathMarker(tc)) {
    // Still strip unusable path: placeholders so Gen/API never see them
    if (!path) {
      const cleaned = stripUnusablePathMarkers(tc.testData || "");
      if (cleaned === (tc.testData || "")) return tc;
      return { ...tc, testData: cleaned };
    }
    return tc;
  }
  return {
    ...tc,
    testData: enrichTestDataWithFeaturePath(tc.testData, path, sourceNote),
  };
}

const AUTH_ROLE_MARKER_RE =
  /(?:^|\n)\s*(?:authRole|auth_role|role)\s*[:=]\s*([^\n;,|]+)/i;

export function hasAuthRoleMarker(tc: TcReadyInput): boolean {
  const m = AUTH_ROLE_MARKER_RE.exec(tcTextBlob(tc));
  const role = m?.[1]?.trim().replace(/^["']|["']$/g, "") || "";
  return Boolean(role) && !/thi[eế]u\s*context|tbd|n\/a|todo/i.test(role);
}

/** Append authRole to testData when TC has no role marker (in-memory enrich for Gen). */
export function enrichTestDataWithAuthRole(
  testData: string | null | undefined,
  authRole: string,
  sourceNote = "project default"
): string {
  const role = (authRole || "").trim().replace(/^["']|["']$/g, "");
  if (!role) return (testData || "").trim();
  if (hasAuthRoleMarker({ testData })) return (testData || "").trim();
  const line = `authRole: ${role}`;
  const note = `# auto-enriched role from ${sourceNote}`;
  const td = (testData || "").trim();
  return td ? `${td}\n${line}\n${note}` : `${line}\n${note}`;
}

export function mergeTcWithAuthRole(
  tc: TcReadyInput,
  authRole: string | undefined,
  sourceNote = "project default"
): TcReadyInput {
  const role = (authRole || "").trim();
  if (!role || hasAuthRoleMarker(tc)) return tc;
  return {
    ...tc,
    testData: enrichTestDataWithAuthRole(tc.testData, role, sourceNote),
  };
}

export function isLoginOrPublicTc(tc: TcReadyInput): boolean {
  const blob = `${tc.title || ""}\n${tc.precondition || ""}\n${tc.steps || ""}\n${tc.testData || ""}`;
  if (/login|log\s*in|đăng\s*nhập|sign\s*in|logout|đăng\s*xuất/i.test(blob)) return true;
  if (
    /public|guest|anonymous|không cần đăng nhập|không đăng nhập|without auth|no auth/i.test(
      blob
    )
  ) {
    return true;
  }
  return false;
}

export function hasPathMarker(tc: TcReadyInput): boolean {
  const blob = tcTextBlob(tc);
  const m = PATH_MARKER_RE.exec(blob);
  if (!m?.[1]?.trim()) return false;
  return Boolean(normalizeFeaturePath(m[1]));
}

export function hasExpectedOutcome(tc: TcReadyInput): boolean {
  if ((tc.expectedResult || "").trim().length >= 8) return true;
  const blob = tcTextBlob(tc);
  if (EXPECTED_OUTCOME_RE.test(blob)) return true;
  // Separate expected section common in TC dumps
  if (/^\s*expected\s*[:=]/im.test(blob)) return true;
  return false;
}

/** testData key=value seeds other than path/auth meta. */
export function hasTestDataSeed(tc: TcReadyInput): boolean {
  const td = (tc.testData || "").trim();
  if (!td) return false;
  for (const line of td.split(/\r?\n/)) {
    const m = /^\s*([A-Za-z_][\w-]*)\s*[:=]\s*(.+)$/.exec(line);
    if (!m) continue;
    const key = m[1];
    const val = m[2].trim().replace(/^["']|["']$/g, "");
    if (!val || PATH_ONLY_KEYS.test(key)) continue;
    return true;
  }
  return false;
}

export function hasActionableStep(tc: TcReadyInput): boolean {
  const steps = (tc.steps || "").trim();
  if (!steps) return false;
  const lines = steps
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
  let actionable = 0;
  for (const line of lines) {
    if (ACTIONABLE_STEP_RE.test(line) && !isVagueOnlyStep(line)) {
      actionable += 1;
    }
  }
  return actionable >= 1;
}

function isVagueOnlyStep(line: string): boolean {
  const cleaned = line.replace(/^\d+[\).\]]?\s*/, "").trim();
  if (!VAGUE_STEP_RE.test(cleaned)) return false;
  // Vague verb but still names a control/data → count as actionable
  if (
    /(?:nút|button|ô|field|input|dropdown|menu|tab|link|checkbox|dialog|modal|testid|data-cy)\b/i.test(
      cleaned
    )
  ) {
    return false;
  }
  // Only generic "kiểm tra kết quả / màn hình" without target
  return !ACTIONABLE_STEP_RE.test(cleaned);
}

function hasPathEvidence(
  tc: TcReadyInput,
  opts?: TcReadyAssertOptions
): boolean {
  if (hasPathMarker(tc)) return true;
  if (!opts?.allowInferredPath) return false;
  return Boolean(normalizeFeaturePath(opts.inferredFeaturePath));
}

/**
 * Throws E2E_GROUNDING error when TC is too thin for Gen.
 * Call after FE resolve when possible — inferredFeaturePath from source may satisfy path.
 */
export function assertTcReadyForE2eGen(
  tc: TcReadyInput,
  opts?: TcReadyAssertOptions
): void {
  if (isLoginOrPublicTc(tc)) return;

  const missing: string[] = [];
  if (!hasPathEvidence(tc, opts)) {
    missing.push("path:/featurePath: trong testData");
  }
  const hasBody =
    hasExpectedOutcome(tc) || hasTestDataSeed(tc) || hasActionableStep(tc);
  if (!hasBody) {
    missing.push(
      "expectedOutcome hoặc testData seed (entity) hoặc ≥1 step hành động+đối tượng (không chỉ «kiểm tra»)"
    );
  }
  if (!missing.length) return;
  throw new Error(
    "E2E_GROUNDING: [Thiếu Context] " +
      missing.join("; ") +
      ". Bổ sung TC trước khi Generate — không Gen mù từ step chung chung."
  );
}
