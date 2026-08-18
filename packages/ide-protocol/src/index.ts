export {
  IDE_PROTOCOL_VERSION,
  IDE_BRIDGE_FILENAME,
  IDE_BRIDGE_DIR,
  IdeCommandLimits,
  type IdeKind,
  type BridgeStatus,
  type Confidence,
} from "./constants.js";

export {
  IdeCapabilities,
  EXTENSION_CAPABILITIES,
  DESKTOP_REQUIRED_UNIT_CAPS,
  DESKTOP_REQUIRED_E2E_CAPS,
  DESKTOP_REQUIRED_UNIT_APPROVE_CAPS,
  negotiateCapabilities,
  hasCapability,
  type IdeCapability,
  type CapabilityNegotiation,
} from "./capabilities.js";

export type {
  TextRange,
  SymbolKind,
  SymbolInfo,
  CtorParam,
  ConstructorInfo,
  DependencySnippet,
  SymbolRef,
  CallHierarchy,
  IdeSemanticPacket,
  IdeBridgeDiscovery,
  BridgeHealth,
} from "./types.js";

export type {
  BusinessIntent,
  ContextPlan,
  ContextPlanStep,
  ContextPlanStepOp,
  RetrievedFile,
  RetrievalResult,
  ConfidenceCandidate,
  ConfidenceReport,
  AgentRunPhase,
} from "./agentTypes.js";

export {
  IdeMethods,
  IdeNotifications,
  type IdeMethodName,
  type IdeNotificationName,
  type AuthParams,
  type GetSemanticContextParams,
  type CreateTestFileParams,
  type OpenFileParams,
  type RunTestParams,
  type FocusChangedParams,
  type SymbolId,
  type SearchSymbolParams,
  type SymbolHit,
  type SearchSymbolResult,
  type SearchTextParams,
  type TextHit,
  type SearchTextResult,
  type SymbolPositionParams,
  type DefinitionLocation,
  type GoToDefinitionResult,
  type FindReferencesResult,
  type FindImplementationsResult,
  type ReadFileParams,
  type ReadFileResult,
} from "./methods.js";

export type {
  CodegenAction,
  CodegenFileKind,
  CodegenFileDto,
  CodegenLayout,
  CodegenProjectRulesSource,
  CodegenCommandBase,
  CodegenApplyFilesParams,
  CodegenTestRunner,
  CodegenRunTestsParams,
  CodegenUnitItem,
  CodegenE2eItem,
  CodegenGenerateUnitBatchParams,
  CodegenGenerateE2eBatchParams,
  CodegenCancelParams,
  CodegenOpenSessionParams,
  CodegenOpenSessionResult,
  CodegenCloseSessionParams,
  CodegenCloseSessionResult,
  CodegenFileStatus,
  CodegenGeneratedFileMeta,
  CodegenWorkspaceTree,
  CodegenPerTcResult,
  CodegenRunError,
  CodegenTestRunReport,
  CodegenResultStatus,
  CodegenResultCallback,
  CodegenProgressPhase,
  CodegenProgressNotification,
  CodegenApplyFilesResult,
  CodegenRunTestsResult,
} from "./codegenTypes.js";

export type {
  TcSyncApprovedMdParams,
  TcSyncFileStatus,
  TcSyncFileMeta,
  TcSyncApprovedMdResult,
} from "./tcTypes.js";

export {
  assertSafeAitestTargetRel,
  isAllowedUnitLayoutPath,
  isAllowedE2eEnvKey,
  filterAllowedEnv,
} from "./codegenPathJail.js";

export {
  assertSafeAiTestCasesRel,
  assertSafeAiTestCasesReadRel,
  AI_TEST_CASES_DIR,
  LEGACY_AI_TEST_CASES_DIR,
} from "./tcPathJail.js";

export {
  UNIT_CONVENTIONS_CORE,
  UNIT_GEN_LIMITS,
  UNIT_LAYOUT_RULE,
} from "./unitConventions.js";

export {
  normalizeGroundingCompanion,
  parseGroundingCompanion,
} from "./groundingCompanion.js";

export {
  APPROVED_GROUNDING_SCHEMA,
  REQUIRED_GROUNDING_CHECKS,
  normalizeContentHash,
  sameContentHash,
  validateApprovedGroundingDecision,
  type ApprovedGroundingDecision,
  type GroundingBinding,
  type GroundingConfidence,
  type GroundingMarkerInput,
  type GroundingOutcome,
  type GroundingTargetScope,
  type GroundingValidationResult,
} from "./approvedGroundingDecision.js";

