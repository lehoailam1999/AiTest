/**
 * P0 / P0.1 hard gate before Unit Gen AI CLI — portable (no product hardcoding).
 */
import type { CodeAliasMap } from "./viCodeAliases.js";
import {
  extractTcSourceMarkers,
  isPacketSutAcceptable,
  isSutAlignedEnough,
  sutDomainConflict,
  sutTcAlignmentScore,
  unitSutAlignMin,
} from "./unitGenGuards.js";
import {
  primaryMatchesMarkers,
} from "./unitPrimaryPrefer.js";
import {
  isAnemicEntityLikePath,
  tcImpliesBehaviorPrimary,
} from "./unitLogicLayerFilter.js";
import { parseUnitLayerHint } from "./unitLayerHint.js";
import {
  extractUnitIntent,
  type UnitIntentClass,
} from "./unitIntentAliases.js";
import { behaviorEvidenceInExcerpt } from "./behaviorEvidenceInExcerpt.js";

export type UnitSutRefuseCode =
  | "FAIL_NEEDS_MARKER"
  | "FAIL_DOMAIN_GUARD"
  | "FAIL_SUT_MISMATCH"
  | "FAIL_FEATURE_GAP";

export type UnitDomainGuardRule = {
  whenModuleMatches?: string;
  allowPathContains?: string[];
  denyPathContains?: string[];
};

export type UnitSutGateCandidate = {
  path: string;
  score?: number;
  reason?: string;
};

/** Profile unit.scope — default backend for Unit Gen. */
export type UnitGenScope = "backend" | "frontend" | "any";

export type UnitSutGateResult = {
  decision: "gen" | "block";
  code?: UnitSutRefuseCode;
  reason: string;
  alignmentScore: number;
  markersHit: number;
  domainGuard: "pass" | "fail" | "skip";
  resolvedSut: string | "unresolved";
  featureGap?: string | null;
  /** Debug — primary intent class from TC. */
  intentClass?: UnitIntentClass | null;
  /** Debug — intent classes matched. */
  intentClasses?: UnitIntentClass[];
  /** Debug — min alignment floor applied. */
  minAlignment?: number;
};

/**
 * When TC has no path:/code: markers, require this alignment floor (stricter than
 * UNIT_SUT_ALIGN_MIN_NO_MARKER) unless profile requireMarkers forces FAIL_NEEDS_MARKER.
 */
export const UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT = 8;

/**
 * Absolute Gen floor (default) — alignment &lt; this never reaches CLI.
 * Override per-repo via profile `unit.minAlignment`.
 */
export const UNIT_SUT_ALIGN_HARD_FLOOR = 50;

/** Default Unit Gen scope when profile omits unit.scope. */
export const UNIT_GEN_SCOPE_DEFAULT: UnitGenScope = "backend";

/** IT verbs that must not alone win path rank / gate. */
export const UNIT_WEAK_COMMON_PATH_TOKENS = new Set([
  "create",
  "update",
  "delete",
  "upload",
  "download",
  "unit",
  "command",
  "handler",
  "service",
  "query",
  "get",
  "list",
  "add",
  "edit",
  "form",
  "new",
  "save",
  "async",
  "handle",
  "account",
  "user",
  "data",
  "item",
  "type",
  "info",
]);

/**
 * Tokens dropped from Module/Title/Requirement path scoring.
 * Narrower than basename penalty — keep Upload/MaxFileSize as intent rank signals.
 */
export const UNIT_WEAK_RANK_TOKENS = new Set([
  "create",
  "update",
  "delete",
  "add",
  "new",
  "edit",
  "form",
  "unit",
  "command",
  "handler",
  "service",
  "query",
  "get",
  "list",
  "save",
  "async",
  "handle",
  "account",
  "user",
  "data",
  "item",
  "type",
  "info",
  // Generic VI «kiểm/tìm» → Check/Search must not alone latch *Check*Query over *CommandHandler
  "check",
  "search",
]);

/** True when token is too generic to drive SUT path rank alone. */
export function isWeakUnitRankToken(token: string): boolean {
  const t = String(token || "").trim().toLowerCase();
  if (!t || t.length < 4) return true;
  return UNIT_WEAK_RANK_TOKENS.has(t);
}

