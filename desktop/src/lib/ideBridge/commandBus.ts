/**
 * Thin Desktop command bus for IDE bridge (P2).
 * UI / generate call this — not raw WebSocket details.
 */
import { IdeNotifications, type IdeSemanticPacket } from "@aitest/ide-protocol";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "./session";

export type IdeCommand =
  | { type: "ide.connect" }
  | { type: "ide.disconnect" }
  | { type: "ide.refreshFocus" }
  | { type: "ide.getSemanticContext" }
  | { type: "ide.openFile"; pathRel: string }
  | { type: "ide.searchSymbol"; query: string; maxResults?: number }
  | { type: "ide.searchText"; query: string; glob?: string; maxResults?: number }
  | { type: "ide.readFile"; pathRel: string; startLine?: number; endLine?: number }
  | { type: "ide.goToDefinition"; symbolId?: string; pathRel?: string; line?: number; character?: number }
  | { type: "ide.findReferences"; symbolId?: string; pathRel?: string; line?: number; character?: number };

export type IdeCommandResult =
  | { ok: true; data?: unknown }
  | { ok: false; error: string };

export async function dispatchIdeCommand(cmd: IdeCommand): Promise<IdeCommandResult> {
  const s = useIdeBridgeSession.getState();
  try {
    switch (cmd.type) {
      case "ide.connect":
        await s.connect();
        if (useIdeBridgeSession.getState().status !== "connected") {
          return {
            ok: false,
            error: useIdeBridgeSession.getState().error || "Connect IDE failed",
          };
        }
        return { ok: true, data: { ide: useIdeBridgeSession.getState().ide } };
      case "ide.disconnect":
        s.disconnect();
        return { ok: true };
      case "ide.refreshFocus": {
        const packet = await s.getSemanticContext();
        if (!packet) return { ok: false, error: "No IDE context — connect bridge first" };
        // Mirror focus into session (plugin also pushes focusChanged)
        useIdeBridgeSession.setState({
          focus: packet.focus,
          confidence: packet.diagnostics?.confidence ?? null,
          language: packet.language ?? null,
          lastFocusAt: Date.now(),
        });
        return { ok: true, data: packet };
      }
      case "ide.getSemanticContext": {
        const packet = await s.getSemanticContext();
        if (!packet) return { ok: false, error: "No IDE context" };
        return { ok: true, data: packet };
      }
      case "ide.openFile": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) {
          return { ok: false, error: "IDE bridge offline" };
        }
        await client.openFile({ pathRel: cmd.pathRel });
        return { ok: true, data: { pathRel: cmd.pathRel } };
      }
      case "ide.searchSymbol": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) return { ok: false, error: "IDE bridge offline" };
        const data = await client.searchSymbol({
          query: cmd.query,
          maxResults: cmd.maxResults,
        });
        return { ok: true, data };
      }
      case "ide.searchText": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) return { ok: false, error: "IDE bridge offline" };
        const data = await client.searchText({
          query: cmd.query,
          glob: cmd.glob,
          maxResults: cmd.maxResults,
        });
        return { ok: true, data };
      }
      case "ide.readFile": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) return { ok: false, error: "IDE bridge offline" };
        const data = await client.readFile({
          pathRel: cmd.pathRel,
          startLine: cmd.startLine,
          endLine: cmd.endLine,
        });
        return { ok: true, data };
      }
      case "ide.goToDefinition": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) return { ok: false, error: "IDE bridge offline" };
        const data = await client.goToDefinition({
          symbolId: cmd.symbolId,
          pathRel: cmd.pathRel,
          line: cmd.line,
          character: cmd.character,
        });
        return { ok: true, data };
      }
      case "ide.findReferences": {
        const client = getIdeRpcClientOrNull();
        if (!client?.isConnected) return { ok: false, error: "IDE bridge offline" };
        const data = await client.findReferences({
          symbolId: cmd.symbolId,
          pathRel: cmd.pathRel,
          line: cmd.line,
          character: cmd.character,
        });
        return { ok: true, data };
      }
      default:
        return { ok: false, error: "Unknown command" };
    }
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export async function fetchIdeSemanticOrNull(): Promise<IdeSemanticPacket | null> {
  const r = await dispatchIdeCommand({ type: "ide.getSemanticContext" });
  if (!r.ok) return null;
  return (r.data as IdeSemanticPacket) ?? null;
}

export { IdeNotifications };
