/**
 * R9 — lightweight Spec/POM syntax gate before Playwright Verify.
 * Catches brace/paren imbalance (e.g. broken auto-heal) without running tsc.
 */

export type E2eSyntaxIssue = {
  path: string;
  detail: string;
};

function balanceError(src: string): string | null {
  let depthBrace = 0;
  let depthParen = 0;
  let inS = false;
  let inD = false;
  let inT = false;
  let inLine = false;
  let inBlock = false;
  let escape = false;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    const nxt = src[i + 1] || "";
    if (inLine) {
      if (ch === "\n") inLine = false;
      continue;
    }
    if (inBlock) {
      if (ch === "*" && nxt === "/") {
        inBlock = false;
        i++;
      }
      continue;
    }
    if (escape) {
      escape = false;
      continue;
    }
    if ((inS || inD || inT) && ch === "\\") {
      escape = true;
      continue;
    }
    if (!(inS || inD || inT)) {
      if (ch === "/" && nxt === "/") {
        inLine = true;
        i++;
        continue;
      }
      if (ch === "/" && nxt === "*") {
        inBlock = true;
        i++;
        continue;
      }
    }
    if (!inD && !inT && ch === "'") inS = !inS;
    else if (!inS && !inT && ch === '"') inD = !inD;
    else if (!inS && !inD && ch === "`") inT = !inT;
    else if (!inS && !inD && !inT) {
      if (ch === "{") depthBrace++;
      else if (ch === "}") {
        depthBrace--;
        if (depthBrace < 0) return "unmatched }";
      } else if (ch === "(") depthParen++;
      else if (ch === ")") {
        depthParen--;
        if (depthParen < 0) return "unmatched )";
      }
    }
  }
  if (depthBrace !== 0) return `brace imbalance (${depthBrace})`;
  if (depthParen !== 0) return `paren imbalance (${depthParen})`;
  return null;
}

function isE2eTsPath(path: string, kind?: string): boolean {
  const p = (path || "").replace(/\\/g, "/").toLowerCase();
  const k = (kind || "").toLowerCase();
  if (k === "spec" || k === "page") return true;
  return (
    p.includes("/specs/") ||
    p.includes("/pages/") ||
    p.endsWith(".spec.ts") ||
    p.endsWith(".page.ts")
  );
}

/**
 * Detect leftover R6 fake-heal markers in Specs.
 * POM `this.page.locator('main…').waitFor` / expectExpectedState helpers are NOT Spec BR.
 * Only bare `page.locator('main…').toBeVisible` (auto-heal inject) counts.
 */
export function hasFakeBusinessAssert(content: string): boolean {
  const t = content || "";
  if (/Business assertion \(auto-healed/i.test(t)) return true;
  // (?<!this\.) — do not flag POM this.page.locator shell helpers
  if (
    /await\s+expect\s*\(\s*[\s\S]*?(?<!this\.)page\.locator\(\s*['"]main,\s*\[role=["']main["']][\s\S]*?\)\.toBeVisible/i.test(
      t
    )
  ) {
    return true;
  }
  if (/getByText\s*\(\s*new\s+RegExp\s*\(\s*["']featurePath/i.test(t)) return true;
  return false;
}

/**
 * Return syntax / fake-assert issues for Spec+POM files.
 * Empty = OK to run Playwright.
 */
export function checkE2eArtifactsSyntax(
  files: Array<{ path: string; content?: string; kind?: string }>
): E2eSyntaxIssue[] {
  const issues: E2eSyntaxIssue[] = [];
  for (const f of files) {
    const path = (f.path || "").replace(/\\/g, "/");
    if (!isE2eTsPath(path, f.kind)) continue;
    const content = f.content || "";
    if (!content.trim()) continue;
    const bal = balanceError(content);
    if (bal) issues.push({ path, detail: `R9: ${bal}` });
    if (hasFakeBusinessAssert(content)) {
      issues.push({
        path,
        detail: "BusinessAssertionFailed: forbidden fake assert (R6)",
      });
    }
  }
  return issues;
}

export function formatE2eSyntaxGateError(issues: E2eSyntaxIssue[]): string {
  const short = issues
    .slice(0, 4)
    .map((i) => `${i.path}: ${i.detail}`)
    .join("; ");
  const hasR9 = issues.some((i) => /^R9:/.test(i.detail));
  const hasR6 = issues.some((i) => /fake assert|R6/i.test(i.detail));
  if (hasR6 && !hasR9) {
    return `BusinessAssertionFailed: E2E_GROUNDING fake assert gate (R6) — ${short}`;
  }
  if (hasR6 && hasR9) {
    return `ContextMissing: E2E_GROUNDING: syntax/fake-assert gate (R9+R6) — ${short}`;
  }
  return `ContextMissing: E2E_GROUNDING: syntax/brace gate failed (R9) — ${short}`;
}
