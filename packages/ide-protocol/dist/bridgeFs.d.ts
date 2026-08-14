import type { IdeBridgeDiscovery } from "./types.js";
export { bridgeWsUrl, createDiscovery, generateBridgeToken, parseBridgeDiscoveryJson } from "./bridgeCore.js";
export declare function defaultBridgeDiscoveryPath(overrideHome?: string): string;
export declare function ensureBridgeDir(overrideHome?: string): string;
export declare function writeBridgeDiscovery(discovery: IdeBridgeDiscovery, filePath?: string): string;
export declare function readBridgeDiscovery(filePath?: string): IdeBridgeDiscovery | null;
export declare function clearBridgeDiscovery(filePath?: string): void;
