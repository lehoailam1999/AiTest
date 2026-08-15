/**
 * Layer 2 — Unit Approve confidence band (HIGH | MEDIUM | LOW).
 * Maps score/margin/signals → band. LOW blocks writeBack; MEDIUM writes with warning.
 * Does not change path ranking. Portable — no product nouns.
 */
export type UnitApproveConfidence = "HIGH" | "MEDIUM" | "LOW";
export declare const UNIT_APPROVE_CONFIDENCE: {
    readonly minScore: 56;
    readonly highMargin: 20;
    readonly highRatio: 1.45;
    readonly softMargin: 8;
    readonly softRatio: 1.15;
    /** LLM shortlist numeric → band */
    readonly llmHigh: 0.9;
    readonly llmMedium: 0.7;
};
export type MapUnitApproveConfidenceInput = {
    score: number;
    /** best.score - second.score; use a large value when sole candidate */
    margin: number;
    /** best/second when second exists */
    ratio?: number | null;
    moduleGated: boolean;
    hasStrongSignal: boolean;
    requiresBodyRule: boolean;
    ruleHitCount: number;
    source?: "index.db" | "path-index" | "llm-shortlist";
    /** 0..1 when source=llm-shortlist */
    llmConfidence?: number | null;
    /** Hard fail already decided */
    priorSkipReason?: string | null;
};
/**
 * Classify Approve write confidence from ranking signals.
 *
 * LOW (block write): ungated, score&lt;min, soft margin fail, or prior skip.
 * MEDIUM (write + warning): soft margin, body-rule miss salvage, or weak prefer.
 * HIGH: strict margin + module gate (+ body hits or strong prefer when available).
 */
export declare function mapUnitApproveConfidence(input: MapUnitApproveConfidenceInput): UnitApproveConfidence;
export type ConfidenceWriteGate = {
    writeBack: boolean;
    confidence: UnitApproveConfidence;
    skipReason?: string;
};
/** LOW → refuse writeBack; HIGH/MEDIUM keep write when already allowed. */
export declare function applyConfidenceWriteGate(wouldWrite: boolean, confidence: UnitApproveConfidence): ConfidenceWriteGate;
/** MD / log warning fragment for MEDIUM writes. */
export declare function confidenceMdWarning(confidence: UnitApproveConfidence): string;
