import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parseBridgeDiscoveryJson } from "./bridgeCore.js";
import { IDE_BRIDGE_DIR, IDE_BRIDGE_FILENAME } from "./constants.js";
export { bridgeWsUrl, createDiscovery, generateBridgeToken, parseBridgeDiscoveryJson } from "./bridgeCore.js";
export function defaultBridgeDiscoveryPath(overrideHome) {
    const home = overrideHome ?? homedir();
    return join(home, IDE_BRIDGE_DIR, IDE_BRIDGE_FILENAME);
}
export function ensureBridgeDir(overrideHome) {
    const home = overrideHome ?? homedir();
    const dir = join(home, IDE_BRIDGE_DIR);
    mkdirSync(dir, { recursive: true });
    return dir;
}
export function writeBridgeDiscovery(discovery, filePath) {
    const path = filePath ?? defaultBridgeDiscoveryPath();
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, JSON.stringify(discovery, null, 2), "utf8");
    return path;
}
export function readBridgeDiscovery(filePath) {
    const path = filePath ?? defaultBridgeDiscoveryPath();
    if (!existsSync(path))
        return null;
    try {
        return parseBridgeDiscoveryJson(readFileSync(path, "utf8"));
    }
    catch {
        return null;
    }
}
export function clearBridgeDiscovery(filePath) {
    const path = filePath ?? defaultBridgeDiscoveryPath();
    if (existsSync(path))
        unlinkSync(path);
}
