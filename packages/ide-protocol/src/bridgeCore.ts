import { IDE_PROTOCOL_VERSION } from "./constants.js";
import type { IdeBridgeDiscovery, IdeKind } from "./types.js";

/** Browser-safe token (Web Crypto when available). */
export function generateBridgeToken(): string {
  const bytes = new Uint8Array(24);
  if (typeof globalThis.crypto?.getRandomValues === "function") {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

export function createDiscovery(input: {
  port: number;
  ide: IdeKind;
  token?: string;
  workspaceRoot?: string;
}): IdeBridgeDiscovery {
  return {
    protocolVersion: IDE_PROTOCOL_VERSION,
    port: input.port,
    token: input.token ?? generateBridgeToken(),
    ide: input.ide,
    startedAt: new Date().toISOString(),
    workspaceRoot: input.workspaceRoot,
    path: "/",
  };
}

export function bridgeWsUrl(discovery: IdeBridgeDiscovery): string {
  const p = discovery.path || "/";
  return `ws://127.0.0.1:${discovery.port}${p.startsWith("/") ? p : `/${p}`}`;
}

export function parseBridgeDiscoveryJson(raw: string): IdeBridgeDiscovery | null {
  try {
    const d = JSON.parse(raw) as IdeBridgeDiscovery;
    if (d.protocolVersion !== IDE_PROTOCOL_VERSION) return null;
    if (!d.port || !d.token || !d.ide) return null;
    return d;
  } catch {
    return null;
  }
}
