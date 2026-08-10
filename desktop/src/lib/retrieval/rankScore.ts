/**
 * Shared rankScore for Unit / E2E retrieve (Phase 3).
 * Higher = more relevant to plan keywords + path shape.
 *
 * Portable: exclude / boost by path shape + token overlap — never product names.
 */
import {
  isDeniedUnitPrimaryPath,
  isWeakUnitClientPath,
  UNIT_RANK_POLICY,
} from "@aitest/ide-protocol";

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

/** Prefer backend-ish logic layers for Unit. */
export function unitPathBonus(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  let bonus = 0;
  // EF / generated — never Unit primary
  if (
    /\/migrations?\//.test(p) ||
    /\.designer\.cs$/.test(p) ||
    /\.snapshot\.cs$/.test(p) ||
    /modelsnapshot\.cs$/.test(p)
  ) {
    return -100;
  }
  if (
    /\.(service|controller|repository|repo|entity|model|dto|handler|usecase|use-case|validator|policy|command)\./.test(
      p
    ) ||
    /(handler|command|validator|usecase|policy)\.cs$/i.test(p)
  )
    bonus += 30;
  if (
    /\/(services?|controllers?|repositories?|entities|domain|application|handlers|commands|validators)\//.test(
      p
    )
  )
    bonus += 20;
  if (/\.(spec|test)\./.test(p) || /\/(__)?tests?(__)?\//.test(p)) bonus -= 40;
  if (/tests?\.cs$/.test(p) || /\/integration\//.test(p)) bonus -= 80;
  if (/\/(components?|pages?|views?|templates?|clientapp|client-app|wwwroot)\//.test(p))
    bonus -= 35;
  if (/\.(tsx|jsx|vue|html|component\.ts)$/.test(p)) bonus -= 25;
  // Align with Phase 2 thin HTTP client deny (soft demote in rank)
  if (isWeakUnitClientPath(pathRel) && !/\/(services?|application|domain|handlers?)\//.test(p)) {
    bonus -= 40;
  }
  // Infrastructure/Data without handler/service — weak Unit seed
  if (/\/data\//.test(p) && !/(handler|service|validator|repository)/.test(p)) bonus -= 25;
  return bonus;
}

/**
 * Hard-exclude from Unit retrieve — never use existing tests / E2E / generated as SUT.
 * Root cause for TC-021-style failures: Integration *Test.cs under test/ was ranked as primary.
 * Also exclude EF / ORM migration & designer artifacts (portable path shapes).
 */
export function isExcludedFromUnitRetrieve(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/aitest/") || p.includes("/.ai-test/")) return true;
  if (p.includes("/e2e/") || p.includes(".e2e/") || p.includes("e2e\\") || p.includes("/e2e\\"))
    return true;
  if (/\.e2e\./.test(p) || p.includes("/playwright")) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/support/pages/") || p.includes("/support/fixtures/")) return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/coverage/")) return true;
  if (/\.(component)\.(html|css|scss)$/.test(p)) return true;
  // Existing test projects / suites (dotnet + general) — production Unit SUT only
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p)) return true;
  if (p.includes("/integration/") || p.includes("/integrations/")) return true;
  if (/\/[^/]+\.(test|tests)(\/|$)/.test(p)) return true;
  if (/tests?\.cs$/.test(p) || /\.(tests?|spec)\.cs$/.test(p)) return true;
  // Generated DB migration / designer / snapshot artifacts (EF, similar ORMs)
  if (/(^|\/)migrations?(\/|$)/.test(p)) return true;
  if (/\.designer\.cs$/.test(p) || /\.snapshot\.cs$/.test(p) || /modelsnapshot\.cs$/.test(p))
    return true;
  return false;
}

/**
 * Hard-exclude from E2E FE retrieve — generated POM / Playwright test trees / fixtures.
 * Portable path shapes only (no product folder names).
 */
