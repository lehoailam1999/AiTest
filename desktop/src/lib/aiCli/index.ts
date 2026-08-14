export type {
  AiCliDetectResult,
  AiCliDetectedBy,
  AiCliId,
  AiCliOs,
  AiCliProbe,
  AiCliSpec,
  AiCliStatus,
  AiCliVersionOut,
  DetectAiCliOpts,
} from "./types";
export { isAiCliReady, platformToOs } from "./types";
export { AI_CLI_REGISTRY, autoDetectCliIds, getAiCliSpec, parseAiCliId } from "./registry";
export {
  AiCliNotReadyError,
  aiCliNotReadyMessage,
  assertGenerationAllowed,
  ensureAiCliReady,
  ensureCursorAgentReady,
  ensureTcGenCliReady,
} from "./gate";
export { knownLocationCandidates } from "./knownLocations";
export { detectAiCli, detectSupportedAiClis } from "./detect";
export { createTauriAiCliProbe } from "./tauriProbe";
export { detectAllOnUserMachine, detectOneOnUserMachine } from "./runDetect";
export {
  AI_CLI_LOCAL_KEY,
  loadAiCliLocalState,
  saveAiCliLocalState,
  mergeManualPath,
  type AiCliLocalState,
} from "./localStore";
