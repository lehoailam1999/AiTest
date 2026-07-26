import * as vscode from "vscode";
import { startIdeBridgeServer, type BridgeHandle } from "./bridgeServer";
import { attachFocusTracker } from "./focusTracker";
import { buildFocusSnapshot } from "./semanticContext";

let bridge: BridgeHandle | null = null;
let focusSub: vscode.Disposable | null = null;
let statusBar: vscode.StatusBarItem | null = null;

function debounceMs(): number {
  return vscode.workspace.getConfiguration("aitest").get<number>("bridge.focusDebounceMs", 250);
}

function updateStatus(): void {
  if (!statusBar) return;
  if (!bridge) {
    statusBar.text = "$(debug-disconnect) AITest";
    statusBar.tooltip = "AITest bridge stopped";
    return;
  }
  statusBar.text = `$(plug) AITest :${bridge.port}`;
  statusBar.tooltip = `AITest IDE bridge\n${bridge.url}\nclients: ${bridge.clientCount()}\n${bridge.discoveryPath}`;
}

async function startBridge(context: vscode.ExtensionContext): Promise<void> {
  if (bridge) {
    void vscode.window.showInformationMessage(`AITest bridge already running on :${bridge.port}`);
    return;
  }
  bridge = await startIdeBridgeServer({ onClientsChanged: updateStatus });
  focusSub = attachFocusTracker(bridge, debounceMs);
  context.subscriptions.push({
    dispose: () => {
      focusSub?.dispose();
      focusSub = null;
    },
  });
  updateStatus();
  void vscode.window.setStatusBarMessage(`AITest bridge :${bridge.port}`, 3000);
}

async function stopBridge(): Promise<void> {
  focusSub?.dispose();
  focusSub = null;
  if (bridge) {
    await bridge.close();
    bridge = null;
  }
  updateStatus();
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Right, 100);
  statusBar.command = "aitest.showBridgeStatus";
  statusBar.show();
  context.subscriptions.push(statusBar);

  context.subscriptions.push(
    vscode.commands.registerCommand("aitest.startBridge", () => startBridge(context)),
    vscode.commands.registerCommand("aitest.stopBridge", () => stopBridge()),
    vscode.commands.registerCommand("aitest.showBridgeStatus", async () => {
      if (!bridge) {
        void vscode.window.showWarningMessage("AITest bridge is not running.");
        return;
      }
      const snap = await buildFocusSnapshot();
      const focus = snap
        ? `${snap.focus.symbol}${snap.focus.method ? "." + snap.focus.method : ""} (${snap.focus.file})`
        : "(no editor)";
      void vscode.window.showInformationMessage(
        `AITest bridge :${bridge.port} · clients ${bridge.clientCount()} · focus: ${focus}`
      );
    }),
    vscode.commands.registerCommand("aitest.refreshFocus", async () => {
      if (!bridge) {
        void vscode.window.showWarningMessage("Start the AITest bridge first.");
        return;
      }
      const snap = await buildFocusSnapshot();
      if (!snap) {
        void vscode.window.showWarningMessage("No active file editor.");
        return;
      }
      bridge.notifyFocusChanged({
        focus: snap.focus,
        confidence: snap.confidence,
        workspaceRoot: snap.workspaceRoot || undefined,
        language: snap.language,
      });
      void vscode.window.showInformationMessage(
        `Pushed focus: ${snap.focus.symbol}${snap.focus.method ? "." + snap.focus.method : ""}`
      );
    })
  );

  context.subscriptions.push({
    dispose: () => {
      void stopBridge();
    },
  });

  const auto = vscode.workspace.getConfiguration("aitest").get<boolean>("bridge.autoStart", true);
  if (auto) {
    try {
      await startBridge(context);
    } catch (e) {
      void vscode.window.showErrorMessage(
        `AITest bridge failed: ${e instanceof Error ? e.message : String(e)}`
      );
    }
  } else {
    updateStatus();
  }
}

export async function deactivate(): Promise<void> {
  await stopBridge();
}
