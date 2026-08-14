/**
 * Localhost JSON-RPC WebSocket server — Desktop ↔ Plugin bridge.
 */
import { createServer, type Server } from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import * as vscode from "vscode";
import {
  IdeMethods,
  IdeNotifications,
  IDE_PROTOCOL_VERSION,
  EXTENSION_CAPABILITIES,
  createDiscovery,
  writeBridgeDiscovery,
  clearBridgeDiscovery,
  defaultBridgeDiscoveryPath,
  makeError,
  makeSuccess,
  makeNotification,
  isRequest,
  parseJsonRpcMessage,
  RpcErrorCode,
  type FocusChangedParams,
  type BridgeHealth,
  type IdeBridgeDiscovery,
  type CreateTestFileParams,
  type OpenFileParams,
  type SearchSymbolParams,
  type SearchTextParams,
  type SymbolPositionParams,
  type ReadFileParams,
  type CodegenApplyFilesParams,
  type CodegenRunTestsParams,
  type CodegenCancelParams,
  type CodegenGenerateUnitBatchParams,
  type CodegenGenerateE2eBatchParams,
  type CodegenOpenSessionParams,
  type CodegenCloseSessionParams,
  type TcSyncApprovedMdParams,
} from "@aitest/ide-protocol/node";
import {
  buildFocusSnapshot,
  buildSemanticPacket,
  detectIde,
  getCurrentSelection,
  symbolInfoFromFocus,
  toRel,
  workspaceRoot,
} from "./semanticContext";
import {
  handleFindImplementations,
  handleFindReferences,
  handleGoToDefinition,
  handleReadFile,
  handleSearchSymbol,
  handleSearchText,
} from "./ideCommands";
import {
  handleCodegenApplyFiles,
  handleCodegenCancel,
  handleCodegenRunTests,
} from "./codegenCommands";
import { handleTcSyncApprovedMd } from "./tcSyncCommands";
import { handleCodegenGenerateUnitBatch } from "./unitGenCommands";
import { handleCodegenGenerateE2eBatch } from "./e2eGenCommands";

export type BridgeHandle = {
  port: number;
  token: string;
  discoveryPath: string;
  url: string;
  clientCount: () => number;
  notifyFocusChanged: (params: FocusChangedParams) => void;
  close: () => Promise<void>;
};

