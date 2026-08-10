/**
 * Zustand store for IDE codegen Apply/Run callback UI (file tree + screenshots).
 */
import { create } from "zustand";
import type { CodegenTreeState } from "./codegenCommands";
import {
  getLastCodegenTree,
  onCodegenTreeChanged,
  rememberCodegenResult,
} from "./codegenCommands";
import type { CodegenResultCallback } from "@aitest/ide-protocol";

type CodegenUiState = CodegenTreeState & {
  progressMessage?: string;
  setFromResult: (r: CodegenResultCallback | Parameters<typeof rememberCodegenResult>[0]) => void;
  setProgress: (message: string) => void;
  clear: () => void;
  hydrateFromMemory: () => void;
};

export const useCodegenUiStore = create<CodegenUiState>((set) => ({
  files: [],
  updatedAt: 0,
  setFromResult: (r) => {
    rememberCodegenResult(r);
  },
  setProgress: (message) => set({ progressMessage: message }),
  clear: () =>
    set({
      files: [],
      runReport: undefined,
      logExcerpt: undefined,
      status: undefined,
      progressMessage: undefined,
      updatedAt: Date.now(),
    }),
  hydrateFromMemory: () => set({ ...getLastCodegenTree() }),
}));

// Keep React panel in sync whenever Apply/Run remembers a result (any caller).
onCodegenTreeChanged(() => {
  useCodegenUiStore.setState({ ...getLastCodegenTree(), progressMessage: undefined });
});
