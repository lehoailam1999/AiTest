/**
 * Load portable Unit intent skeleton from defaults JSON (override via SUT rules separately).
 */
import unitIntentDefaults from "./defaults/unit-intent-defs.json" with { type: "json" };

/** Intent classes — portable IT shapes (Approve R1 + Gen gate). */
export type UnitIntentClass =
  | "upload"
  | "upload_size_limit"
  | "upload_resource"
  | "persist_read"
  | "persist_create"
  | "persist_update"
  | "validate_reject"
  | "auto_generate_code"
  | "state_enable"
  | "filter_list"
  | "search_lookup"
  | "ui_master_create"
  | "reject";

export type IntentDefJson = {
  id: UnitIntentClass;
  priority: number;
  cues: string[];
  codePatterns: string[];
  rulePatterns?: string[];
  featureTokens: string[];
  requiresBodyRule?: boolean;
  uiOnly?: boolean;
};

export type IntentDefLoaded = {
  id: UnitIntentClass;
  priority: number;
  cues: RegExp[];
  codePatterns: string[];
  rulePatterns?: string[];
  featureTokens: string[];
  requiresBodyRule?: boolean;
  uiOnly?: boolean;
};

type UnitIntentDefaultsFile = {
  uiMasterStrongRe: string;
  intents: IntentDefJson[];
};

function compileIntentDef(raw: IntentDefJson): IntentDefLoaded {
  return {
    id: raw.id,
    priority: raw.priority,
    cues: (raw.cues || []).map((c) => new RegExp(c)),
    codePatterns: raw.codePatterns || [],
    rulePatterns: raw.rulePatterns,
    featureTokens: raw.featureTokens || [],
    requiresBodyRule: raw.requiresBodyRule,
    uiOnly: raw.uiOnly,
  };
}

const defaults = unitIntentDefaults as UnitIntentDefaultsFile;

export const UNIT_UI_MASTER_STRONG_RE = new RegExp(defaults.uiMasterStrongRe);

export const UNIT_INTENT_DEFS: readonly IntentDefLoaded[] = Object.freeze(
  (defaults.intents || []).map(compileIntentDef)
);