export async function startIdeBridgeServer(opts?: {
  onClientsChanged?: () => void;
}): Promise<BridgeHandle> {
  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });
  const authed = new WeakSet<WebSocket>();
  const clients = new Set<WebSocket>();
  const onClientsChanged = opts?.onClientsChanged;

  let discovery!: IdeBridgeDiscovery;

  wss.on("connection", (socket) => {
    clients.add(socket);
    onClientsChanged?.();
    socket.on("close", () => {
      clients.delete(socket);
      onClientsChanged?.();
    });
    socket.on("message", (buf) => {
      void handleMessage(socket, buf.toString("utf8"));
    });
  });

  async function handleMessage(socket: WebSocket, raw: string): Promise<void> {
    const reply = (body: unknown) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(body));
    };

    let msg: unknown;
    try {
      msg = parseJsonRpcMessage(raw);
    } catch {
      reply(makeError(null, RpcErrorCode.parseError, "Parse error"));
      return;
    }
    if (!isRequest(msg)) return;

    try {
      if (msg.method === IdeMethods.auth) {
        const token = (msg.params as { token?: string } | undefined)?.token;
        if (token !== discovery.token) {
          reply(makeError(msg.id, RpcErrorCode.unauthorized, "Invalid token"));
          return;
        }
        authed.add(socket);
        reply(makeSuccess(msg.id, { ok: true, ide: detectIde() }));
        return;
      }

      if (!authed.has(socket)) {
        reply(makeError(msg.id, RpcErrorCode.unauthorized, "Not authenticated"));
        return;
      }

      switch (msg.method) {
        case IdeMethods.health: {
          const snap = await buildFocusSnapshot();
          let extensionVersion: string | undefined;
          try {
            extensionVersion = vscode.extensions.getExtension("aitest.aitest-ide")
              ?.packageJSON?.version;
          } catch {
            /* ignore */
          }
          const health: BridgeHealth = {
            status: "connected",
            ide: detectIde(),
            protocolVersion: IDE_PROTOCOL_VERSION,
            workspaceRoot: workspaceRoot() || undefined,
            focus: snap?.focus,
            capabilities: [...EXTENSION_CAPABILITIES],
            extensionVersion,
            supportedMethods: [
              IdeMethods.getSemanticContext,
              IdeMethods.searchSymbol,
              IdeMethods.searchText,
              IdeMethods.goToDefinition,
              IdeMethods.findReferences,
              IdeMethods.findImplementations,
              IdeMethods.readFile,
              IdeMethods.createTestFile,
              IdeMethods.openFile,
              IdeMethods.codegenApplyFiles,
              IdeMethods.codegenRunTests,
              IdeMethods.codegenCancel,
              IdeMethods.codegenGenerateUnitBatch,
              IdeMethods.codegenGenerateE2eBatch,
              IdeMethods.codegenOpenSession,
              IdeMethods.codegenCloseSession,
              IdeMethods.tcSyncApprovedMd,
            ],
          };
          reply(makeSuccess(msg.id, health));
          break;
        }
        case IdeMethods.getSemanticContext: {
          const params = (msg.params ?? {}) as {
            includeDependencies?: boolean;
            maxSnippetChars?: number;
          };
          const packet = await buildSemanticPacket({
            includeDependencies: params.includeDependencies !== false,
            maxSnippetChars: params.maxSnippetChars,
          });
          if (!packet) {
            reply(makeError(msg.id, RpcErrorCode.unavailable, "No active editor"));
            break;
          }
          reply(makeSuccess(msg.id, packet));
          break;
        }
        case IdeMethods.getCurrentFile: {
          const ed = vscode.window.activeTextEditor;
          if (!ed || ed.document.uri.scheme !== "file") {
            reply(makeSuccess(msg.id, null));
            break;
          }
          reply(
            makeSuccess(msg.id, {
              pathRel: toRel(ed.document.uri.fsPath),
              language: ed.document.languageId,
            })
          );
          break;
        }
        case IdeMethods.getCurrentSelection: {
          reply(makeSuccess(msg.id, await getCurrentSelection()));
          break;
        }
        case IdeMethods.getCurrentMethod: {
          const snap = await buildFocusSnapshot();
          reply(makeSuccess(msg.id, snap ? symbolInfoFromFocus(snap.focus, "method") : null));
          break;
        }
        case IdeMethods.getCurrentClass: {
          const snap = await buildFocusSnapshot();
          reply(makeSuccess(msg.id, snap ? symbolInfoFromFocus(snap.focus, "class") : null));
          break;
        }
        case IdeMethods.searchSymbol: {
          const p = (msg.params ?? {}) as SearchSymbolParams;
          reply(makeSuccess(msg.id, await handleSearchSymbol(p)));
          break;
        }
        case IdeMethods.searchText: {
          const p = (msg.params ?? {}) as SearchTextParams;
          reply(makeSuccess(msg.id, await handleSearchText(p)));
          break;
        }
        case IdeMethods.goToDefinition: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, await handleGoToDefinition(p)));
          break;
        }
        case IdeMethods.findReferences: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, await handleFindReferences(p)));
          break;
        }
        case IdeMethods.findImplementations: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, await handleFindImplementations(p)));
          break;
        }
        case IdeMethods.readFile: {
          const p = (msg.params ?? {}) as ReadFileParams;
          if (!p?.pathRel) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "pathRel required"));
            break;
          }
          reply(makeSuccess(msg.id, await handleReadFile(p)));
          break;
        }
        case IdeMethods.createTestFile: {
          const p = msg.params as CreateTestFileParams;
          const root = workspaceRoot();
          if (!root || !p?.pathRel) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "pathRel required"));
            break;
          }
          const uri = vscode.Uri.file(
            `${root.replace(/[\\/]$/, "")}/${p.pathRel.replace(/\\/g, "/")}`
          );
          const enc = new TextEncoder();
          await vscode.workspace.fs.writeFile(uri, enc.encode(p.content ?? ""));
          if (p.open) {
            const doc = await vscode.workspace.openTextDocument(uri);
            await vscode.window.showTextDocument(doc);
          }
          reply(makeSuccess(msg.id, { ok: true, pathRel: p.pathRel }));
          break;
        }
        case IdeMethods.openFile: {
          const p = msg.params as OpenFileParams;
          const root = workspaceRoot();
          if (!root || !p?.pathRel) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "pathRel required"));
            break;
          }
          const uri = vscode.Uri.file(
            `${root.replace(/[\\/]$/, "")}/${p.pathRel.replace(/\\/g, "/")}`
          );
          const doc = await vscode.workspace.openTextDocument(uri);
          await vscode.window.showTextDocument(doc);
          reply(makeSuccess(msg.id, { ok: true }));
          break;
        }
        case IdeMethods.runTest: {
          reply(
            makeSuccess(msg.id, {
              ok: false,
              message: "Use aitest/codegen.runTests for Unit/E2E (codegen protocol)",
            })
          );
          break;
        }
        case IdeMethods.codegenApplyFiles: {
          const p = msg.params as CodegenApplyFilesParams;
          if (!p?.commandId || !Array.isArray(p.files)) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId + files required"));
            break;
          }
          const notify = (method: string, params: unknown) => {
            const body = JSON.stringify(makeNotification(method, params));
            for (const c of clients) {
              if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
            }
          };
          reply(makeSuccess(msg.id, await handleCodegenApplyFiles(p, notify)));
          break;
        }
        case IdeMethods.codegenRunTests: {
          const p = msg.params as CodegenRunTestsParams;
          if (!p?.commandId || !p.runner) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId + runner required"));
            break;
          }
          const notify = (method: string, params: unknown) => {
            const body = JSON.stringify(makeNotification(method, params));
            for (const c of clients) {
              if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
            }
          };
          reply(makeSuccess(msg.id, await handleCodegenRunTests(p, notify)));
          break;
        }
        case IdeMethods.codegenCancel: {
          const p = (msg.params ?? {}) as CodegenCancelParams;
          if (!p?.commandId) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId required"));
            break;
          }
          reply(makeSuccess(msg.id, handleCodegenCancel({ ...p, action: "CANCEL" })));
          break;
        }
        case IdeMethods.codegenOpenSession: {
          const p = (msg.params ?? {}) as CodegenOpenSessionParams;
          const root = (p.projectRoot || workspaceRoot() || "").trim();
          if (!root) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "projectRoot required"));
            break;
          }
          try {
            const { openAgentCliSession } = await import("./agentCliSession");
            const session = openAgentCliSession(root);
            reply(
              makeSuccess(msg.id, {
                ok: true,
                sessionId: session.id,
                workspaceRoot: session.workspaceRoot,
                capabilities: [...EXTENSION_CAPABILITIES],
              })
            );
          } catch (e) {
            reply(
              makeError(
                msg.id,
                RpcErrorCode.internal,
                e instanceof Error ? e.message : String(e)
              )
            );
          }
          break;
        }
        case IdeMethods.codegenCloseSession: {
          const p = (msg.params ?? {}) as CodegenCloseSessionParams;
          if (!p?.sessionId) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "sessionId required"));
            break;
          }
          const { closeAgentCliSession } = await import("./agentCliSession");
          reply(makeSuccess(msg.id, closeAgentCliSession(p.sessionId)));
          break;
        }
        case IdeMethods.codegenGenerateUnitBatch: {
          const p = (msg.params ?? {}) as CodegenGenerateUnitBatchParams;
          if (!p?.commandId || !Array.isArray(p.items)) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId + items required"));
            break;
          }
          const notify: (method: string, params: unknown) => void = (method, params) => {
            const body = JSON.stringify(makeNotification(method, params));
            for (const c of clients) {
              if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
            }
          };
          reply(makeSuccess(msg.id, await handleCodegenGenerateUnitBatch(p, notify)));
          break;
        }
        case IdeMethods.codegenGenerateE2eBatch: {
          const p = (msg.params ?? {}) as CodegenGenerateE2eBatchParams;
          if (!p?.commandId || !Array.isArray(p.items)) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId + items required"));
            break;
          }
          const notify: (method: string, params: unknown) => void = (method, params) => {
            const body = JSON.stringify(makeNotification(method, params));
            for (const c of clients) {
              if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
            }
          };
          reply(makeSuccess(msg.id, await handleCodegenGenerateE2eBatch(p, notify)));
          break;
        }
        case IdeMethods.tcSyncApprovedMd: {
          const p = msg.params as TcSyncApprovedMdParams;
          if (!p?.commandId || !Array.isArray(p.files)) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "commandId + files required"));
            break;
          }
          reply(makeSuccess(msg.id, await handleTcSyncApprovedMd(p)));
          break;
        }
        default:
          reply(makeError(msg.id, RpcErrorCode.methodNotFound, `Method not found: ${msg.method}`));
      }
    } catch (e) {
      reply(
        makeError(
          msg.id,
          RpcErrorCode.internalError,
          e instanceof Error ? e.message : "Internal error"
        )
      );
    }
  }

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });

  const discoveryPath = defaultBridgeDiscoveryPath();
  discovery = createDiscovery({
    port,
    ide: detectIde(),
    workspaceRoot: workspaceRoot() || undefined,
  });
  writeBridgeDiscovery(discovery, discoveryPath);

  return {
    port,
    token: discovery.token,
    discoveryPath,
    url: `ws://127.0.0.1:${port}/`,
    clientCount: () => clients.size,
    notifyFocusChanged: (params) => {
      const body = JSON.stringify(makeNotification(IdeNotifications.focusChanged, params));
      for (const c of clients) {
        if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
      }
    },
    close: async () => {
      clearBridgeDiscovery(discoveryPath);
      for (const c of wss.clients) c.terminate();
      await new Promise<void>((r) => wss.close(() => r()));
      await new Promise<void>((r, j) => httpServer.close((e) => (e ? j(e) : r())));
    },
  };
}
