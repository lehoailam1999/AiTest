/**
 * Desktop ↔ IDE bridge session (P1) — connect via discovery + live focus.
 */
import { create } from "zustand";
import {
  IdeNotifications,
  type FocusChangedParams,
  type IdeSemanticPacket,
} from "@aitest/ide-protocol";
import { isTauri, readIdeBridgeDiscovery } from "../../tauri/bridge";
import {
  connectIdeBridge,
  discoveryFromJson,
  type IdeBridgeConnection,
} from "./connect";

export type IdeFocusState = FocusChangedParams["focus"] | null;

type IdeBridgeSessionState = {
  status: "idle" | "connecting" | "connected" | "error";
  error: string | null;
  ide: string | null;
  focus: IdeFocusState;
  /** Workspace root reported by IDE bridge (not AITest project) */
  workspaceRoot: string | null;
  confidence: string | null;
  language: string | null;
  lastFocusAt: number | null;
  /** Phase 2 — negotiated capabilities from health */
  capabilities: string[];
  extensionVersion: string | null;
  /** Phase 2 — reusable Unit Gen CLI session id */
  unitGenSessionId: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  /** Clear caret-boost UI without disconnecting bridge */
  clearFocus: () => void;
  setUnitGenSession: (sessionId: string | null) => void;
  /** Full packet on demand (generate path) */
  getSemanticContext: () => Promise<IdeSemanticPacket | null>;
};

let conn: IdeBridgeConnection | null = null;
let unsubFocus: (() => void) | null = null;

export const useIdeBridgeSession = create<IdeBridgeSessionState>((set, get) => ({
  status: "idle",
  error: null,
  ide: null,
  focus: null,
  workspaceRoot: null,
  confidence: null,
  language: null,
  lastFocusAt: null,
  capabilities: [],
  extensionVersion: null,
  unitGenSessionId: null,

  connect: async () => {
    if (get().status === "connecting") return;
    // Always (re)connect from latest ide-bridge.json — IDE reload changes port/token
    if (get().status === "connected" || conn) {
      unsubFocus?.();
      unsubFocus = null;
      const prevSession = get().unitGenSessionId;
      if (prevSession && conn?.client.isConnected) {
        try {
          await conn.client.codegenCloseSession({ sessionId: prevSession });
        } catch {
          /* ignore */
        }
      }
      conn?.client.disconnect();
      conn = null;
    }
    set({
      status: "connecting",
      error: null,
      focus: null,
      workspaceRoot: null,
      capabilities: [],
      extensionVersion: null,
      unitGenSessionId: null,
    });
    try {
      if (!isTauri()) {
        throw new Error("Cần Desktop (Tauri) để đọc ide-bridge.json");
      }
      const raw = await readIdeBridgeDiscovery();
      if (!raw) {
        throw new Error("Chưa có IDE bridge — mở VS Code/Cursor + extension AITest");
      }
      const discovery = discoveryFromJson(raw);
      const next = await connectIdeBridge({ discovery });
      unsubFocus?.();
      unsubFocus = next.client.onNotification((method, params) => {
        if (method !== IdeNotifications.focusChanged) return;
        const p = params as FocusChangedParams;
        set({
          focus: p.focus,
          confidence: p.confidence ?? null,
          language: p.language ?? null,
          workspaceRoot: p.workspaceRoot ?? get().workspaceRoot,
          lastFocusAt: Date.now(),
        });
      });
      conn = next;

      // Connect ≠ lấy lại focus cũ. Focus chỉ cập nhật khi:
      // - caret đổi trong IDE (focusChanged), hoặc
      // - user bấm «Làm mới từ IDE»
      try {
        const health = await next.client.health();
        set({
          status: "connected",
          ide: health.ide,
          focus: null,
          confidence: null,
          language: null,
          workspaceRoot: health.workspaceRoot ?? discovery.workspaceRoot ?? null,
          capabilities: health.capabilities ?? [],
          extensionVersion: health.extensionVersion ?? null,
          error: null,
          lastFocusAt: null,
        });
      } catch {
        set({
          status: "connected",
          ide: discovery.ide,
          focus: null,
          workspaceRoot: discovery.workspaceRoot ?? null,
          capabilities: [],
          extensionVersion: null,
          error: null,
        });
      }
    } catch (e) {
      conn = null;
      set({
        status: "error",
        error: e instanceof Error ? e.message : String(e),
        ide: null,
        focus: null,
        workspaceRoot: null,
        capabilities: [],
        extensionVersion: null,
        unitGenSessionId: null,
      });
    }
  },

  disconnect: () => {
    const sessionId = get().unitGenSessionId;
    unsubFocus?.();
    unsubFocus = null;
    if (sessionId && conn?.client.isConnected) {
      void conn.client.codegenCloseSession({ sessionId }).catch(() => {});
    }
    conn?.client.disconnect();
    conn = null;
    set({
      status: "idle",
      error: null,
      ide: null,
      focus: null,
      workspaceRoot: null,
      confidence: null,
      language: null,
      lastFocusAt: null,
      capabilities: [],
      extensionVersion: null,
      unitGenSessionId: null,
    });
  },

  clearFocus: () => {
    set({
      focus: null,
      confidence: null,
      language: null,
      lastFocusAt: null,
    });
  },

  setUnitGenSession: (sessionId) => {
    set({ unitGenSessionId: sessionId });
  },

  getSemanticContext: async () => {
    if (!conn) return null;
    return conn.client.getSemanticContext({ includeDependencies: true });
  },
}));

/** For Apply / openFile (P5) — null when disconnected */
export function getIdeRpcClientOrNull() {
  return conn?.client ?? null;
}
