/**
 * Desktop orchestrator — IDE bridge (P0–P3).
 */
export {
  discoveryFromJson,
  connectIdeBridge,
  fetchIdeSemanticContext,
  fetchIdeHealth,
  type IdeBridgeConnection,
  type IdeSemanticPacket,
  type BridgeHealth,
  type IdeBridgeDiscovery,
} from "./connect";

export { useIdeBridgeSession, getIdeRpcClientOrNull } from "./session";
export type { IdeFocusState } from "./session";
export { dispatchIdeCommand, fetchIdeSemanticOrNull } from "./commandBus";
export {
  contextPacketFromIdeSemantic,
  ideFocusReadyForGenerate,
} from "./fromIdeSemantic";
export { rootsAligned, rootsMismatch, normalizeFsRoot } from "./rootsMatch";
