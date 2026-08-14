/**
 * In-process / Node mock IDE plugin server (P0/P1 DoD).
 */
import { WebSocketServer, WebSocket } from "ws";
import type { Server } from "node:http";
import { createServer } from "node:http";
import {
  isRequest,
  makeError,
  makeNotification,
  makeSuccess,
  parseJsonRpcMessage,
  RpcErrorCode,
} from "../rpc.js";
import { IdeMethods, IdeNotifications, type FocusChangedParams } from "../methods.js";
import { IDE_PROTOCOL_VERSION } from "../constants.js";
import { EXTENSION_CAPABILITIES } from "../capabilities.js";
import type { BridgeHealth, IdeSemanticPacket } from "../types.js";
import {
  clearBridgeDiscovery,
  createDiscovery,
  writeBridgeDiscovery,
} from "../bridgeFs.js";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  defaultMockFiles,
  defaultMockSymbols,
  mockFindImplementations,
  mockFindReferences,
  mockGoToDefinition,
  mockReadFile,
  mockSearchSymbol,
  mockSearchText,
} from "./commandCatalog.js";
import type {
  ReadFileParams,
  SearchSymbolParams,
  SearchTextParams,
  SymbolPositionParams,
} from "../methods.js";

export type MockIdeOptions = {
  token?: string;
  workspaceRoot?: string;
  /** Discovery file path (default under tmp) */
  discoveryPath?: string;
  packet?: IdeSemanticPacket;
};

export type MockIdeHandle = {
  port: number;
  token: string;
  discoveryPath: string;
  url: string;
  /** Push focusChanged to all authenticated clients (P1) */
  notifyFocusChanged: (params: FocusChangedParams) => void;
  close: () => Promise<void>;
};

function defaultPacket(workspaceRoot: string): IdeSemanticPacket {
  return {
    protocolVersion: 1,
    ide: "mock",
    workspaceRoot,
    language: "typescript",
    frameworkHints: ["jest"],
    focus: {
      file: "src/auth/auth.service.ts",
      symbol: "AuthService",
      kind: "class",
      method: "login",
      range: { start: 10, end: 25 },
    },
    signatures: ["login(email: string, password: string): Promise<Token>"],
    constructors: [{ params: [{ name: "users", type: "UserRepository" }] }],
    imports: ["./user.repository"],
    dependencies: [
      {
        path: "src/auth/user.repository.ts",
        role: "constructor",
        symbol: "UserRepository",
        snippet: "export class UserRepository { findByEmail() {} }",
      },
    ],
    references: [],
    implementations: [],
    callHierarchy: { callees: [], callers: [] },
    focusSnippet:
      "export class AuthService {\n  constructor(private users: UserRepository) {}\n  async login() {}\n}\n",
    diagnostics: { confidence: "high", gaps: [] },
  };
}

