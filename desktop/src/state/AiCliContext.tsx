import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import {
  detectAllOnUserMachine,
  detectOneOnUserMachine,
} from "../lib/aiCli/runDetect";
import {
  loadAiCliLocalState,
  mergeManualPath,
  saveAiCliLocalState,
  type AiCliLocalState,
} from "../lib/aiCli/localStore";
import type { AiCliDetectResult, AiCliId } from "../lib/aiCli/types";
import { isTauri, pickExecutableFile } from "../tauri/bridge";

type AiCliState = {
  results: AiCliDetectResult[];
  detecting: boolean;
  lastError: string | null;
  refresh: () => Promise<void>;
  detectOne: (id: AiCliId, opts?: { clearManual?: boolean }) => Promise<void>;
  selectExecutable: (id: AiCliId) => Promise<void>;
};

const AiCliContext = createContext<AiCliState | null>(null);

function persist(next: AiCliLocalState) {
  saveAiCliLocalState(next);
}

export function AiCliProvider({ children }: { children: ReactNode }) {
  const [local, setLocal] = useState<AiCliLocalState>(() => loadAiCliLocalState());
  const [detecting, setDetecting] = useState(false);
  const [lastError, setLastError] = useState<string | null>(null);

  const runAll = useCallback(async (manual: AiCliLocalState["manualPaths"]) => {
    setDetecting(true);
    setLastError(null);
    try {
      const lastResults = await detectAllOnUserMachine(manual);
      const next = { manualPaths: manual, lastResults };
      setLocal(next);
      persist(next);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "AI CLI detect failed.");
    } finally {
      setDetecting(false);
    }
  }, []);

  useEffect(() => {
    void runAll(loadAiCliLocalState().manualPaths);
  }, [runAll]);

  const refresh = useCallback(async () => {
    await runAll(loadAiCliLocalState().manualPaths);
  }, [runAll]);

  const detectOne = useCallback(
    async (id: AiCliId, opts?: { clearManual?: boolean }) => {
      setDetecting(true);
      setLastError(null);
      try {
        let next = loadAiCliLocalState();
        if (opts?.clearManual) next = mergeManualPath(next, id, null);
        const one = await detectOneOnUserMachine(id, next.manualPaths[id] ?? null);
        const lastResults = next.lastResults.filter((r) => r.provider !== id);
        lastResults.push(one);
        next = { ...next, lastResults };
        setLocal(next);
        persist(next);
      } catch (e) {
        setLastError(e instanceof Error ? e.message : "AI CLI detect failed.");
      } finally {
        setDetecting(false);
      }
    },
    []
  );

  const selectExecutable = useCallback(async (id: AiCliId) => {
    if (!isTauri()) {
      setLastError("Chọn executable cần AITest Desktop (Tauri).");
      return;
    }
    const picked = await pickExecutableFile();
    if (!picked) return;
    setDetecting(true);
    setLastError(null);
    try {
      let next = mergeManualPath(loadAiCliLocalState(), id, picked);
      const one = await detectOneOnUserMachine(id, picked);
      const lastResults = next.lastResults.filter((r) => r.provider !== id);
      lastResults.push(one);
      next = { ...next, lastResults };
      setLocal(next);
      persist(next);
    } catch (e) {
      setLastError(e instanceof Error ? e.message : "AI CLI detect failed.");
    } finally {
      setDetecting(false);
    }
  }, []);

  const value = useMemo(
    () => ({
      results: local.lastResults,
      detecting,
      lastError,
      refresh,
      detectOne,
      selectExecutable,
    }),
    [local.lastResults, detecting, lastError, refresh, detectOne, selectExecutable]
  );

  return <AiCliContext.Provider value={value}>{children}</AiCliContext.Provider>;
}

export function useAiCliDetect() {
  const ctx = useContext(AiCliContext);
  if (!ctx) throw new Error("useAiCliDetect must be used within AiCliProvider");
  return ctx;
}
