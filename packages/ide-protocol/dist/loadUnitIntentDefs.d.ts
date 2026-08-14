/** Intent classes — portable IT shapes (Approve R1 + Gen gate). */
export type UnitIntentClass = "upload" | "upload_size_limit" | "upload_resource" | "persist_create" | "persist_update" | "validate_reject" | "auto_generate_code" | "state_enable" | "filter_list" | "search_lookup" | "ui_master_create" | "reject";
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
export declare const UNIT_UI_MASTER_STRONG_RE: RegExp;
export declare const UNIT_INTENT_DEFS: readonly IntentDefLoaded[];
