import type { AiCliId, AiCliOs } from "./types";
import { getAiCliSpec } from "./registry";

function join(os: AiCliOs, ...parts: string[]): string {
  const sep = os === "win32" ? "\\" : "/";
  return parts
    .filter((p) => p.length > 0)
    .map((p, i) => (i === 0 ? p.replace(/[/\\]+$/, "") : p.replace(/^[/\\]+/, "").replace(/[/\\]+$/, "")))
    .join(sep);
}

/**
 * OS-known install dirs from **environment variables**, never a developer home literal.
 * Cursor layout matches `resolveAgentBinary` in the IDE extension.
 */
export function knownLocationCandidates(
  id: AiCliId,
  os: AiCliOs,
  env: Record<string, string | undefined>
): string[] {
  const spec = getAiCliSpec(id);
  if (!spec || spec.id === "custom-script") return [];

  const out: string[] = [];
  const localApp = (env.LOCALAPPDATA || "").trim();
  const home = (env.HOME || env.USERPROFILE || "").trim();

  if (id === "cursor-cli" && os === "win32" && localApp) {
    out.push(join(os, localApp, "cursor-agent", "agent.ps1"));
    out.push(join(os, localApp, "cursor-agent", "agent.cmd"));
  }

  if (id === "ollama" && os === "win32" && localApp) {
    out.push(join(os, localApp, "Programs", "Ollama", "ollama.exe"));
  }

  if (os !== "win32") {
    const bins = ["/usr/local/bin", "/opt/homebrew/bin"];
    if (home) bins.unshift(join(os, home, ".local", "bin"));
    const names =
      id === "cursor-cli" ? ["agent", "cursor-agent"] : spec.commandCandidates.filter((n) => !n.includes("."));
    for (const dir of bins) {
      for (const name of names) {
        out.push(join(os, dir, name));
      }
    }
  }

  return [...new Set(out)];
}
