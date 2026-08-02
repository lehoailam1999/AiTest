import type { Connection } from "../api/types";

const CLI_LABELS: Record<string, string> = {
  "cursor-cli": "Cursor CLI",
  "gemini-cli": "Gemini CLI",
  "claude-cli": "Claude CLI",
  "ollama": "Ollama",
  "custom-script": "Custom script",
};

/**
 * Label for Ready strip / gate — prefer CLI vendor over legacy Direct API provider.
 * Settings still may store backend_type=openai as a placeholder when using Cursor CLI.
 */
export function aiConnectionDisplayLabel(
  conn: Pick<Connection, "provider" | "backendType" | "runnerMode" | "cliType"> | null | undefined
): string | null {
  if (!conn) return null;
  const runner = (conn.runnerMode || "").toUpperCase();
  const cli = (conn.cliType || "").trim().toLowerCase();
  if (runner === "AI_CLI" || cli) {
    if (cli && CLI_LABELS[cli]) return CLI_LABELS[cli];
    if (cli) return cli;
    return "AI CLI";
  }
  const provider = (conn.provider || conn.backendType || "").trim();
  return provider || null;
}
