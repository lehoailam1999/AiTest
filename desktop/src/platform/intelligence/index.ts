/** Platform: project intelligence / context builder (P3) */
export {
  buildContextPacket,
  toUnitContextView,
  buildContextPacketFromIde,
} from "../../lib/projectIntelligence/contextBuilder";
export type {
  BuildFromIdeInput,
  BuildFromIdeResult,
} from "../../lib/projectIntelligence/contextBuilder";
export type { UnitContextPacket, ContextBuildPolicy } from "../../lib/projectIntelligence/types";
export {
  IDE_CONTEXT_BUDGET,
  FS_CONTEXT_BUDGET,
  isClientAppMirrorNoise,
} from "../../lib/projectIntelligence/contextBudget";
