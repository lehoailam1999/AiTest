/**
 * Desktop helpers — Capability Negotiation + Unit Gen CLI session reuse.
 */
import {
  DESKTOP_REQUIRED_E2E_CAPS,
  DESKTOP_REQUIRED_UNIT_CAPS,
  IdeCapabilities,
  hasCapability,
  negotiateCapabilities,
  type CapabilityNegotiation,
} from "@aitest/ide-protocol";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "../ideBridge/session";

export function assertIdeUnitCapabilities(
  capabilities: string[] | null | undefined
): CapabilityNegotiation {
  return negotiateCapabilities(capabilities, DESKTOP_REQUIRED_UNIT_CAPS);
}

export function assertIdeE2eCapabilities(
  capabilities: string[] | null | undefined
): CapabilityNegotiation {
  return negotiateCapabilities(capabilities, DESKTOP_REQUIRED_E2E_CAPS);
}

/**
 * Ensure a reusable AI CLI session when Extension advertises sessionReuse.
 * Returns sessionId or null (batch will open ephemeral session).
 */
export async function ensureUnitGenSession(
  projectRoot: string,
  kind: "unit" | "e2e" = "unit",
  agentExecutable?: string | null
): Promise<string | null> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) return null;
  const state = useIdeBridgeSession.getState();
  if (!hasCapability(state.capabilities, IdeCapabilities.sessionReuse)) {
    return null;
  }
  if (state.unitGenSessionId) {
    return state.unitGenSessionId;
  }
  try {
    const opened = await client.codegenOpenSession({
      projectRoot,
      kind,
      ...(agentExecutable?.trim() ? { agentExecutable: agentExecutable.trim() } : {}),
    });
    if (opened?.ok && opened.sessionId) {
      useIdeBridgeSession.getState().setUnitGenSession(opened.sessionId);
      return opened.sessionId;
    }
  } catch {
    /* fall back to ephemeral per-batch session */
  }
  return null;
}

export async function closeUnitGenSession(): Promise<void> {
  const client = getIdeRpcClientOrNull();
  const id = useIdeBridgeSession.getState().unitGenSessionId;
  if (!id) return;
  useIdeBridgeSession.getState().setUnitGenSession(null);
  if (!client?.isConnected) return;
  try {
    await client.codegenCloseSession({ sessionId: id });
  } catch {
    /* ignore */
  }
}
