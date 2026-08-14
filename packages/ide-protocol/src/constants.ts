/** Protocol constants — bump only on breaking changes. */
export const IDE_PROTOCOL_VERSION = 1 as const;

/** Filename under user data / home for Desktop↔Plugin discovery */
export const IDE_BRIDGE_FILENAME = "ide-bridge.json";

/** Relative dir under user home / app data */
export const IDE_BRIDGE_DIR = ".aitest";

export type IdeKind = "vscode" | "cursor" | "antigravity" | "jetbrains" | "visualstudio" | "mock";

export type BridgeStatus = "disconnected" | "connecting" | "connected" | "degraded";

export type Confidence = "high" | "medium" | "low";

/**
 * Hard caps for IDE Command Layer (P10) — never dump workspace.
 * Plugin + mock MUST clamp to these (or lower).
 */
export const IdeCommandLimits = {
  searchSymbolMaxResults: 20,
  searchTextMaxResults: 20,
  searchTextMaxBytesPerHit: 2_048,
  findReferencesMaxResults: 20,
  findImplementationsMaxResults: 12,
  readFileMaxBytes: 32_768,
  readFileMaxLines: 400,
} as const;
