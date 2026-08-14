/** Node-only entry: FS discovery + mock IDE server */
export * from "./index.js";
export { defaultBridgeDiscoveryPath, ensureBridgeDir, writeBridgeDiscovery, readBridgeDiscovery, clearBridgeDiscovery, } from "./bridgeFs.js";
export { startMockIdeServer, type MockIdeOptions, type MockIdeHandle } from "./mock/server.js";
