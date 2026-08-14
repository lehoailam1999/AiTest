/**
 * Portable Unit layerHint / sourceSignal — Approve enrich + related expand.
 * No product nouns: only parse TC markers and match type stems in index paths.
 */
import type { UnitIntent } from "./unitIntentAliases.js";
import {
  expandUnitRelatedPaths,
  featureStem,
  isValidationLayerRelatedPath,
} from "./unitRelatedExpand.js";

export type UnitLayerHint = "handler" | "dto" | "validator" | "authz";

export type UnitSourceSignal = {
  raw: string;
  /** Type/symbol before `.` — e.g. EvidenceDto from EvidenceDto.SeizureLocation */
  typeName: string | null;
  /** Member after `.` when present */
  memberName: string | null;
};

function norm(pathRel: string): string {
  return (pathRel || "").replace(/\\/g, "/");
}

function stemOf(pathRel: string): string {
  const base = norm(pathRel).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "");
}

/** Parse `layerHint: dto|validator|handler|authz` from Test Data (portable). */
export function parseUnitLayerHint(
  testData?: string | null
): UnitLayerHint | null {
  const m = String(testData || "").match(
    /\blayerHint\s*:\s*(handler|dto|validator|authz)\b/i
  );
  if (!m?.[1]) return null;
  return m[1].toLowerCase() as UnitLayerHint;
}

/** Parse `sourceSignal: Type.Member` or bare token from Test Data. */
export function parseUnitSourceSignal(
  testData?: string | null
): UnitSourceSignal | null {
  const m = String(testData || "").match(/\bsourceSignal\s*:\s*([^\n;]+)/i);
  if (!m?.[1]) return null;
  const raw = m[1].trim().replace(/\s+/g, " ");
  if (!raw) return null;
  // Take first token-ish Type.Member (stop at space / comma)
  const token = (raw.split(/[\s,|]/)[0] || "").trim();
  if (!token) return { raw, typeName: null, memberName: null };
  const dot = token.indexOf(".");
  if (dot > 0) {
    return {
      raw,
      typeName: token.slice(0, dot).trim() || null,
      memberName: token.slice(dot + 1).trim() || null,
    };
  }
  return { raw, typeName: token, memberName: null };
}

/**
 * VALIDATION / AUTH intents and explicit layerHint need DTO/Validator siblings
 * (or authz services) in the Gen packet — not Handler-only.
 */
export function preferDtoValidatorForHints(
  intent: UnitIntent | null | undefined,
  testData?: string | null
): boolean {
  const hint = parseUnitLayerHint(testData);
  if (hint === "dto" || hint === "validator" || hint === "authz") return true;
  if (!intent) return false;
  if (intent.requiresBodyRule) return true;
  const classes = intent.classes || [];
  return (
    intent.primaryClass === "validate_reject" ||
    intent.primaryClass === "state_enable" ||
    classes.includes("validate_reject") ||
    classes.includes("state_enable") ||
    (intent.featureTokens || []).some((t) =>
      /CanWrite|Permission|Authorization|IsOccupied/i.test(t)
    )
  );
}

function pathMatchesTypeName(pathRel: string, typeName: string): boolean {
  const want = typeName.trim();
  if (!want) return false;
  const stem = stemOf(pathRel);
  if (stem.toLowerCase() === want.toLowerCase()) return true;
  // FooDto ↔ Foo (rare); prefer exact stem
  return false;
}

function isAuthzLayerPath(pathRel: string): boolean {
  const p = norm(pathRel);
  const stem = stemOf(pathRel);
  return (
    /Authorization|Authorisation|CanWrite|Permission|DataScope|AccessPolicy|Policy$/i.test(
      stem
    ) ||
    /\/(authz|authorization|permissions?|policies)\//i.test(p)
  );
}

function scoreValidationCandidate(
  pathRel: string,
  entryPathRel: string | null | undefined,
  featureTokens: string[],
  typeName: string | null
): number {
  const stem = stemOf(pathRel);
  let score = 0;
  if (typeName && pathMatchesTypeName(pathRel, typeName)) score += 200;
  if (/(Validator)$/i.test(stem)) score += 90;
  else if (/(Dto|Dtos)$/i.test(stem)) score += 85;
  else if (isValidationLayerRelatedPath(pathRel)) score += 40;
  if (entryPathRel) {
    const entryFam = featureStem(stemOf(entryPathRel)).toLowerCase();
    const candFam = featureStem(stem).toLowerCase();
    if (entryFam && candFam) {
      if (entryFam === candFam) score += 40;
      else if (entryFam.startsWith(candFam) || candFam.startsWith(entryFam)) {
        score += 28;
      }
    }
  }
  for (const t of featureTokens) {
    const tl = String(t || "").toLowerCase();
    if (tl.length < 4) continue;
    if (stem.toLowerCase().includes(tl) || norm(pathRel).toLowerCase().includes(tl)) {
      score += 8;
    }
  }
  return score;
}

