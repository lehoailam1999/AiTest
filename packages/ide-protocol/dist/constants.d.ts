/** Protocol constants — bump only on breaking changes. */
export declare const IDE_PROTOCOL_VERSION: 1;
/** Filename under user data / home for Desktop↔Plugin discovery */
export declare const IDE_BRIDGE_FILENAME = "ide-bridge.json";
/** Relative dir under user home / app data */
export declare const IDE_BRIDGE_DIR = ".aitest";
export type IdeKind = "vscode" | "cursor" | "antigravity" | "jetbrains" | "visualstudio" | "mock";
export type BridgeStatus = "disconnected" | "connecting" | "connected" | "degraded";
export type Confidence = "high" | "medium" | "low";
/**
 * Hard caps for IDE Command Layer (P10) — never dump workspace.
 * Plugin + mock MUST clamp to these (or lower).
 */
export declare const IdeCommandLimits: {
    readonly searchSymbolMaxResults: 20;
    readonly searchTextMaxResults: 20;
    readonly searchTextMaxBytesPerHit: 2048;
    readonly findReferencesMaxResults: 20;
    readonly findImplementationsMaxResults: 12;
    readonly readFileMaxBytes: 32768;
    readonly readFileMaxLines: 400;
};