export async function startMockIdeServer(opts: MockIdeOptions = {}): Promise<MockIdeHandle> {
  const workspaceRoot = opts.workspaceRoot ?? "D:/Project/Demo";
  const packet = opts.packet ?? defaultPacket(workspaceRoot);
  const mockFiles = defaultMockFiles();
  const mockSymbols = defaultMockSymbols();
  const discoveryPath =
    opts.discoveryPath ?? join(tmpdir(), "aitest-p0-mock", `ide-bridge-${Date.now()}.json`);

  const httpServer: Server = createServer();
  const wss = new WebSocketServer({ server: httpServer });

  const authed = new WeakSet<WebSocket>();
  const clients = new Set<WebSocket>();

  wss.on("connection", (socket) => {
    clients.add(socket);
    socket.on("close", () => clients.delete(socket));
    socket.on("message", (buf) => {
      let msg: unknown;
      try {
        msg = parseJsonRpcMessage(buf.toString("utf8"));
      } catch {
        socket.send(JSON.stringify(makeError(null, RpcErrorCode.parseError, "Parse error")));
        return;
      }
      if (!isRequest(msg)) return;

      const reply = (body: unknown) => socket.send(JSON.stringify(body));

      if (msg.method === IdeMethods.auth) {
        const token = (msg.params as { token?: string } | undefined)?.token;
        if (token !== discovery.token) {
          reply(makeError(msg.id, RpcErrorCode.unauthorized, "Invalid token"));
          return;
        }
        authed.add(socket);
        reply(makeSuccess(msg.id, { ok: true, ide: "mock" }));
        return;
      }

      if (!authed.has(socket)) {
        reply(makeError(msg.id, RpcErrorCode.unauthorized, "Not authenticated"));
        return;
      }

      switch (msg.method) {
        case IdeMethods.health: {
          const health: BridgeHealth = {
            status: "connected",
            ide: "mock",
            protocolVersion: IDE_PROTOCOL_VERSION,
            workspaceRoot,
            focus: packet.focus,
            capabilities: [...EXTENSION_CAPABILITIES],
            extensionVersion: "mock",
            supportedMethods: [
              IdeMethods.searchSymbol,
              IdeMethods.searchText,
              IdeMethods.goToDefinition,
              IdeMethods.findReferences,
              IdeMethods.readFile,
              IdeMethods.codegenOpenSession,
              IdeMethods.codegenCloseSession,
            ],
          };
          reply(makeSuccess(msg.id, health));
          break;
        }
        case IdeMethods.getSemanticContext:
          reply(makeSuccess(msg.id, packet));
          break;
        case IdeMethods.getCurrentMethod:
          reply(
            makeSuccess(msg.id, {
              name: packet.focus.method || packet.focus.symbol,
              kind: "method",
              file: packet.focus.file,
              containerName: packet.focus.symbol,
              range: packet.focus.range,
            })
          );
          break;
        case IdeMethods.getCurrentClass:
          reply(
            makeSuccess(msg.id, {
              name: packet.focus.symbol,
              kind: packet.focus.kind,
              file: packet.focus.file,
              range: packet.focus.range,
            })
          );
          break;
        case IdeMethods.getCurrentFile:
          reply(
            makeSuccess(msg.id, {
              pathRel: packet.focus.file,
              language: packet.language,
            })
          );
          break;
        case IdeMethods.getCurrentSelection:
          reply(
            makeSuccess(msg.id, {
              file: packet.focus.file,
              text: packet.focus.method || packet.focus.symbol,
              range: packet.focus.range,
            })
          );
          break;
        case IdeMethods.createTestFile:
          reply(makeSuccess(msg.id, { ok: true }));
          break;
        case IdeMethods.openFile:
          reply(makeSuccess(msg.id, { ok: true }));
          break;
        case IdeMethods.searchSymbol: {
          const p = (msg.params ?? {}) as SearchSymbolParams;
          reply(makeSuccess(msg.id, mockSearchSymbol(mockSymbols, p)));
          break;
        }
        case IdeMethods.searchText: {
          const p = (msg.params ?? {}) as SearchTextParams;
          reply(makeSuccess(msg.id, mockSearchText(mockFiles, p)));
          break;
        }
        case IdeMethods.goToDefinition: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, mockGoToDefinition(mockSymbols, p)));
          break;
        }
        case IdeMethods.findReferences: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, mockFindReferences(mockSymbols, mockFiles, p)));
          break;
        }
        case IdeMethods.findImplementations: {
          const p = (msg.params ?? {}) as SymbolPositionParams;
          reply(makeSuccess(msg.id, mockFindImplementations(mockSymbols, p)));
          break;
        }
        case IdeMethods.readFile: {
          const p = (msg.params ?? {}) as ReadFileParams;
          if (!p?.pathRel) {
            reply(makeError(msg.id, RpcErrorCode.invalidParams, "pathRel required"));
            break;
          }
          reply(makeSuccess(msg.id, mockReadFile(mockFiles, p)));
          break;
        }
        default:
          reply(makeError(msg.id, RpcErrorCode.methodNotFound, `Method not found: ${msg.method}`));
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    httpServer.listen(0, "127.0.0.1", () => {
      const addr = httpServer.address();
      if (addr && typeof addr === "object") resolve(addr.port);
      else reject(new Error("no port"));
    });
  });

  const discovery = createDiscovery({
    port,
    ide: "mock",
    token: opts.token,
    workspaceRoot,
  });
  writeBridgeDiscovery(discovery, discoveryPath);

  return {
    port,
    token: discovery.token,
    discoveryPath,
    url: `ws://127.0.0.1:${port}/`,
    notifyFocusChanged: (params) => {
      const body = JSON.stringify(makeNotification(IdeNotifications.focusChanged, params));
      for (const c of clients) {
        if (authed.has(c) && c.readyState === WebSocket.OPEN) c.send(body);
      }
    },
    close: async () => {
      clearBridgeDiscovery(discoveryPath);
      for (const client of wss.clients) {
        client.terminate();
      }
      await new Promise<void>((resolve) => {
        wss.close(() => resolve());
      });
      await new Promise<void>((resolve, reject) => {
        httpServer.close((err) => (err ? reject(err) : resolve()));
      });
    },
  };
}
