/**
 * Portable Unit intent alias layer (Approve enrich Phase 1).
 * Maps TC cues (VI/EN) → code patterns / feature tokens — no product paths.
 * Domain nouns come from project `.ai-test/code-aliases.json` only.
 */
import {
  expandVietnameseToCodeTokens,
  normalizeAliasKey,
  type CodeAliasMap,
} from "./viCodeAliases.js";
import {
  UNIT_INTENT_DEFS,
  UNIT_UI_MASTER_STRONG_RE,
  type IntentDefLoaded,
  type UnitIntentClass,
} from "./loadUnitIntentDefs.js";

export { UNIT_INTENT_DEFS, UNIT_UI_MASTER_STRONG_RE };
export type { IntentDefLoaded, UnitIntentClass };

export type UnitIntent = {
  classes: UnitIntentClass[];
  /** Most specific class for gate/debug (may be undefined if none matched). */
  primaryClass?: UnitIntentClass;
  /** True when TC is UI/master/form — not BE Unit under scope=backend. */
  uiOnly: boolean;
  /** All code-ish patterns (path boost + legacy). */
  codePatterns: string[];
  /**
   * Patterns that must appear in SUT excerpt when requiresBodyRule.
   * Excludes action nouns like Upload/InitUpload (those are featureTokens only).
   */
  rulePatterns: string[];
  /**
   * Tokens for path/symbol ranking.
   * Includes project alias expansions (domain nouns) for soft boosts.
   */
  featureTokens: string[];
  /**
   * Feature tokens from intent class defs only (no project aliases).
   */
  classFeatureTokens: string[];
  /** When true, Phase 3 must see ≥1 bodyRuleHits before write-back. */
  requiresBodyRule: boolean;
  /**
   * Project intent overlay may suppress misleading operation heuristics
   * (for example duplicate validation must not be treated as permission).
   */
  forbiddenOpTokens?: string[];
};

/** Minimal TC shape — Desktop TestCase / Extension payloads. */
export type UnitIntentTcLike = {
  title?: string | null;
  module?: string | null;
  steps?: string | null;
  expectedResult?: string | null;
  precondition?: string | null;
  testData?: string | null;
};

export type ExtractUnitIntentOpts = {
  projectAliases?: CodeAliasMap | null;
  requirementTitle?: string | null;
  /**
   * When true, only title+module+requirement are used for ui_master cues
   * (steps often say «điền form» on BE create TCs — must not flip uiOnly).
   */
  uiFromTitleModuleOnly?: boolean;
  /**
   * Approve path/code grounding: match intent cues on Module+Function+Title only.
   * Steps / Expected / Precondition / Test Data must not flip primaryClass
   * (e.g. «ngăn lưu trữ» in steps → state_enable on a create-success TC).
   * Default true.
   */
  cuesFromGroundingOnly?: boolean;
};

type IntentDef = IntentDefLoaded;

/**
 * Strong UI/master shell cues — loaded from defaults JSON.
 */
// UNIT_UI_MASTER_STRONG_RE exported from loadUnitIntentDefs.ts

/**
 * Protocol SoT intent table — loaded from defaults/unit-intent-defs.json.
 * Per-SUT overrides: `.ai-test/unit-intent-rules.json`.
 */
