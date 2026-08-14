/** Status from detect — FOUND ≠ READY. */
export type AiCliStatus =
  | "NOT_FOUND"
  | "FOUND"
  | "INVALID"
  | "NOT_AUTHENTICATED"
  | "READY"
  | "ERROR";

export type AiCliDetectedBy = "manual" | "env" | "PATH" | "known-location";

/** Settings `cliType` values that have a default executable in source. */
export type AiCliId =
  | "cursor-cli"
  | "gemini-cli"
  | "claude-cli"
  | "antigravity-cli"
  | "ollama"
  | "custom-script";

export type AiCliOs = "win32" | "darwin" | "linux";

export type AiCliSpec = {
  id: AiCliId;
  name: string;
  /** Names tried on PATH (Windows may add .exe/.cmd/.bat/.ps1). */
  commandCandidates: string[];
  versionArgs: string[];
  /** Non-interactive command that exits non-zero when the CLI is not signed in. */
  authCheckArgs?: string[];
  /** Env vars treated as user-configured path (as-built Cursor only). */
  envPathKeys: string[];
};

export type AiCliDetectResult = {
  provider: AiCliId;
  name: string;
  executablePath: string | null;
  version: string | null;
  detectedBy: AiCliDetectedBy | null;
  os: AiCliOs;
  status: AiCliStatus;
  lastCheckedAt: string;
  /** User-visible reason; never credentials. */
  message: string | null;
};

export type AiCliVersionOut = {
  exitCode: number;
  stdout: string;
  stderr: string;
  error?: string;
};

export type AiCliProbe = {
  isFile: (absPath: string) => boolean | Promise<boolean>;
  which: (commandName: string) => string | null | Promise<string | null>;
  runVersion: (
    executable: string,
    args: string[]
  ) => Promise<AiCliVersionOut>;
};

export type DetectAiCliOpts = {
  probe: AiCliProbe;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  /** User-picked path (local config later). */
  manualPath?: string | null;
  now?: () => Date;
  /** Skip `--version` — status stays FOUND if the file exists. */
  skipVersion?: boolean;
};

export function isAiCliReady(status: AiCliStatus): boolean {
  return status === "READY";
}

export function platformToOs(platform: NodeJS.Platform): AiCliOs {
  if (platform === "win32") return "win32";
  if (platform === "darwin") return "darwin";
  return "linux";
}
