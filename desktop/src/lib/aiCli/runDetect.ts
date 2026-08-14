import { isTauri } from "../../tauri/bridge";
import { detectAiCli, detectSupportedAiClis } from "./detect";
import { autoDetectCliIds, getAiCliSpec } from "./registry";
import { createTauriAiCliProbe } from "./tauriProbe";
import type { AiCliDetectResult, AiCliId } from "./types";
import { platformToOs } from "./types";

async function userEnv(): Promise<Record<string, string | undefined>> {
  if (!isTauri()) return {};
  const { invoke } = await import("@tauri-apps/api/tauri");
  const raw = await invoke<Record<string, string>>("ai_cli_user_env");
  return raw ?? {};
}

function notDesktopResults(): AiCliDetectResult[] {
  const os = platformToOs(typeof process !== "undefined" ? process.platform : "linux");
  const now = new Date().toISOString();
  return autoDetectCliIds().map((id) => ({
    provider: id,
    name: getAiCliSpec(id)?.name ?? id,
    executablePath: null,
    version: null,
    detectedBy: null,
    os,
    status: "NOT_FOUND",
    lastCheckedAt: now,
    message: "AI CLI detect runs in AITest Desktop (Tauri), not the browser.",
  }));
}

export async function detectAllOnUserMachine(
  manualPaths?: Partial<Record<AiCliId, string | null>>
): Promise<AiCliDetectResult[]> {
  if (!isTauri()) return notDesktopResults();
  const env = await userEnv();
  return detectSupportedAiClis({
    probe: createTauriAiCliProbe(),
    env,
    manualPaths,
  });
}

export async function detectOneOnUserMachine(
  id: AiCliId,
  manualPath?: string | null
): Promise<AiCliDetectResult> {
  if (!isTauri()) {
    return notDesktopResults().find((r) => r.provider === id) ?? notDesktopResults()[0]!;
  }
  const env = await userEnv();
  return detectAiCli(id, {
    probe: createTauriAiCliProbe(),
    env,
    manualPath,
  });
}