// UNIT_INTENT_DEFS exported from loadUnitIntentDefs.ts

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = String(x || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

/** Diacritic-stripped lowercase blob for cue matching. */
export function unitIntentBlob(
  tc: UnitIntentTcLike,
  requirementTitle?: string | null
): string {
  const scrub = (s: string) =>
    String(s || "")
      // Trace tags (VALIDATION/…) must not drive intent class
      .replace(/^\s*trace\s*:.+$/gim, " ")
      .replace(/\bVALIDATION\s*\/[^\n]*/gi, " ")
      .replace(/\bBR\s*\/[^\n]*/gi, " ");
  const raw = [
    requirementTitle || "",
    tc.title || "",
    tc.module || "",
    tc.steps || "",
    tc.expectedResult || "",
    tc.precondition || "",
    scrub(tc.testData || ""),
  ]
    .filter(Boolean)
    .join("\n");
  return normalizeAliasKey(raw);
}

/**
 * Function-level blob (no Studio Module / requirementTitle).
 * Persist create/update must follow TC Function+Title — not Module alone.
 * When grounding-only: Title + Function only (no Steps/TestData).
 */
export function unitIntentFunctionBlob(
  tc: UnitIntentTcLike,
  opts?: { groundingOnly?: boolean }
): string {
  if (opts?.groundingOnly !== false) {
    const raw = [tc.title || "", tc.module || ""].filter(Boolean).join("\n");
    return normalizeAliasKey(raw);
  }
  return unitIntentBlob(tc, null);
}

/**
 * Approve grounding blob: Module (requirement) + Function (module) + Title.
 * Excludes Steps / Expected / Precondition / Test Data.
 */
export function unitIntentGroundingBlob(
  tc: UnitIntentTcLike,
  requirementTitle?: string | null
): string {
  const raw = [requirementTitle || "", tc.title || "", tc.module || ""]
    .filter(Boolean)
    .join("\n");
  return normalizeAliasKey(raw);
}

/** Title + module + requirement only (for UI intent — ignore steps «điền form»). */
export function unitIntentTitleModuleBlob(
  tc: UnitIntentTcLike,
  requirementTitle?: string | null
): string {
  return unitIntentGroundingBlob(tc, requirementTitle);
}

/** Highest-priority matched class (for gate/debug). */
export function primaryIntentClass(
  classes: UnitIntentClass[]
): UnitIntentClass | undefined {
  let best: IntentDef | undefined;
  for (const id of classes) {
    const def = UNIT_INTENT_DEFS.find((d) => d.id === id);
    if (!def) continue;
    if (!best || def.priority > best.priority) best = def;
  }
  return best?.id;
}

export function hasStrongUiMasterCues(blob: string): boolean {
  return Boolean(blob && UNIT_UI_MASTER_STRONG_RE.test(blob));
}

/**
 * Extract portable Unit intent from TC text (+ optional project domain aliases).
 */
export function extractUnitIntent(
  tc: UnitIntentTcLike,
  opts?: ExtractUnitIntentOpts
): UnitIntent {
  const groundingOnly = opts?.cuesFromGroundingOnly !== false;
  const blob = groundingOnly
    ? unitIntentGroundingBlob(tc, opts?.requirementTitle)
    : unitIntentBlob(tc, opts?.requirementTitle);
  const functionBlob = unitIntentFunctionBlob(tc, { groundingOnly });
  const uiBlob =
    opts?.uiFromTitleModuleOnly !== false
      ? unitIntentTitleModuleBlob(tc, opts?.requirementTitle)
      : blob;
  const classes: UnitIntentClass[] = [];
  const codePatterns: string[] = [];
  const rulePatterns: string[] = [];
  const classFeatureTokens: string[] = [];
  const featureTokens: string[] = [];
  let requiresBodyRule = false;

  if (blob || functionBlob) {
    for (const def of UNIT_INTENT_DEFS) {
      // Module «tạo mới» must not stamp persist_* on every child TC (assign/upload/…)
      const matchBlob =
        def.id === "ui_master_create"
          ? uiBlob
          : def.id === "persist_create" || def.id === "persist_update"
            ? functionBlob
            : blob;
      if (!matchBlob || !def.cues.some((re) => re.test(matchBlob))) continue;
      classes.push(def.id);
      codePatterns.push(...def.codePatterns);
      classFeatureTokens.push(...def.featureTokens);
      featureTokens.push(...def.featureTokens);
      if (def.requiresBodyRule) {
        requiresBodyRule = true;
        rulePatterns.push(...(def.rulePatterns ?? def.codePatterns));
      } else if (def.rulePatterns?.length) {
        rulePatterns.push(...def.rulePatterns);
      }
    }
  }

  // Project domain nouns → feature tokens (never product paths).
  const aliasSource = [
    opts?.requirementTitle || "",
    tc.module || "",
    tc.title || "",
  ]
    .filter(Boolean)
    .join(" ");
  if (aliasSource) {
    featureTokens.push(
      ...expandVietnameseToCodeTokens(aliasSource, opts?.projectAliases)
    );
  }

  // Size-limit + reject reinforce validation body-rule.
  if (
    classes.includes("upload_size_limit") &&
    (classes.includes("reject") || classes.includes("validate_reject")) &&
    !requiresBodyRule
  ) {
    requiresBodyRule = true;
  }

  // uiOnly only with strong master/lookup/dnd cues on title/module —
  // never because steps say «điền form tạo mới».
  let uiOnly =
    classes.includes("ui_master_create") && hasStrongUiMasterCues(uiBlob);

  // Strong BE body intents win over UI shell when both appear.
  if (
    uiOnly &&
    (classes.includes("upload_size_limit") ||
      (classes.includes("validate_reject") && classes.includes("upload")))
  ) {
    if (classes.includes("upload_size_limit")) uiOnly = false;
  }

  // Persist success without master/dropdown → BE persist, not UI.
  if (
    uiOnly &&
    (classes.includes("persist_create") || classes.includes("persist_update")) &&
    !hasStrongUiMasterCues(uiBlob)
  ) {
    uiOnly = false;
  }

  // Drop ui_master from classes when not actually uiOnly (avoid primaryClass trap).
  let finalClasses = [...new Set(classes)];
  if (!uiOnly && finalClasses.includes("ui_master_create")) {
    finalClasses = finalClasses.filter((c) => c !== "ui_master_create");
  }

  const primary = primaryIntentClass(finalClasses);

  return {
    classes: finalClasses,
    primaryClass: primary,
    uiOnly,
    codePatterns: uniq(codePatterns),
    rulePatterns: uniq(rulePatterns),
    featureTokens: uniq(featureTokens),
    classFeatureTokens: uniq(classFeatureTokens),
    requiresBodyRule,
  };
}
