import type { AiCliId, AiCliSpec } from "./types";

/**
 * Vendors AITest already supports (`build_cli_adapter` + Settings CLI_TYPES).
 * Do not add CLIs that are not in source.
 */
export const AI_CLI_REGISTRY: readonly AiCliSpec[] = [
  {
    id: "cursor-cli",
    name: "Cursor Agent CLI",
    commandCandidates: [
      "agent.ps1",
      "agent.cmd",
      "agent.exe",
      "agent",
      "cursor-agent.cmd",
      "cursor-agent",
    ],
    versionArgs: ["--version"],
    envPathKeys: ["AITEST_AGENT_PATH", "CURSOR_AGENT_PATH"],
  },
  {
    id: "gemini-cli",
    name: "Gemini CLI",
    commandCandidates: ["gemini.exe", "gemini.cmd", "gemini"],
    versionArgs: ["--version"],
    envPathKeys: [],
  },
  {
    id: "claude-cli",
    name: "Claude Code CLI",
    commandCandidates: ["claude.exe", "claude.cmd", "claude"],
    versionArgs: ["--version"],
    envPathKeys: [],
  },
  {
    id: "antigravity-cli",
    name: "Antigravity CLI",
    commandCandidates: ["agy.exe", "agy.cmd", "agy"],
    versionArgs: ["--version"],
    envPathKeys: [],
  },
  {
    id: "ollama",
    name: "Ollama CLI",
    commandCandidates: ["ollama.exe", "ollama"],
    versionArgs: ["--version"],
    envPathKeys: [],
  },
  {
    id: "custom-script",
    name: "Custom script",
    commandCandidates: [],
    versionArgs: ["--version"],
    envPathKeys: [],
  },
] as const;

const BY_ID = new Map(AI_CLI_REGISTRY.map((s) => [s.id, s]));

export function getAiCliSpec(id: AiCliId): AiCliSpec | undefined {
  return BY_ID.get(id);
}

const CLI_IDS = new Set<string>(AI_CLI_REGISTRY.map((s) => s.id));

/** Map Settings `cliType` → registry id. Unknown vendor → null (do not invent). */
export function parseAiCliId(raw: string | null | undefined): AiCliId | null {
  const v = (raw || "").trim().toLowerCase();
  if (CLI_IDS.has(v)) return v as AiCliId;
  return null;
}

/** Auto-detect list — custom-script needs a manual path. */
export function autoDetectCliIds(): AiCliId[] {
  return AI_CLI_REGISTRY.filter((s) => s.id !== "custom-script").map((s) => s.id);
}
