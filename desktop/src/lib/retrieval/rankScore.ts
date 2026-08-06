/**
 * Shared rankScore for Unit / E2E retrieve (Phase 3).
 * Higher = more relevant to plan keywords + path shape.
 */

export function normalizeKeywords(keywords: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const k of keywords) {
    const t = k.trim().toLowerCase();
    if (t.length < 2 || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

/** Keyword hits in path segments / filename. */
export function pathKeywordScore(pathRel: string, keywords: string[]): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop() || p;
  let score = 0;
  for (const k of keywords) {
    if (base.includes(k)) score += 25;
    else if (p.includes(`/${k}/`) || p.includes(`.${k}.`) || p.includes(`/${k}.`)) score += 18;
    else if (p.includes(k)) score += 8;
  }
  return score;
}

/** Keyword hits against symbol names in a file. */
export function symbolKeywordScore(symbolNames: string[], keywords: string[]): number {
  if (!symbolNames.length || !keywords.length) return 0;
  const lower = symbolNames.map((s) => s.toLowerCase());
  let score = 0;
  for (const k of keywords) {
    for (const s of lower) {
      if (s === k) score += 40;
      else if (s.includes(k) || k.includes(s)) score += 15;
    }
  }
  return score;
}

/** Prefer backend-ish paths for Unit. */
export function unitPathBonus(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let bonus = 0;
  if (/\.(service|controller|repository|repo|entity|model|dto|handler|usecase|use-case)\./.test(p))
    bonus += 30;
  if (/\/(services?|controllers?|repositories?|entities|domain|application)\//.test(p)) bonus += 20;
  if (/\.(spec|test)\./.test(p) || /\/(__)?tests?(__)?\//.test(p)) bonus -= 40;
  if (/\/(components?|pages?|views?|templates?)\//.test(p)) bonus -= 15;
  if (/\.(tsx|jsx|vue|html)$/.test(p) && !/\.service\./.test(p)) bonus -= 10;
  return bonus;
}

/**
 * Hard-exclude from Unit retrieve — E2E/POM/spec/generated noise.
 * Fixes Forensic-style false hits (evidence.page.ts scoring above real SUT).
 */
export function isExcludedFromUnitRetrieve(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/aitest/") || p.includes("/.ai-test/")) return true;
  if (p.includes("/e2e/") || p.includes(".e2e/") || p.includes("e2e\\") || p.includes("/e2e\\"))
    return true;
  if (/\.e2e\./.test(p) || p.includes("forensic.e2e") || p.includes("/playwright")) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/support/pages/") || p.includes("/support/fixtures/")) return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/coverage/")) return true;
  // Pure UI shells — not unit SUT
  if (/\.(component)\.(html|css|scss)$/.test(p)) return true;
  return false;
}

/**
 * Hard-exclude from E2E FE retrieve — generated POM/spec must not ground codegen.
 * Without this, re-gen picks AItest/E2ETest pages (*.page.ts) as "FE source".
 */
export function isExcludedFromE2eRetrieve(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/aitest/") || p.includes("/.ai-test/")) return true;
  if (p.includes("/e2etest/") || p.includes("/e2e-test/")) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p) && (p.includes("/pages/") || p.includes("/_shared/")))
    return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/coverage/")) return true;
  if (p.includes("playwright.config") || p.includes("/fixtures/storage")) return true;
  return false;
}

/**
 * True when index primary is unsafe as Unit SUT (E2E page / pure UI).
 * Callers should fall back to legacy scope.
 */
export function isUnsuitableUnitPrimary(pathRel: string): boolean {
  return isExcludedFromUnitRetrieve(pathRel) || unitPathBonus(pathRel) < 0;
}

/**
 * True when index primary is unsafe as E2E FE seed (generated POM / backend).
 */
export function isUnsuitableE2ePrimary(pathRel: string): boolean {
  return isExcludedFromE2eRetrieve(pathRel) || e2ePathBonus(pathRel) <= 0;
}

/**
 * Prefer FE / page paths for E2E (aligned with e2eFeRankBonus).
 * Exported for E2eRetriever + tests.
 */
export function e2ePathBonus(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  // Generated / test noise — never boost
  if (isExcludedFromE2eRetrieve(pathRel)) return -100;
  let bonus = 0;
  if (/\.(html|htm|cshtml|razor|vue)$/.test(p)) bonus += 40;
  if (/\.component\.(ts|html|tsx)$/.test(p)) bonus += 35;
  if (/\.(tsx|jsx)$/.test(p)) bonus += 25;
  if (/\/(pages?|views?|components?|routes?|screens?|features?)\//.test(p)) bonus += 20;
  // Form surfaces beat list shells for TC Act grounding
  if (/\/(create|update|edit|form|modal|dialog)\//.test(p)) bonus += 28;
  if (/\.(create|update|edit|form|modal)\./.test(p)) bonus += 22;
  if (/\/list\//.test(p) || /\.list\./.test(p)) bonus -= 8;
  if (/\/(services?|controllers?|repositories?|api\/)\//.test(p)) bonus -= 25;
  if (/\.(service|controller|repository|entity)\./.test(p)) bonus -= 30;
  if (/\.(spec|test)\./.test(p)) bonus -= 40;
  if (p.includes("vite.config") || p.includes("main.tsx") || p.endsWith("main.ts")) bonus -= 20;
  return bonus;
}

/** Route/path hint tokens from planner (e.g. /checkout → checkout). */
export function featurePathTokenBonus(pathRel: string, featurePath?: string | null): number {
  if (!featurePath) return 0;
  const tokens = featurePath
    .split("/")
    .map((s) => s.trim().toLowerCase())
    .filter((s) => s.length >= 2 && !/^\d+$/.test(s));
  if (!tokens.length) return 0;
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (p.includes(`/${t}/`) || p.includes(`.${t}.`) || p.includes(`/${t}.`) || p.includes(t)) {
      score += 22;
    }
  }
  if (score > 0 && /routes?|router|navigation|pages?/.test(p)) score += 10;
  return score;
}

export function clampTopK(topK?: number): number {
  const n = topK ?? 8;
  return Math.min(10, Math.max(5, Math.floor(n)));
}