/** Drop weak IT verbs from rank token lists (portable anti-AccountCreate latch). */
export function filterStrongRankTokens(tokens: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of tokens || []) {
    const t = String(raw || "").trim();
    if (!t || isWeakUnitRankToken(t)) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/**
 * Portable feature intents: if TC implies capability X, excerpt must mention related tokens.
 * Keep cues tight — avoid false hits from policy docs («BR / malware / validation»).
 */
const FEATURE_GAP_CHECKS: Array<{
  label: string;
  tcRe: RegExp;
  excerptRe: RegExp;
}> = [
  {
    label: "malware/antivirus",
    // Require real scenario cues — not the word "malware" inside unit-conventions examples.
    tcRe:
      /\bmalware\b|\bantivirus\b|\banti[\s-]?virus\b|\bmã\s*độc\b|\bma[\s-]+doc\b|\bquét\s*mã\s*độc\b|\bvirus\s*scan\b/i,
    excerptRe: /malware|antivirus|virus|scan|threat|clam|defender/i,
  },
  {
    label: "uniqueness/duplicate",
    tcRe: /trùng|duplicate|unique|duy\s*nhất|đã\s*tồn\s*tại|already\s*exist|\bexists\b/i,
    excerptRe:
      /unique|duplicate|exists|already|trùng|Duplicate|IsUnique|AnyAsync|FirstOrDefault|conflict|Conflict/i,
  },
  {
    label: "permission/authorization",
    tcRe: /phân\s*quyền|permission|authorization|forbidden|không\s*được\s*phép|access\s*denied/i,
    excerptRe: /permission|authorize|authorization|forbid|policy|role|claim|AccessDenied/i,
  },
  {
    label: "reject-validation",
    tcRe:
      /từ\s*chối|tu\s*choi|\breject(ed|ion)?\b|\bdeny\b|không\s*cho\s*phép|khong\s*cho\s*phep|bị\s*từ/i,
    // Property name alone (IsOccupied) is not reject logic — need throw/guard
    excerptRe:
      /throw|ArgumentException|BadRequest|InvalidOperation|Reject|Deny|Forbidden|return\s+false|Can[A-Z]|Validate|if\s*\([^)]*IsOccupied|IsOccupied\s*==\s*true/i,
  },
  {
    label: "enable-disable-state",
    tcRe: /\bdisable\b|\benable\b|ngăn\s*trống|ngan\s*trong|đã\s*chứa|da\s*chua/i,
    excerptRe:
      /IsOccupied|Enable|Disable|CanSelect|IsEnabled|IsDisabled|filter|Where\(|Any\(/i,
  },
];

/**
 * Strip policy / conventions dumps so feature-gap does not latch onto wording
 * inside `.ai-test/unit-conventions.md` examples (e.g. «BR / malware / validation»).
 */
export function scenarioTextForFeatureGap(tcText: string): string {
  let t = tcText || "";
  t = t.replace(
    /##\s*Project rules[\s\S]*?(?=##\s*(?:Approved|Request|Source|Related)|\z)/gi,
    "\n"
  );
  t = t.replace(
    /#\s*Unit test conventions[\s\S]*?(?=##\s|\z)/gi,
    "\n"
  );
  t = t
    .split("\n")
    .filter(
      (line) =>
        !/BR\s*\/\s*malware|malware\s*\/\s*validation|e\.g\.\s*antivirus|FAIL_FEATURE_GAP|authoritative policy SoT/i.test(
          line
        )
    )
    .join("\n");
  return t;
}

export function detectFeatureGap(
  tcText: string,
  sourceExcerpt: string
): { gap: boolean; label?: string } {
  const tc = scenarioTextForFeatureGap(tcText);
  const ex = sourceExcerpt || "";
  if (!tc.trim() || !ex.trim()) return { gap: false };
  for (const c of FEATURE_GAP_CHECKS) {
    if (c.tcRe.test(tc) && !c.excerptRe.test(ex)) {
      return { gap: true, label: c.label };
    }
  }
  return { gap: false };
}

/** Match optional profile unit.domainGuards against module + path (portable). */
export function applyProfileDomainGuards(opts: {
  moduleText: string;
  primaryPath: string;
  rules?: UnitDomainGuardRule[] | null;
}): { pass: boolean; reason?: string } {
  const rules = opts.rules || [];
  if (!rules.length || !opts.primaryPath?.trim()) {
    return { pass: true };
  }
  const pathNorm = opts.primaryPath.replace(/\\/g, "/");
  const moduleText = opts.moduleText || "";
  for (const rule of rules) {
    let pat = (rule.whenModuleMatches || "").trim();
    if (!pat) continue;
    let matched = false;
    pat = pat.replace(/^\(\?i\)/i, "");
    try {
      matched = new RegExp(pat, "i").test(moduleText);
    } catch {
      matched = moduleText.toLowerCase().includes(pat.toLowerCase());
    }
    if (!matched) continue;
    const deny = rule.denyPathContains || [];
    for (const d of deny) {
      if (d && pathNorm.toLowerCase().includes(d.toLowerCase())) {
        return {
          pass: false,
          reason: `profile domainGuards deny «${d}» for path`,
        };
      }
    }
    const allow = rule.allowPathContains || [];
    if (allow.length) {
      const ok = allow.some((a) => a && pathNorm.toLowerCase().includes(a.toLowerCase()));
      if (!ok) {
        return {
          pass: false,
          reason: `profile domainGuards require path to contain one of: ${allow.join(", ")}`,
        };
      }
    }
  }
  return { pass: true };
}

/**
 * Hard gate: intent → markers → domain → body-rule → alignment floor → Gen.
 * Fail-closed. Never invent BE for UI/master when scope=backend.
 */
export function decideUnitSutGate(opts: {
  tcText: string;
  primaryPath?: string | null;
  sourceExcerpt?: string | null;
  /** Related DTO/validator excerpts — combined for body-rule + VALIDATION gap checks. */
  relatedExcerpt?: string | null;
  codeAliases?: CodeAliasMap | null;
  alignmentScore?: number | null;
  markersHit?: number | null;
  moduleText?: string | null;
  domainGuards?: UnitDomainGuardRule[] | null;
  /**
   * Profile unit.requireMarkers — when true, path:+code: required.
   * When undefined, unmarked TCs still need UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT.
   */
  requireMarkers?: boolean | null;
  /**
   * Profile unit.scope — default backend.
   * ui_master_create / uiOnly + backend → FAIL_FEATURE_GAP before Gen.
   */
  unitScope?: UnitGenScope | null;
  /**
   * Profile unit.minAlignment — default UNIT_SUT_ALIGN_HARD_FLOOR (50).
   * alignment &lt; this → never call CLI (no preferred-path exception).
   */
  minAlignment?: number | null;
}): UnitSutGateResult {
  const primary = (opts.primaryPath || "").replace(/\\/g, "/").trim();
  const excerpt = (opts.sourceExcerpt || "").trim();
  const relatedExcerpt = (opts.relatedExcerpt || "").trim();
  const fullExcerpt = [excerpt, relatedExcerpt].filter(Boolean).join("\n\n");
  const tcText = opts.tcText || "";
  const markers = extractTcSourceMarkers(tcText);
  const hasMarkers = markers.paths.length > 0 || markers.codes.length > 0;
  const markersHit =
    opts.markersHit != null
      ? opts.markersHit
      : markers.paths.length + markers.codes.length;
  const scope = opts.unitScope || UNIT_GEN_SCOPE_DEFAULT;
  const floor = Math.max(
    0,
    opts.minAlignment != null && Number.isFinite(opts.minAlignment)
      ? Number(opts.minAlignment)
      : UNIT_SUT_ALIGN_HARD_FLOOR
  );

  const cleaned = scenarioTextForFeatureGap(tcText);
  // UI cues from module/title only — steps «điền form» must not mark BE create as uiOnly.
  const intent = extractUnitIntent(
    {
      title: "",
      module: opts.moduleText || cleaned.slice(0, 600),
      steps: cleaned,
      expectedResult: cleaned,
    },
    { uiFromTitleModuleOnly: true }
  );
  const intentMeta = {
    intentClass: intent.primaryClass ?? null,
    intentClasses: intent.classes,
    minAlignment: floor,
  };

  const block = (
    partial: Omit<
      UnitSutGateResult,
      "intentClass" | "intentClasses" | "minAlignment"
    >
  ): UnitSutGateResult => ({ ...partial, ...intentMeta });

  // R1 — UI/master TC under BE Unit Gen → early FEATURE_GAP (no fuzzy Handler).
  if (
    scope === "backend" &&
    (intent.uiOnly || intent.primaryClass === "ui_master_create")
  ) {
    return block({
      decision: "block",
      code: "FAIL_FEATURE_GAP",
      reason:
        `Intent «${intent.primaryClass || "ui"}» is UI/master/form — ` +
        `unit.scope=backend has no BE branch (FAIL_FEATURE_GAP)`,
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "skip",
      resolvedSut: primary || "unresolved",
      featureGap: "ui-master-create",
    });
  }

  if (!primary || !excerpt) {
    return block({
      decision: "block",
      code: "FAIL_NEEDS_MARKER",
      reason: "Unresolved SUT — thiếu primary path hoặc excerpt",
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "skip",
      resolvedSut: "unresolved",
    });
  }

  if (opts.requireMarkers === true && !hasMarkers) {
    return block({
      decision: "block",
      code: "FAIL_NEEDS_MARKER",
      reason: "Profile requireMarkers — cần path: và code: trong Test Data trước Gen",
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "skip",
      resolvedSut: primary,
    });
  }

  // Hard: when TC has path:/code:, primary MUST match — never Gen IFoo for path: Foo.
  if (hasMarkers && !primaryMatchesMarkers(primary, markers)) {
    return block({
      decision: "block",
      code: "FAIL_SUT_MISMATCH",
      reason:
        `Primary «${primary}» does not match Test Data path:/code: ` +
        `[${[...markers.paths, ...markers.codes].slice(0, 4).join(", ")}]`,
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "pass",
      resolvedSut: primary,
    });
  }

  // Behavior TC must not Gen against anemic entity/POCO —
  // except when Test Data layerHint is dto|validator (enforce lives on DTO).
  if (tcImpliesBehaviorPrimary(tcText) && isAnemicEntityLikePath(primary)) {
    const hint = parseUnitLayerHint(tcText);
    if (hint !== "dto" && hint !== "validator") {
      return block({
        decision: "block",
        code: "FAIL_SUT_MISMATCH",
        reason:
          `Primary «${primary}» is entity/POCO — TC implies validate/reject/enable; prefer *Handler/*Service`,
        alignmentScore: opts.alignmentScore ?? 0,
        markersHit,
        domainGuard: "pass",
        resolvedSut: primary,
      });
    }
  }

  const domain = sutDomainConflict({
    tcText,
    primaryPath: primary,
    codeAliases: opts.codeAliases,
  });
  if (domain.conflict) {
    return block({
      decision: "block",
      code: "FAIL_DOMAIN_GUARD",
      reason: `Domain conflict: TC expects [${domain.expected.join(", ")}] but path domains [${domain.pathDomains.join(", ")}]`,
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "fail",
      resolvedSut: primary,
    });
  }

  const profileGuard = applyProfileDomainGuards({
    moduleText: opts.moduleText || tcText,
    primaryPath: primary,
    rules: opts.domainGuards,
  });
  if (!profileGuard.pass) {
    return block({
      decision: "block",
      code: "FAIL_DOMAIN_GUARD",
      reason: profileGuard.reason || "profile domainGuards failed",
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "fail",
      resolvedSut: primary,
    });
  }

  const feat = detectFeatureGap(tcText, fullExcerpt);
  if (feat.gap) {
    return block({
      decision: "block",
      code: "FAIL_FEATURE_GAP",
      reason: `TC implies «${feat.label}» but SUT excerpt has no matching signals`,
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "pass",
      resolvedSut: primary,
      featureGap: feat.label || null,
    });
  }

  const beh = behaviorEvidenceInExcerpt(tcText, fullExcerpt);
  if (!beh.ok) {
    return block({
      decision: "block",
      code: "FAIL_FEATURE_GAP",
      reason: beh.skipReason || "VALIDATION behavior not evidenced in excerpts",
      alignmentScore: opts.alignmentScore ?? 0,
      markersHit,
      domainGuard: "pass",
      resolvedSut: primary,
      featureGap: "validation-missing",
    });
  }

  // Body-rule intents: Expected rule must appear in excerpt (portable patterns).
  if (intent.requiresBodyRule && intent.rulePatterns.length && fullExcerpt) {
    const hitRule = intent.rulePatterns.some((p) => {
      const re = new RegExp(
        p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"),
        "i"
      );
      return re.test(fullExcerpt);
    });
    if (!hitRule) {
      return block({
        decision: "block",
        code: "FAIL_FEATURE_GAP",
        reason:
          `Intent «${intent.primaryClass}» requires body rule ` +
          `[${intent.rulePatterns.slice(0, 4).join(", ")}] — not found in SUT excerpt`,
        alignmentScore: opts.alignmentScore ?? 0,
        markersHit,
        domainGuard: "pass",
        resolvedSut: primary,
        featureGap: "body-rule-missing",
      });
    }
  }

  const scored = sutTcAlignmentScore({
    tcText,
    primaryPath: primary,
    sourceExcerpt: excerpt,
    codeAliases: opts.codeAliases,
  });
  // Always trust score for THIS primary+excerpt — never reuse a disk candidate score.
  const alignmentScore = scored.score;
  const hit = scored.markersHit;
  const softMin = unitSutAlignMin(hit);
  const effectiveFloor = Math.max(softMin, floor);

  if (
    !isPacketSutAcceptable({
      tcText,
      primaryPath: primary,
      sourceExcerpt: excerpt,
      codeAliases: opts.codeAliases,
    }) ||
    alignmentScore < effectiveFloor ||
    !isSutAlignedEnough({ score: alignmentScore, markersHit: hit })
  ) {
    return block({
      decision: "block",
      code: "FAIL_SUT_MISMATCH",
      reason: `SUT alignment too low (score=${alignmentScore}, min=${effectiveFloor}, markersHit=${hit})`,
      alignmentScore,
      markersHit: hit,
      domainGuard: "pass",
      resolvedSut: primary,
    });
  }

  // Unmarked: portable strict floor — force markers when latch is weak.
  if (!hasMarkers && alignmentScore < UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT) {
    return block({
      decision: "block",
      code: "FAIL_NEEDS_MARKER",
      reason: `No path:/code: markers and alignment ${alignmentScore} < ${UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT} — add markers or raise grounding`,
      alignmentScore,
      markersHit: hit,
      domainGuard: "pass",
      resolvedSut: primary,
    });
  }

  return block({
    decision: "gen",
    reason: "ok",
    alignmentScore,
    markersHit: hit,
    domainGuard: "pass",
    resolvedSut: primary,
  });
}

/** True when CLI/model output is a refuse protocol line. */
export function isUnitGenRefuseOutput(code: string): boolean {
  return /FAIL_(NEEDS_MARKER|DOMAIN_GUARD|FEATURE_GAP|SUT_MISMATCH)/i.test(code || "");
}

/**
 * Path-rank penalty when basename is mostly weak Create/Unit/Upload tokens
 * and no marker / strong layer token hit.
 */
export function weakCommonPathTokenPenalty(
  pathRel: string,
  opts?: { hasMarkers?: boolean; strongTokenHit?: boolean }
): number {
  if (opts?.hasMarkers || opts?.strongTokenHit) return 0;
  const base =
    pathRel
      .replace(/\\/g, "/")
      .split("/")
      .pop()
      ?.replace(/\.[^.]+$/, "") || "";
  const parts = base.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])/g) || [];
  const lows = parts.map((p) => p.toLowerCase()).filter((p) => p.length >= 3);
  if (lows.length < 2) return 0;
  const weak = lows.filter((p) => UNIT_WEAK_COMMON_PATH_TOKENS.has(p));
  if (weak.length >= Math.ceil(lows.length * 0.6)) return -18;
  if (weak.includes("create") || weak.includes("upload") || weak.includes("unit")) return -8;
  return 0;
}