export {
  UNIT_APPROVE_REQUEST_SCHEMA,
  UNIT_APPROVE_RESPONSE_SCHEMA,
  UNIT_APPROVE_DECISION_SCHEMA,
  UNIT_TC_IR_SCHEMA,
  DEFAULT_UNIT_APPROVE_LIMITS,
  validateUnitApprovalDecision,
  projectDecisionToV1Grounding,
  hashDecisionBody,
  type Sha256Hex,
  type Sha256Fn,
  type SourcePosition,
  type SourceRange,
  type UnitApproveTargetScope,
  type UnitApproveScenario,
  type UnitApprovePrimaryBucket,
  type UnitApproveTcIr,
  type RepositoryRevision,
  type RepositoryRevisionExpectation,
  type UnitApproveResolveLimits,
  type UnitApproveResolveParams,
  type GroundedSymbolKind,
  type GroundedSymbol,
  type GroundedFileRole,
  type GroundedFile,
  type ExistingTestEvidence,
  type FieldBindingDecision,
  type BehaviorEvidence,
  type FileSnapshot,
  type UnitApproveCheck,
  type UnitApproveReasonCode,
  type UnitApproveReason,
  type UnitApprovalDecision,
  type UnitApproveResolveResult,
  type UnitApproveDecisionValidation,
} from "./unitApproveRpc.js";

export {
  UNIT_RANK_POLICY,
  UNIT_PROMPT_RULES_CORE,
  estimateTokenCount,
  buildUnitGenPhaseMetrics,
  type UnitGenPhaseMetrics,
} from "./unitRuleEngine.js";

export {
  UNIT_SUT_ALIGN_MIN,
  UNIT_SUT_ALIGN_MIN_NO_MARKER,
  PATH_RANK_STOP,
  unitSutAlignMin,
  isSutAlignedEnough,
  significantTokens,
  extractTcSourceMarkers,
  hasUnitSourceMarkers,
  isUnitSutResolveSkipped,
  sutTcAlignmentScore,
  expectedDomainTokensFromTc,
  extractPathDomainHints,
  sutDomainConflict,
  isPacketSutAcceptable,
  detectCodeStack,
  stackForPath,
  assertStackMatchesPath,
  findInventedRuleSmells,
  assertUnitGenQuality,
  detectCsharpPackagesFromTestCode,
  CSHARP_USING_TO_PACKAGE,
  type UnitCodeStack,
  type SutDomainConflict,
} from "./unitGenGuards.js";

export {
  decideUnitSutGate,
  applyProfileDomainGuards,
  isUnitGenRefuseOutput,
  detectFeatureGap,
  scenarioTextForFeatureGap,
  constraintFamily,
  weakCommonPathTokenPenalty,
  UNIT_SUT_ALIGN_MIN_UNMARKED_STRICT,
  UNIT_SUT_ALIGN_HARD_FLOOR,
  UNIT_GEN_SCOPE_DEFAULT,
  UNIT_WEAK_COMMON_PATH_TOKENS,
  UNIT_WEAK_RANK_TOKENS,
  isWeakUnitRankToken,
  filterStrongRankTokens,
  type UnitSutRefuseCode,
  type UnitDomainGuardRule,
  type UnitSutGateCandidate,
  type UnitSutGateResult,
  type UnitGenScope,
} from "./unitSutGate.js";

export {
  behaviorEvidenceInExcerpt,
  isValidationDataBucket,
} from "./behaviorEvidenceInExcerpt.js";

export {
  expandVietnameseToCodeTokens,
  expandCodeMatchTokens,
  matchingProjectAliasTokens,
  mergeCodeAliasMaps,
  normalizeAliasKey,
  GENERIC_VI_WORD_ALIASES,
  GENERIC_VI_PHRASE_ALIASES,
  type CodeAliasMap,
  type ExpandCodeTokensOpts,
} from "./viCodeAliases.js";
export {
  expandTokensFromIndex,
  extractStemsFromIndexPaths,
  filterTokensHittingPaths,
  pathHitsIndexToken,
  pathHitsToken,
  clearIndexStemCache,
  type ExpandTokensFromIndexOpts,
} from "./expandTokensFromIndex.js";
export {
  UNIT_UI_MASTER_STRONG_RE,
  type IntentDefLoaded,
  type IntentDefJson,
  type UnitIntentClass,
} from "./loadUnitIntentDefs.js";

export {
  UNIT_INTENT_DEFS,
  extractUnitIntent,
  unitIntentBlob,
  unitIntentFunctionBlob,
  unitIntentGroundingBlob,
  unitIntentTitleModuleBlob,
  primaryIntentClass,
  hasStrongUiMasterCues,
  type UnitIntent,
  type UnitIntentTcLike,
  type ExtractUnitIntentOpts,
} from "./unitIntentAliases.js";

export {
  parseUnitProjectIntentRules,
  applyProjectIntentRules,
  resolveSutMapPin,
  filterStrongBodyRulePatterns,
  isWeakBodyRulePattern,
  isWeakPathBridgePattern,
  isSoftGenericRuleHit,
  hasStrongWriteBackSignal,
  UNIT_SOFT_GENERIC_RULE_HITS,
  UNIT_WEAK_PATH_BRIDGE_PATTERNS,
  UNIT_WEAK_BODY_RULE_PATTERNS,
  type UnitProjectIntentRule,
  type UnitProjectIntentRulesFile,
  type ApplyProjectIntentResult,
} from "./unitProjectIntentRules.js";

