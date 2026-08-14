import type { AiCliDetectResult, AiCliId } from "./types";

export type AiCliLocalState = {
  manualPaths: Partial<Record<AiCliId, string>>;
  lastResults: AiCliDetectResult[];
};

export const AI_CLI_LOCAL_KEY = "aitest.aiCli.v1";

export type StorageLike = {
  getItem: (key: string) => string | null;
  setItem: (key: string, value: string) => void;
};

function empty(): AiCliLocalState {
  return { manualPaths: {}, lastResults: [] };
}

function defaultStorage(): StorageLike | null {
  try {
    if (typeof localStorage === "undefined") return null;
    return localStorage;
  } catch {
    return null;
  }
}

export function loadAiCliLocalState(storage?: StorageLike | null): AiCliLocalState {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return empty();
  try {
    const raw = store.getItem(AI_CLI_LOCAL_KEY);
    if (!raw) return empty();
    const parsed = JSON.parse(raw) as Partial<AiCliLocalState>;
    const manualPaths: Partial<Record<AiCliId, string>> = {};
    if (parsed.manualPaths && typeof parsed.manualPaths === "object") {
      for (const [k, v] of Object.entries(parsed.manualPaths)) {
        if (typeof v === "string" && v.trim()) manualPaths[k as AiCliId] = v.trim();
      }
    }
    const lastResults = Array.isArray(parsed.lastResults) ? parsed.lastResults : [];
    return { manualPaths, lastResults };
  } catch {
    return empty();
  }
}

export function saveAiCliLocalState(
  state: AiCliLocalState,
  storage?: StorageLike | null
): void {
  const store = storage === undefined ? defaultStorage() : storage;
  if (!store) return;
  const manualPaths: Partial<Record<AiCliId, string>> = {};
  for (const [k, v] of Object.entries(state.manualPaths)) {
    if (typeof v === "string" && v.trim()) manualPaths[k as AiCliId] = v.trim();
  }
  store.setItem(
    AI_CLI_LOCAL_KEY,
    JSON.stringify({
      manualPaths,
      lastResults: state.lastResults,
    })
  );
}

export function mergeManualPath(
  state: AiCliLocalState,
  id: AiCliId,
  path: string | null
): AiCliLocalState {
  const manualPaths = { ...state.manualPaths };
  if (path && path.trim()) manualPaths[id] = path.trim();
  else delete manualPaths[id];
  return { ...state, manualPaths };
}
