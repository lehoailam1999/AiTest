import type { Connection } from "../api/types";

const CLI_LABELS: Record<string, string> = {
  "cursor-cli": "Cursor CLI",
  "gemini-cli": "Gemini CLI",
  "claude-cli": "Claude CLI",
  ollama: "Ollama",
  "custom-script": "Custom script",
};

/**
 * Label for Ready strip / gate — CLI vendor from cliType.
 * Settings may still store backend_type as a placeholder.
 */
export function aiConnectionDisplayLabel(
  conn: Pick<Connection, "provider" | "backendType" | "runnerMode" | "cliType"> | null | undefined
): string | null {
  if (!conn) return null;
  const cli = (conn.cliType || "").trim().toLowerCase();
  if (cli && CLI_LABELS[cli]) return CLI_LABELS[cli];
  if (cli) return cli;
  return "AI CLI";
}
