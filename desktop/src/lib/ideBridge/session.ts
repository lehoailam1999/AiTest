/**
 * Desktop ↔ IDE bridge session (P1) — connect via discovery + live focus.
 */
import { create } from "zustand";
import {
  IdeNotifications,
  type FocusChangedParams,
  type IdeSemanticPacket,
  type IdeBridgeDiscovery,
} from "@aitest/ide-protocol";
import {
  isTauri,
  readIdeBridgeDiscovery,
  readAllIdeBridgeDiscoveries,
  checkIdeExtensionStatus,
  installIdeExtensionNative,
} from "../../tauri/bridge";
import {
  connectIdeBridge,
  discoveryFromJson,
  type IdeBridgeConnection,
} from "./connect";

export type IdeFocusState = FocusChangedParams["focus"] | null;

function normalizePathForCompare(p: string | null | undefined): string {
  if (!p) return "";
  return p.trim().replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

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
  extensionMissing: boolean;
  installingExtension: boolean;
  /** Extension copied but no bridge yet — IDE must reload before it activates. */
  pendingIdeReload: boolean;
  lastInstallMessage: string | null;
  installError: string | null;
  extensionPath: string | null;
  /** Auto-install runs at most once per app session. */
  autoInstallTried: boolean;
  detectedIde: string | null;
  detectedWorkspaceRoot: string | null;
  availableIDEs: IdeBridgeDiscovery[];
  connect: () => Promise<void>;
  connectToDiscovery: (discovery: IdeBridgeDiscovery) => Promise<void>;
  disconnect: () => void;
  /** Clear caret-boost UI without disconnecting bridge */
  clearFocus: () => void;
  setUnitGenSession: (sessionId: string | null) => void;
  /** Auto check and connect IDE if discovery file matches project path */
  autoConnectIfMatching: (targetPath?: string) => Promise<boolean>;
  /** 1-Click native auto-install of extension */
  installExtension: () => Promise<string>;
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
  extensionMissing: false,
  installingExtension: false,
  pendingIdeReload: false,
  lastInstallMessage: null,
  installError: null,
  extensionPath: null,
  autoInstallTried: false,
  detectedIde: null,
  detectedWorkspaceRoot: null,
  availableIDEs: [],

  connectToDiscovery: async (discovery: IdeBridgeDiscovery) => {
    if (get().status === "connecting") return;
    if (get().status === "connected" || conn) {
      unsubFocus?.();
      unsubFocus = null;
      conn?.client.disconnect();
      conn = null;
    }
    set({
      status: "connecting",
      error: null,
      focus: null,
      workspaceRoot: discovery.workspaceRoot ?? null,
      capabilities: [],
      extensionVersion: null,
      unitGenSessionId: null,
    });
    try {
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

      try {
        const health = await next.client.health();
        set({
          status: "connected",
          ide: health.ide,
          workspaceRoot: health.workspaceRoot ?? discovery.workspaceRoot ?? null,
          capabilities: health.capabilities ?? [],
          extensionVersion: health.extensionVersion ?? null,
          error: null,
        });
      } catch {
        set({
          status: "connected",
          ide: discovery.ide,
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
        workspaceRoot: null,
      });
    }
  },

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

  autoConnectIfMatching: async (targetPath?: string) => {
    if (!isTauri()) return false;
    const targetWs = normalizePathForCompare(targetPath);
    if (!targetWs) {
      set({ detectedIde: null, detectedWorkspaceRoot: null, availableIDEs: [] });
      return false;
    }

    try {
      let discoveryListRaw: string[] = [];
      try {
        discoveryListRaw = await readAllIdeBridgeDiscoveries();
      } catch {
        discoveryListRaw = [];
      }

      const discoveredList: IdeBridgeDiscovery[] = [];

      for (const raw of discoveryListRaw) {
        try {
          const d = discoveryFromJson(raw);
          if (d && d.port && !discoveredList.some((x) => x.port === d.port)) {
            discoveredList.push(d);
          }
        } catch {
          /* ignore single invalid discovery */
        }
      }

      if (discoveredList.length === 0) {
        try {
          const raw = await readIdeBridgeDiscovery();
          if (raw) {
            const d = discoveryFromJson(raw);
            if (d) discoveredList.push(d);
          }
        } catch {
          /* ignore */
        }
      }

      set({ availableIDEs: discoveredList });

      if (discoveredList.length > 0) {
        set({ extensionMissing: false, pendingIdeReload: false });

        const targetLeaf = targetWs.split("/").pop() ?? "";
        let bestMatch: IdeBridgeDiscovery | null = null;

        for (const d of discoveredList) {
          const ideWs = normalizePathForCompare(d.workspaceRoot);
          const ideLeaf = ideWs.split("/").pop() ?? "";
          if (
            !ideWs ||
            ideWs === targetWs ||
            ideWs.includes(targetWs) ||
            targetWs.includes(ideWs) ||
            (targetLeaf.length > 2 && targetLeaf === ideLeaf)
          ) {
            bestMatch = d;
            break;
          }
        }

        if (bestMatch) {
          set({
            detectedIde: bestMatch.ide ?? "IDE",
            detectedWorkspaceRoot: bestMatch.workspaceRoot ?? null,
          });
          if (get().status !== "connected" && get().status !== "connecting") {
            await get().connectToDiscovery(bestMatch);
          }
          return true;
        } else {
          const first = discoveredList[0];
          set({
            detectedIde: first.ide ?? "IDE",
            detectedWorkspaceRoot: first.workspaceRoot ?? null,
          });
          if (get().status === "connected") {
            get().disconnect();
          }
          return false;
        }
      } else {
        set({ detectedIde: null, detectedWorkspaceRoot: null, availableIDEs: [] });
        const status = await checkIdeExtensionStatus();
        set({
          extensionMissing: !status.extensionInstalled,
          extensionPath: status.extensionPath ?? null,
        });
        // No bridge + no extension → install it here; the user only has to reload the IDE.
        if (
          !status.extensionInstalled &&
          !get().autoInstallTried &&
          !get().installingExtension
        ) {
          set({ autoInstallTried: true });
          try {
            await get().installExtension();
          } catch {
            /* installError already set — panel shows the manual button */
          }
        }
      }
    } catch {
      /* ignore auto-connect errors */
    }
    return false;
  },

  installExtension: async () => {
    set({ installingExtension: true, installError: null });
    try {
      const result = await installIdeExtensionNative();
      set({
        extensionMissing: false,
        installingExtension: false,
        pendingIdeReload: result.needsReload,
        lastInstallMessage: result.message,
      });
      return result.message;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      set({ installingExtension: false, installError: msg });
      throw e;
    }
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
