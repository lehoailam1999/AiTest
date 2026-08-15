import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { detectOneOnUserMachine } from "../lib/aiCli/runDetect";
import {
  loadAiCliLocalState,
  mergeManualPath,
  saveAiCliLocalState,
  type AiCliLocalState,
} from "../lib/aiCli/localStore";
import { clearAiCliReadyCache } from "../lib/aiCli/gate";
import type { AiCliDetectResult, AiCliId } from "../lib/aiCli/types";
import { isTauri, pickExecutableFile } from "../tauri/bridge";

type AiCliState = {
  results: AiCliDetectResult[];
  detecting: boolean;
  lastError: string | null;
  detectOne: (
    id: AiCliId,
    opts?: { clearManual?: boolean }
  ) => Promise<AiCliDetectResult>;
  selectExecutable: (id: AiCliId) => Promise<AiCliDetectResult | null>;
};

const AiCliContext = createContext<AiCliState | null>(null);

function persist(next: AiCliLocalState) {
  saveAiCliLocalState(next);
}

export function AiCliProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<AiCliLocalState>(() => loadAiCliLocalState());
  const [detecting, setDetecting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const detectOne = useCallback(
    async (id: AiCliId, opts?: { clearManual?: boolean }) => {
      setDetecting(true);
      setLastError(null);
      try {
        let next = loadAiCliLocalState();
        if (opts?.clearManual) next = mergeManualPath(next, id, null);
        // Settings/manual path changes must not reuse a stale READY probe.
        clearAiCliReadyCache(id);
        const one = await detectOneOnUserMachine(id, next.manualPaths[id] ?? null);
        const lastResults = next.lastResults.filter((r) => r.provider !== id);
        lastResults.push(one);
        next = { ...next, lastResults };
        setLocal(next);
        persist(next);
        return one;
      } catch (e) {
        const message = e instanceof Error ? e.message : "AI CLI detect failed.";
        setLastError(message);
        throw e instanceof Error ? e : new Error(message);
      } finally {
        setDetecting(false);
      }
    },
    []
  );

  const selectExecutable = useCallback(async (id: AiCliId) => {
    if (!isTauri()) {
      setLastError("Chọn executable cần AITest Desktop (Tauri).");
      return null;
    }
    const picked = await pickExecutableFile();
    if (!picked) return null;
    setDetecting(true);
    setLastError(null);
    try {
      clearAiCliReadyCache(id);
      let next = mergeManualPath(loadAiCliLocalState(), id, picked);
      const one = await detectOneOnUserMachine(id, picked);
      const lastResults = next.lastResults.filter((r) => r.provider !== id);
      lastResults.push(one);
      next = { ...next, lastResults };
      setLocal(next);
      persist(next);
      return one;
    } catch (e) {
      const message = e instanceof Error ? e.message : "AI CLI detect failed.";
      setLastError(message);
      throw e instanceof Error ? e : new Error(message);
    } finally {
      setDetecting(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      results: local.lastResults,
      detecting,
      lastError,
      detectOne,
      selectExecutable,
    }),
    [local.lastResults, detecting, lastError, detectOne, selectExecutable]
  );

  return <AiCliContext.Provider value={value}>{children}</AiCliContext.Provider>;
}

export function useAiCliDetect() {
  const ctx = useContext(AiCliContext);
  if (!ctx) throw new Error("useAiCliDetect must be used within AiCliProvider");
  return ctx;
}
