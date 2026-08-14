/**
 * JSON-RPC WebSocket client — Browser (Desktop) and Node (tests via WebSocketImpl).
 */
import {
  isNotification,
  isResponse,
  makeRequest,
  parseJsonRpcMessage,
  type JsonRpcId,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from "./rpc.js";
import { IdeMethods, type AuthParams, type GetSemanticContextParams } from "./methods.js";
import type {
  BridgeHealth,
  IdeSemanticPacket,
  SymbolInfo,
  SymbolRef,
} from "./types.js";
import type {
  FindImplementationsResult,
  FindReferencesResult,
  GoToDefinitionResult,
  ReadFileParams,
  ReadFileResult,
  SearchSymbolParams,
  SearchSymbolResult,
  SearchTextParams,
  SearchTextResult,
  SymbolPositionParams,
} from "./methods.js";
import { assertIdeSemanticPacket } from "./validate.js";

/** Minimal WS surface used by the client */
export type WsLike = {
  readyState: number;
  send(data: string): void;
  close(): void;
  addEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
  removeEventListener?(type: string, listener: (ev: { data?: unknown }) => void): void;
  on?(event: string, listener: (...args: unknown[]) => void): void;
};

export type IdeRpcClientOptions = {
  url: string;
  token: string;
  /** Browser: omit (uses global WebSocket). Node tests: pass `ws` default export. */
  WebSocketImpl?: new (url: string) => WsLike;
  requestTimeoutMs?: number;
};

type Pending = {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

const WS_OPEN = 1;

function bindWs(
  ws: WsLike,
  handlers: {
    open: () => void;
    error: () => void;
    message: (raw: string) => void;
    close: () => void;
  }
): void {
  if (typeof ws.addEventListener === "function") {
    ws.addEventListener("open", () => handlers.open());
    ws.addEventListener("error", () => handlers.error());
    ws.addEventListener("message", (ev) => {
      const data = ev.data;
      handlers.message(typeof data === "string" ? data : String(data));
    });
    ws.addEventListener("close", () => handlers.close());
    return;
  }
  ws.on?.("open", handlers.open);
  ws.on?.("error", handlers.error);
  ws.on?.("message", (data: unknown) => {
    let raw: string;
    if (typeof data === "string") {
      raw = data;
    } else if (data && typeof data === "object" && "toString" in data) {
      raw = (data as { toString: (enc?: string) => string }).toString("utf8");
    } else {
      raw = String(data);
    }
    handlers.message(raw);
  });
  ws.on?.("close", handlers.close);
}

export type NotificationHandler = (method: string, params: unknown) => void;

export class IdeRpcClient {
  private ws: WsLike | null = null;
  private pending = new Map<string, Pending>();
  private authed = false;
  private readonly timeoutMs: number;
  private notificationHandlers = new Set<NotificationHandler>();

  constructor(private readonly opts: IdeRpcClientOptions) {
    this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
  }

  /** Subscribe to Plugin → Desktop notifications (e.g. aitest/focusChanged). */
  onNotification(handler: NotificationHandler): () => void {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  get isConnected(): boolean {
    return Boolean(this.ws && this.ws.readyState === WS_OPEN && this.authed);
  }

  async connect(): Promise<void> {
    if (this.ws && this.ws.readyState === WS_OPEN) return;
    const Impl = this.opts.WebSocketImpl ?? (globalThis as { WebSocket?: new (u: string) => WsLike }).WebSocket;
    if (!Impl) {
      throw new Error("WebSocket not available — pass WebSocketImpl in Node");
    }
    await new Promise<void>((resolve, reject) => {
      const ws = new Impl(this.opts.url);
      this.ws = ws;
      let settled = false;
      bindWs(ws, {
        open: () => {
          if (!settled) {
            settled = true;
            resolve();
          }
        },
        error: () => {
          if (!settled) {
            settled = true;
            reject(new Error("IDE bridge WebSocket error"));
          }
        },
        message: (raw) => this.onMessage(raw),
        close: () => {
          this.authed = false;
          for (const [, p] of this.pending) {
            clearTimeout(p.timer);
            p.reject(new Error("IDE bridge closed"));
          }
          this.pending.clear();
        },
      });
    });
    await this.auth();
  }

  disconnect(): void {
    this.ws?.close();
    this.ws = null;
    this.authed = false;
  }

  private onMessage(raw: string): void {
    let msg: unknown;
    try {
      msg = parseJsonRpcMessage(raw);
    } catch {
      return;
    }
    if (isNotification(msg)) {
      const n = msg as JsonRpcNotification;
      for (const h of this.notificationHandlers) {
        try {
          h(n.method, n.params);
        } catch {
          /* ignore handler errors */
        }
      }
      return;
    }
    if (!isResponse(msg)) return;
    const key = String(msg.id);
    const pending = this.pending.get(key);
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(key);
    if ("error" in msg && msg.error) {
      pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
    } else {
      pending.resolve((msg as { result: unknown }).result);
    }
  }

  async request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T> {
    if (!this.ws || this.ws.readyState !== WS_OPEN) {
      throw new Error("IDE bridge not connected");
    }
    const req: JsonRpcRequest = makeRequest(method, params);
    const key = String(req.id);
    const waitMs = timeoutMs ?? this.timeoutMs;
    const result = await new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(key);
        reject(new Error(`IDE RPC timeout: ${method}`));
      }, waitMs);
      this.pending.set(key, { resolve, reject, timer });
      this.ws!.send(JSON.stringify(req));
    });
    return result as T;
  }

  private async auth(): Promise<void> {
    const params: AuthParams = { token: this.opts.token };
    await this.request(IdeMethods.auth, params);
    this.authed = true;
  }

  health(): Promise<BridgeHealth> {
    return this.request(IdeMethods.health);
  }

  async getSemanticContext(params?: GetSemanticContextParams): Promise<IdeSemanticPacket> {
    const raw = await this.request<unknown>(IdeMethods.getSemanticContext, params ?? {});
    return assertIdeSemanticPacket(raw);
  }

  getCurrentMethod(): Promise<SymbolInfo | null> {
    return this.request(IdeMethods.getCurrentMethod);
  }

  getCurrentClass(): Promise<SymbolInfo | null> {
    return this.request(IdeMethods.getCurrentClass);
  }

  getCurrentFile(): Promise<{ pathRel: string; language?: string } | null> {
    return this.request(IdeMethods.getCurrentFile);
  }

  /** P5 — Apply helpers */
  createTestFile(params: {
    pathRel: string;
    content: string;
    open?: boolean;
  }): Promise<{ ok: boolean; pathRel?: string }> {
    return this.request(IdeMethods.createTestFile, params);
  }

  openFile(params: { pathRel: string }): Promise<{ ok: boolean }> {
    return this.request(IdeMethods.openFile, params);
  }

  /** P10 — Command Layer */
  searchSymbol(params: SearchSymbolParams): Promise<SearchSymbolResult> {
    return this.request(IdeMethods.searchSymbol, params);
  }

  searchText(params: SearchTextParams): Promise<SearchTextResult> {
    return this.request(IdeMethods.searchText, params);
  }

  goToDefinition(params: SymbolPositionParams): Promise<GoToDefinitionResult> {
    return this.request(IdeMethods.goToDefinition, params);
  }

  findReferences(params?: SymbolPositionParams): Promise<FindReferencesResult | SymbolRef[]> {
    return this.request(IdeMethods.findReferences, params ?? {});
  }

  findImplementations(params?: SymbolPositionParams): Promise<FindImplementationsResult> {
    return this.request(IdeMethods.findImplementations, params ?? {});
  }

  readFile(params: ReadFileParams): Promise<ReadFileResult> {
    return this.request(IdeMethods.readFile, params);
  }

  /** Codegen Protocol — Apply / Run / Gen */
  codegenApplyFiles(
    params: import("./codegenTypes.js").CodegenApplyFilesParams
  ): Promise<import("./codegenTypes.js").CodegenApplyFilesResult> {
    return this.request(IdeMethods.codegenApplyFiles, params, this.timeoutMs * 6);
  }

  codegenRunTests(
    params: import("./codegenTypes.js").CodegenRunTestsParams
  ): Promise<import("./codegenTypes.js").CodegenRunTestsResult> {
    return this.request(IdeMethods.codegenRunTests, params, this.timeoutMs * 30);
  }

  codegenCancel(params: { commandId: string }): Promise<{ ok: boolean }> {
    return this.request(IdeMethods.codegenCancel, {
      ...params,
      action: "CANCEL",
    });
  }

  codegenGenerateUnitBatch(
    params: import("./codegenTypes.js").CodegenGenerateUnitBatchParams
  ): Promise<import("./codegenTypes.js").CodegenResultCallback> {
    return this.request(IdeMethods.codegenGenerateUnitBatch, params, this.timeoutMs * 30);
  }

  codegenGenerateE2eBatch(
    params: import("./codegenTypes.js").CodegenGenerateE2eBatchParams
  ): Promise<import("./codegenTypes.js").CodegenResultCallback> {
    return this.request(IdeMethods.codegenGenerateE2eBatch, params, this.timeoutMs * 30);
  }

  /** Phase 2 — open reusable AI CLI / workspace session */
  codegenOpenSession(
    params: import("./codegenTypes.js").CodegenOpenSessionParams
  ): Promise<import("./codegenTypes.js").CodegenOpenSessionResult> {
    return this.request(IdeMethods.codegenOpenSession, params, this.timeoutMs * 3);
  }

  codegenCloseSession(
    params: import("./codegenTypes.js").CodegenCloseSessionParams
  ): Promise<import("./codegenTypes.js").CodegenCloseSessionResult> {
    return this.request(IdeMethods.codegenCloseSession, params);
  }

  /** Phase C — write Approved TC markdown under `.ai-test/test-cases/` */
  tcSyncApprovedMd(
    params: import("./tcTypes.js").TcSyncApprovedMdParams
  ): Promise<import("./tcTypes.js").TcSyncApprovedMdResult> {
    return this.request(IdeMethods.tcSyncApprovedMd, params, this.timeoutMs * 6);
  }
}

export function rpcIdKey(id: JsonRpcId): string {
  return String(id);
}
