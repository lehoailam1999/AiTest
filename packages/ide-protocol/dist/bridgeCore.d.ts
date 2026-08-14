import type { IdeBridgeDiscovery, IdeKind } from "./types.js";
/** Browser-safe token (Web Crypto when available). */
export declare function generateBridgeToken(): string;
export declare function createDiscovery(input: {
    port: number;
    ide: IdeKind;
    token?: string;
    workspaceRoot?: string;
}): IdeBridgeDiscovery;
export declare function bridgeWsUrl(discovery: IdeBridgeDiscovery): string;
export declare function parseBridgeDiscoveryJson(raw: string): IdeBridgeDiscovery | null;
