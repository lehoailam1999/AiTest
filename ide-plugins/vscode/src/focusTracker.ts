/**
 * Debounced caret/selection → aitest/focusChanged (<1s DoD).
 */
import * as vscode from "vscode";
import type { BridgeHandle } from "./bridgeServer";
import { buildFocusSnapshot } from "./semanticContext";

export function attachFocusTracker(
  bridge: BridgeHandle,
  getDebounceMs: () => number
): vscode.Disposable {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastKey = "";

  const push = () => {
    void (async () => {
      const snap = await buildFocusSnapshot();
      if (!snap) return;
      const key = `${snap.focus.file}|${snap.focus.symbol}|${snap.focus.method ?? ""}|${snap.focus.range?.start ?? ""}`;
      if (key === lastKey) return;
      lastKey = key;
      bridge.notifyFocusChanged({
        focus: snap.focus,
        confidence: snap.confidence,
        workspaceRoot: snap.workspaceRoot || undefined,
        language: snap.language,
      });
    })();
  };

  const schedule = () => {
    if (timer) clearTimeout(timer);
    const ms = Math.min(900, Math.max(50, getDebounceMs()));
    timer = setTimeout(push, ms);
  };

  const subs = [
    vscode.window.onDidChangeTextEditorSelection(schedule),
    vscode.window.onDidChangeActiveTextEditor(schedule),
  ];

  // Initial push shortly after connect-ready
  schedule();

  return {
    dispose() {
      if (timer) clearTimeout(timer);
      for (const s of subs) s.dispose();
    },
  };
}
