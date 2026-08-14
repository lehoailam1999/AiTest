/**
 * Load portable Unit intent skeleton from defaults JSON (override via SUT rules separately).
 */
import unitIntentDefaults from "./defaults/unit-intent-defs.json" with { type: "json" };
function compileIntentDef(raw) {
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
const defaults = unitIntentDefaults;
export const UNIT_UI_MASTER_STRONG_RE = new RegExp(defaults.uiMasterStrongRe);
export const UNIT_INTENT_DEFS = Object.freeze((defaults.intents || []).map(compileIntentDef));
