import { invoke } from "@tauri-apps/api/tauri";
import { isTauri } from "../../tauri/bridge";
import type { AiCliProbe, AiCliVersionOut } from "./types";

type VersionRaw = {
  exitCode?: number;
  exit_code?: number;
  stdout?: string;
  stderr?: string;
  error?: string | null;
};

function ensureTauri(): void {
  if (!isTauri()) {
    throw new Error("AI CLI detect needs the Desktop app (Tauri).");
  }
}

/** Probe that runs on the user machine (GUI PATH via Tauri, not the Vite/Node process). */
export function createTauriAiCliProbe(): AiCliProbe {
  return {
    async isFile(absPath: string) {
      ensureTauri();
      return invoke<boolean>("ai_cli_is_file", { path: absPath });
    },
    async which(commandName: string) {
      ensureTauri();
      const p = await invoke<string | null>("ai_cli_which", { name: commandName });
      return p && p.trim() ? p.trim() : null;
    },
    async runVersion(executable: string, args: string[]): Promise<AiCliVersionOut> {
      ensureTauri();
      const raw = await invoke<VersionRaw>("ai_cli_run_version", {
        executable,
        args,
      });
      return {
        exitCode: Number(raw.exitCode ?? raw.exit_code ?? -1),
        stdout: String(raw.stdout ?? ""),
        stderr: String(raw.stderr ?? ""),
        error: raw.error ? String(raw.error) : undefined,
      };
    },
  };
}
