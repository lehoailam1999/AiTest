/**
 * Desktop Unit Rule Engine — consume protocol SoT + Desktop-only gates/rank.
 * Policy for Gen lives in `.ai-test/unit-conventions.md` (seed UNIT_CONVENTIONS_CORE).
 * UNIT_PROMPT_RULES_CORE = transport lines only — do not fork policy here.
 */
export {
  UNIT_CONVENTIONS_CORE,
  UNIT_GEN_LIMITS,
  UNIT_LAYOUT_RULE,
  UNIT_RANK_POLICY,
  UNIT_PROMPT_RULES_CORE,
  UNIT_SUT_ALIGN_MIN,
  UNIT_SUT_ALIGN_MIN_NO_MARKER,
  PATH_RANK_STOP,
  unitSutAlignMin,
  isSutAlignedEnough,
  extractTcSourceMarkers,
  sutTcAlignmentScore,
  expectedDomainTokensFromTc,
  extractPathDomainHints,
  sutDomainConflict,
  isPacketSutAcceptable,
  assertStackMatchesPath,
  assertUnitGenQuality,
  assertSafeAitestTargetRel,
  isAllowedUnitLayoutPath,
  estimateTokenCount,
  buildUnitGenPhaseMetrics,
  decideUnitSutGate,
  applyProfileDomainGuards,
  isUnitGenRefuseOutput,
  detectFeatureGap,
  weakCommonPathTokenPenalty,
  UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT,
  UNIT_WEAK_COMMON_PATH_TOKENS,
  type UnitGenPhaseMetrics,
  type SutDomainConflict,
  type UnitSutGateResult,
  type UnitDomainGuardRule,
  type UnitSutRefuseCode,
} from "@aitest/ide-protocol";

export {
  decideUnitGenGate,
  type UnitGenGateResult,
  type UnitGenGateOk,
  type UnitGenGateFail,
} from "./unitGenGates";

export {
  unitPathBonus,
  isExcludedFromUnitRetrieve,
  isUnsuitableUnitPrimary,
  clampTopK,
} from "../retrieval/rankScore";