export function isExcludedFromE2eRetrieve(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/aitest/") || p.includes("/.ai-test/")) return true;
  if (p.includes("/e2etest/") || p.includes("/e2e-test/")) return true;
  // Vendor / suite Playwright trees (e.g. *.E2E/, /.e2e/, /playwright/)
  if (/\.e2e(\/|$|\.)/.test(p) || p.includes("/playwright/") || p.includes("playwright.config"))
    return true;
  if (p.includes("/support/fixtures/") || p.includes("/support/pages/")) return true;
  if (/\.fixture\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (/\.page\.(ts|tsx|js|jsx)$/.test(p) && (p.includes("/pages/") || p.includes("/_shared/")))
    return true;
  if (/\.(spec|test)\.(ts|tsx|js|jsx)$/.test(p)) return true;
  if (p.includes("/node_modules/") || p.includes("/dist/") || p.includes("/coverage/")) return true;
  if (p.includes("/fixtures/storage")) return true;
  return false;
}

/**
 * True when index primary is unsafe as Unit SUT (E2E page / pure UI / denied FE).
 */
export function isUnsuitableUnitPrimary(pathRel: string): boolean {
  return (
    isExcludedFromUnitRetrieve(pathRel) ||
    isDeniedUnitPrimaryPath(pathRel) ||
    unitPathBonus(pathRel) < 0
  );
}

/**
 * True when index primary is unsafe as E2E FE seed (generated POM / backend).
 */
export function isUnsuitableE2ePrimary(pathRel: string): boolean {
  return isExcludedFromE2eRetrieve(pathRel) || e2ePathBonus(pathRel) <= 0;
}

/**
 * Prefer FE / page paths for E2E (aligned with e2eFeRankBonus).
 */
export function e2ePathBonus(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (isExcludedFromE2eRetrieve(pathRel)) return -100;
  let bonus = 0;
  if (/\.(html|htm|cshtml|razor|vue)$/.test(p)) bonus += 40;
  if (/\.component\.(ts|html|tsx)$/.test(p)) bonus += 35;
  if (/\.(tsx|jsx)$/.test(p)) bonus += 25;
  if (/\/(pages?|views?|components?|routes?|screens?|features?)\//.test(p)) bonus += 20;
  if (/\/(create|update|edit|form|modal|dialog)\//.test(p)) bonus += 28;
  if (/\.(create|update|edit|form|modal)\./.test(p)) bonus += 22;
  if (/\/list\//.test(p) || /\.list\./.test(p)) bonus -= 8;
  if (/\/(services?|controllers?|repositories?|api\/)\//.test(p)) bonus -= 25;
  // Bare *.service.ts rarely holds locators — strong penalty unless under components/
  if (/\.service\.(ts|js)$/.test(p) && !p.includes("/components/")) bonus -= 45;
  if (/\.(controller|repository|entity)\./.test(p)) bonus -= 30;
  if (/\.(spec|test|fixture)\./.test(p)) bonus -= 40;
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

const STOP_TOKENS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "test",
  "case",
  "e2e",
  "unit",
  "step",
  "steps",
  "path",
  "module",
  "admin",
  "app",
  "src",
  "new",
  "create",
  "update",
  "edit",
  "list",
  "view",
  "detail",
  "form",
  "modal",
  "dialog",
  "page",
  "component",
  "service",
  "true",
  "false",
  "http",
  "https",
  "localhost",
]);

/**
 * Extract domain tokens from free text (module / path / latin slugs in testData).
 * Keeps latin & digit-kebab tokens ≥3 chars; skips stop words.
 */
export function extractDomainTokens(...parts: Array<string | null | undefined>): string[] {
  const blob = parts
    .map((p) => (p || "").trim())
    .filter(Boolean)
    .join("\n");
  if (!blob) return [];
  const raw = blob
    .toLowerCase()
    .replace(/[^\p{L}\p{N}/._-]+/gu, " ")
    .split(/[\s/._-]+/)
    .map((t) => t.trim())
    .filter((t) => t.length >= 3 && !/^\d+$/.test(t) && !STOP_TOKENS.has(t));
  return normalizeKeywords(raw).slice(0, 24);
}

/** True when ≥ half of tokens are ASCII slug-like (can match English FE folders). */
export function domainTokensArePathMatchable(tokens: string[]): boolean {
  if (!tokens.length) return false;
  const latin = tokens.filter((t) => /^[a-z0-9][a-z0-9-]*$/i.test(t));
  return latin.length >= Math.max(1, Math.ceil(tokens.length * 0.4));
}

/**
 * Boost when path shares domain tokens; mild penalty when matchable tokens miss entirely.
 */
export function modulePathTokenBonus(pathRel: string, domainTokens: string[]): number {
  if (!domainTokens.length) return 0;
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  const base = p.split("/").pop() || p;
  let hits = 0;
  for (const t of domainTokens) {
    if (
      p.includes(`/${t}/`) ||
      p.includes(`.${t}.`) ||
      p.includes(`/${t}.`) ||
      base.includes(t) ||
      p.endsWith(`/${t}`)
    ) {
      hits += 1;
    }
  }
  if (hits > 0) return hits * 32;
  if (domainTokensArePathMatchable(domainTokens)) return -40;
  return 0;
}

/**
 * True when hit scored on TC/plan tokens (not only FE path shape).
 * Shape-only ties sort alphabetically (e.g. case-* before evidence) and mis-seed Gen.
 */
export function hasSemanticE2eReasons(reasons: string[]): boolean {
  return reasons.some(
    (r) =>
      r.startsWith("pathKeywords") ||
      r.startsWith("symbols") ||
      r.startsWith("featurePath") ||
      /^domainTokens\+\d/.test(r)
  );
}

export function clampTopK(topK?: number): number {
  const n = topK ?? UNIT_RANK_POLICY.retrieveTopKDefault;
  return Math.min(
    UNIT_RANK_POLICY.retrieveTopKMax,
    Math.max(UNIT_RANK_POLICY.retrieveTopKMin, Math.floor(n))
  );
}