/**
 * When TC declares layerHint dto|validator|authz, pick a better primary than
 * a Handler that does not own the enforce site (portable).
 */
export function findLayerHintPrimaryPath(opts: {
  testData?: string | null;
  entryPathRel?: string | null;
  allPaths: string[];
  featureTokens?: string[] | null;
}): string | null {
  const hint = parseUnitLayerHint(opts.testData);
  if (!hint || hint === "handler") return null;

  const signal = parseUnitSourceSignal(opts.testData);
  const typeName = signal?.typeName || null;
  const featureTokens = (opts.featureTokens || [])
    .map((t) => String(t || "").trim())
    .filter((t) => t.length >= 3);
  const entry = opts.entryPathRel ? norm(opts.entryPathRel) : "";
  const all = [...new Set(opts.allPaths.map(norm).filter(Boolean))];

  if (hint === "authz") {
    const authz = all
      .filter(isAuthzLayerPath)
      .map((p) => ({
        p,
        score: scoreValidationCandidate(p, entry, featureTokens, typeName),
      }))
      .filter((x) => x.score >= 40)
      .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));
    if (authz[0] && authz[0].p.toLowerCase() !== entry.toLowerCase()) {
      return authz[0].p;
    }
    return null;
  }

  // dto | validator
  const pool: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    const k = p.toLowerCase();
    if (!p || seen.has(k)) return;
    if (entry && k === entry.toLowerCase()) return;
    seen.add(k);
    pool.push(p);
  };

  if (typeName) {
    for (const p of all) {
      if (pathMatchesTypeName(p, typeName) && isValidationLayerRelatedPath(p)) {
        push(p);
      }
    }
  }

  if (entry) {
    for (const p of expandUnitRelatedPaths({
      entryPathRel: entry,
      allPaths: all,
      featureTokens,
      preferDtoValidator: true,
      maxRelated: 4,
    })) {
      if (isValidationLayerRelatedPath(p)) push(p);
    }
  }

  for (const p of all) {
    if (!isValidationLayerRelatedPath(p)) continue;
    if (hint === "validator" && !/(Validator)$/i.test(stemOf(p))) continue;
    if (hint === "dto" && /(Validator)$/i.test(stemOf(p))) {
      // still allow validators as fallback for dto hint
    }
    const sc = scoreValidationCandidate(p, entry, featureTokens, typeName);
    if (sc >= 50) push(p);
  }

  const scored = pool
    .map((p) => ({
      p,
      score: scoreValidationCandidate(p, entry, featureTokens, typeName),
    }))
    .sort((a, b) => b.score - a.score || a.p.localeCompare(b.p));

  const best = scored[0];
  if (!best || best.score < 50) return null;
  // Prefer Dto/Validator stems over bare Command when layerHint is dto/validator
  const preferShape = scored.find((s) => {
    const stem = stemOf(s.p);
    if (hint === "validator") return /Validator$/i.test(stem);
    return /(Dto|Dtos|Validator)$/i.test(stem);
  });
  return (preferShape || best).p;
}

/** Swap primary → layer path; keep previous primary in related (cap 4). */
export function applyLayerHintPrimaryPromotion(opts: {
  testData?: string | null;
  primaryPath: string;
  relatedPaths: string[];
  allPaths: string[];
  featureTokens?: string[] | null;
}): { primaryPath: string; relatedPaths: string[]; promoted: boolean } {
  const promotedPath = findLayerHintPrimaryPath({
    testData: opts.testData,
    entryPathRel: opts.primaryPath,
    allPaths: opts.allPaths,
    featureTokens: opts.featureTokens,
  });
  if (
    !promotedPath ||
    promotedPath.replace(/\\/g, "/").toLowerCase() ===
      opts.primaryPath.replace(/\\/g, "/").toLowerCase()
  ) {
    return {
      primaryPath: opts.primaryPath,
      relatedPaths: opts.relatedPaths,
      promoted: false,
    };
  }
  const prev = opts.primaryPath.replace(/\\/g, "/");
  const next = promotedPath.replace(/\\/g, "/");
  const related = [
    prev,
    ...opts.relatedPaths
      .map((p) => p.replace(/\\/g, "/"))
      .filter((p) => p.toLowerCase() !== next.toLowerCase()),
  ];
  const uniqRel: string[] = [];
  const seen = new Set<string>();
  for (const p of related) {
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    uniqRel.push(p);
    if (uniqRel.length >= 4) break;
  }
  return { primaryPath: next, relatedPaths: uniqRel, promoted: true };
}