export {
  isWeakUnitClientPath,
  markersPointAtPath,
  isBlockedUnitPrimaryPath,
  isDeniedUnitPrimaryPath,
  isDeniedUnitRelatedPath,
  isAnemicEntityLikePath,
  tcImpliesBehaviorPrimary,
  isPreferredLogicLayerPath,
  filterUnitLogicLayerPaths,
  filterUnitLogicLayerCandidates,
} from "./unitLogicLayerFilter.js";

export {
  stemOfPath,
  isInterfaceLikePrimaryPath,
  stripInterfaceStemPrefix,
  pathsMatchMarker,
  codeMatchesPathStem,
  implementationFamilyStem,
  preferImplementationOverInterface,
  promoteImplementationPrimary,
  primaryMatchesMarkers,
} from "./unitPrimaryPrefer.js";

export {
  UNIT_BODY_RULE,
  clipBodyExcerpt,
  findBodyRuleHits,
  bodyRulePatternsForIntent,
  bodyRuleScoreBoost,
  applyBodyRuleToCandidate,
  validateRejectPathShapeAdjust,
  uploadIntentPathShapeAdjust,
  queryImpliesUploadIntent,
  queryImpliesSearchLookupIntent,
  queryImpliesReadGetDetailIntent,
  searchIntentPathShapeAdjust,
  readGetIntentPathShapeAdjust,
  pathIsDeleteLikeUnitPrimary,
  pathIsCreateLikeUnitPrimary,
  pathIsUpdateLikeUnitPrimary,
  pathContradictsUploadVerb,
  pathContradictsSearchVerb,
  pathContradictsReadGetVerb,
  pathContradictsCrudVerb,
  detectUnitCrudVerb,
  crudVerbPathShapeAdjust,
  pathMatchesCrudVerb,
  queryImpliesStorageStateIntent,
  queryImpliesAuthzIntent,
  functionOpPathShapeAdjust,
  queryImpliesAssignFilterIntent,
  extractOpPreferTokens,
  pathContradictsOpPreferTokens,
  collapseBodyRuleContenders,
  orderCandidatesForBodyRuleOpen,
  decideBodyRuleWriteBack,
  countPreferTokenHits,
  extractTcAffinityPhrases,
  tcExcerptAffinityBoost,
  extractExcerptTechStems,
  formatBodyRuleLog,
  unitFeatureFamilyKey,
  unitPrimaryShapeRank,
  type BodyRuleCandidateIn,
  type BodyRuleScoredCandidate,
  type BodyRuleWriteDecision,
  type PickBodyRuleOpts,
  type UnitCrudVerb,
} from "./unitBodyRuleScore.js";

export {
  UNIT_APPROVE_CONFIDENCE,
  mapUnitApproveConfidence,
  applyConfidenceWriteGate,
  confidenceMdWarning,
  type UnitApproveConfidence,
  type MapUnitApproveConfidenceInput,
  type ConfidenceWriteGate,
} from "./unitApproveConfidence.js";

export {
  discoverFeatureFoldersFromIndex,
  bridgeNeedlesForDiscover,
  pathSegmentTokens,
  featureFolderSegmentFromPath,
  titleCueBridgeStems,
  titleDiscoverKinds,
  filterCandidatesByFeatureFolders,
  isInfraCrossCuttingPath,
  isCrossCuttingSoftPrimaryPath,
  softCrossCuttingDenied,
  isSignedUrlOrTokenGeneratePath,
  infraPathDemoteScore,
  UNIT_INFRA_PATH_TOKENS,
  type FeatureFolderIndexLike,
  type DiscoverFeatureFoldersOpts,
  type DiscoverFeatureFoldersResult,
} from "./unitFeatureFolderDiscover.js";

export {
  entryFeatureKeys,
  relatedShapeBonus,
  expandUnitRelatedPaths,
  formatRelatedMarkerLines,
  featureStem,
  isValidationLayerRelatedPath,
  type ExpandUnitRelatedOpts,
} from "./unitRelatedExpand.js";

export {
  parseUnitLayerHint,
  parseUnitSourceSignal,
  preferDtoValidatorForHints,
  findLayerHintPrimaryPath,
  applyLayerHintPrimaryPromotion,
  type UnitLayerHint,
  type UnitSourceSignal,
} from "./unitLayerHint.js";

export {
  RpcErrorCode,
  nextRpcId,
  makeRequest,
  makeSuccess,
  makeError,
  makeNotification,
  isRequest,
  isResponse,
  isNotification,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcRequest,
  type JsonRpcResponse,
  type JsonRpcNotification,
} from "./rpc.js";

/** Browser-safe discovery helpers (no node:fs) */
export {
  createDiscovery,
  generateBridgeToken,
  bridgeWsUrl,
  parseBridgeDiscoveryJson,
} from "./bridgeCore.js";

export {
  isIdeSemanticPacket,
  assertIdeSemanticPacket,
  isIdeBridgeDiscovery,
} from "./validate.js";

export {
  IdeRpcClient,
  type IdeRpcClientOptions,
  type WsLike,
  type NotificationHandler,
} from "./client.js";
