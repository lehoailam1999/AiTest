/**
 * Generation gate — READY only. Detect runs on the user machine (Desktop).
 * Backend must not detect or receive CLI credentials.
 */
import { isTauri } from "../../tauri/bridge";
import { loadAiCliLocalState, saveAiCliLocalState, type AiCliLocalState } from "./localStore";
import { parseAiCliId } from "./registry";
import { detectOneOnUserMachine } from "./runDetect";
import type { AiCliDetectResult, AiCliId } from "./types";
import { isAiCliReady } from "./types";

/** Avoid re-running version + auth probes on every Gen/Repair within a short window. */
export const AI_CLI_READY_CACHE_TTL_MS = 60_000;

type ReadyCacheEntry = {
  result: AiCliDetectResult;
  manualPath: string | null;
  checkedAtMs: number;
};

const readyCache = new Map<AiCliId, ReadyCacheEntry>();

export function clearAiCliReadyCache(id?: AiCliId): void {
  if (id) readyCache.delete(id);
  else readyCache.clear();
}

export class AiCliNotReadyError extends Error {
  readonly result: AiCliDetectResult;
  constructor(result: AiCliDetectResult) {
    super(aiCliNotReadyMessage(result));
    this.name = "AiCliNotReadyError";
    this.result = result;
  }
}

export function aiCliNotReadyMessage(result: AiCliDetectResult): string {
  const name = result.name || result.provider;
  switch (result.status) {
    case "NOT_FOUND":
      return `${name} was not found on this machine. Open Cấu hình AI → AI CLI Environment to Auto Detect or Select Executable.`;
    case "NOT_AUTHENTICATED":
      return `${name} is installed but is not ready for use.`;
    case "FOUND":
      return `${name} was found but is not READY (version check incomplete).`;
    case "INVALID":
      return `${name} path is invalid.${result.message ? ` ${result.message}` : ""}`;
    case "ERROR":
      return `${name} could not be used.${result.message ? ` ${result.message}` : ""}`;
    default:
      if (isAiCliReady(result.status) && !result.executablePath?.trim()) {
        return `${name} is READY but executable path is missing.`;
      }
      return `${name} is not READY (${result.status}).`;
  }
}

/** Pure gate used by tests and ensureAiCliReady. */
export function assertGenerationAllowed(result: AiCliDetectResult): void {
  if (isAiCliReady(result.status) && result.executablePath?.trim()) return;
  throw new AiCliNotReadyError(result);
}

export type EnsureAiCliReadyDeps = {
  detectOne: (
    id: AiCliId,
    manualPath?: string | null
  ) => Promise<AiCliDetectResult>;
  loadState: () => AiCliLocalState;
  saveState: (state: AiCliLocalState) => void;
  isDesktop: () => boolean;
};

function defaultDeps(): EnsureAiCliReadyDeps {
  return {
    detectOne: detectOneOnUserMachine,
    loadState: () => loadAiCliLocalState(),
    saveState: (s) => saveAiCliLocalState(s),
    isDesktop: () => isTauri(),
  };
}

/**
 * Re-detect (manual path → PATH → known locations) then block unless READY + path.
 * READY results are cached briefly so Gen + Repair do not pay two subprocess probes each time.
 */
export async function ensureAiCliReady(
  id: AiCliId,
  deps?: Partial<EnsureAiCliReadyDeps>
): Promise<AiCliDetectResult> {
  const d = { ...defaultDeps(), ...deps };
  const local = d.loadState();
  const manualPath = local.manualPaths[id] ?? null;
  const cached = readyCache.get(id);
  const now = Date.now();
  if (
    cached &&
    cached.manualPath === manualPath &&
    now - cached.checkedAtMs < AI_CLI_READY_CACHE_TTL_MS &&
    isAiCliReady(cached.result.status) &&
    cached.result.executablePath?.trim()
  ) {
    assertGenerationAllowed(cached.result);
    return cached.result;
  }

  const result = await d.detectOne(id, manualPath);
  const lastResults = local.lastResults.filter((r) => r.provider !== id);
  lastResults.push(result);
  d.saveState({ ...local, lastResults });
  try {
    assertGenerationAllowed(result);
  } catch (e) {
    readyCache.delete(id);
    throw e;
  }
  readyCache.set(id, { result, manualPath, checkedAtMs: now });
  return result;
}

/** Unit / E2E Gen Owner = Cursor Agent CLI on the user machine. */
export async function ensureCursorAgentReady(
  deps?: Partial<EnsureAiCliReadyDeps>
): Promise<AiCliDetectResult> {
  return ensureAiCliReady("cursor-cli", deps);
}

/**
 * Sinh TC (API job) — gate Settings vendor on Desktop only.
 * Does not rewrite the Backend pipeline; skip when not Tauri (browser).
 */
export async function ensureTcGenCliReady(
  cliType: string | null | undefined,
  deps?: Partial<EnsureAiCliReadyDeps>
): Promise<AiCliDetectResult | null> {
  const d = { ...defaultDeps(), ...deps };
  if (!d.isDesktop()) return null;
  const id = parseAiCliId(cliType) ?? "cursor-cli";
  return ensureAiCliReady(id, d);
}
