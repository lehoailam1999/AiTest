/**
 * Layer 2 — Unit Approve confidence band (HIGH | MEDIUM | LOW).
 * Maps score/margin/signals → band. LOW blocks writeBack; MEDIUM writes with warning.
 * Does not change path ranking. Portable — no product nouns.
 */

export type UnitApproveConfidence = "HIGH" | "MEDIUM" | "LOW";

export const UNIT_APPROVE_CONFIDENCE = {
  minScore: 56,
  highMargin: 20,
  highRatio: 1.45,
  softMargin: 8,
  softRatio: 1.15,
  /** LLM shortlist numeric → band */
  llmHigh: 0.9,
  llmMedium: 0.7,
} as const;

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
export function mapUnitApproveConfidence(
  input: MapUnitApproveConfidenceInput
): UnitApproveConfidence {
  if (input.priorSkipReason) return "LOW";

  const {
    minScore,
    highMargin,
    highRatio,
    softMargin,
    softRatio,
    llmHigh,
    llmMedium,
  } = UNIT_APPROVE_CONFIDENCE;

  if (input.source === "llm-shortlist") {
    const c = Number(input.llmConfidence);
    if (!Number.isFinite(c) || c < llmMedium) return "LOW";
    if (c >= llmHigh) return "HIGH";
    return "MEDIUM";
  }

  if (input.score < minScore) return "LOW";
  if (!input.moduleGated) return "LOW";

  const sole = input.margin >= 900;
  const ratio =
    input.ratio != null && Number.isFinite(input.ratio) ? input.ratio : null;
  const strictOk =
    sole ||
    input.margin >= highMargin ||
    (ratio != null && ratio >= highRatio);
  const softOk =
    sole ||
    input.margin >= softMargin ||
    (ratio != null && ratio >= softRatio);

  if (!softOk) return "LOW";

  // Body-rule required but zero hits (same-family salvage) → MEDIUM at best
  if (input.requiresBodyRule && input.ruleHitCount < 1) {
    return "MEDIUM";
  }

  if (strictOk && (input.hasStrongSignal || input.ruleHitCount >= 1 || sole)) {
    return "HIGH";
  }
  if (strictOk) return "MEDIUM";

  // Soft margin path — always MEDIUM when gated (write with warning)
  return "MEDIUM";
}

export type ConfidenceWriteGate = {
  writeBack: boolean;
  confidence: UnitApproveConfidence;
  skipReason?: string;
};

/** LOW → refuse writeBack; HIGH/MEDIUM keep write when already allowed. */
export function applyConfidenceWriteGate(
  wouldWrite: boolean,
  confidence: UnitApproveConfidence
): ConfidenceWriteGate {
  if (!wouldWrite) {
    return { writeBack: false, confidence: confidence === "HIGH" ? "LOW" : confidence };
  }
  if (confidence === "LOW") {
    return {
      writeBack: false,
      confidence: "LOW",
      skipReason:
        "FAIL_CONFIDENCE_LOW — score/margin/signals below Approve write threshold",
    };
  }
  return { writeBack: true, confidence };
}

/** MD / log warning fragment for MEDIUM writes. */
export function confidenceMdWarning(
  confidence: UnitApproveConfidence
): string {
  if (confidence === "MEDIUM") {
    return " confidence=MEDIUM warning=soft-margin";
  }
  if (confidence === "HIGH") return " confidence=HIGH";
  return " confidence=LOW";
}
