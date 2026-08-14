/**
 * JSON-RPC WebSocket client — Browser (Desktop) and Node (tests via WebSocketImpl).
 */
import { type JsonRpcId } from "./rpc.js";
import { type GetSemanticContextParams } from "./methods.js";
import type { BridgeHealth, IdeSemanticPacket, SymbolInfo, SymbolRef } from "./types.js";
import type { FindImplementationsResult, FindReferencesResult, GoToDefinitionResult, ReadFileParams, ReadFileResult, SearchSymbolParams, SearchSymbolResult, SearchTextParams, SearchTextResult, SymbolPositionParams } from "./methods.js";
/** Minimal WS surface used by the client */
export type WsLike = {
    readyState: number;
    send(data: string): void;
    close(): void;
    addEventListener?(type: string, listener: (ev: {
        data?: unknown;
    }) => void): void;
    removeEventListener?(type: string, listener: (ev: {
        data?: unknown;
    }) => void): void;
    on?(event: string, listener: (...args: unknown[]) => void): void;
};
export type IdeRpcClientOptions = {
    url: string;
    token: string;
    /** Browser: omit (uses global WebSocket). Node tests: pass `ws` default export. */
    WebSocketImpl?: new (url: string) => WsLike;
    requestTimeoutMs?: number;
};
export type NotificationHandler = (method: string, params: unknown) => void;
export declare class IdeRpcClient {
    private readonly opts;
    private ws;
    private pending;
    private authed;
    private readonly timeoutMs;
    private notificationHandlers;
    constructor(opts: IdeRpcClientOptions);
    /** Subscribe to Plugin → Desktop notifications (e.g. aitest/focusChanged). */
    onNotification(handler: NotificationHandler): () => void;
    get isConnected(): boolean;
    connect(): Promise<void>;
    disconnect(): void;
    private onMessage;
    request<T>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
    private auth;
    health(): Promise<BridgeHealth>;
    getSemanticContext(params?: GetSemanticContextParams): Promise<IdeSemanticPacket>;
    getCurrentMethod(): Promise<SymbolInfo | null>;
    getCurrentClass(): Promise<SymbolInfo | null>;
    getCurrentFile(): Promise<{
        pathRel: string;
        language?: string;
    } | null>;
    /** P5 — Apply helpers */
    createTestFile(params: {
        pathRel: string;
        content: string;
        open?: boolean;
    }): Promise<{
        ok: boolean;
        pathRel?: string;
    }>;
    openFile(params: {
        pathRel: string;
    }): Promise<{
        ok: boolean;
    }>;
    /** P10 — Command Layer */
    searchSymbol(params: SearchSymbolParams): Promise<SearchSymbolResult>;
    searchText(params: SearchTextParams): Promise<SearchTextResult>;
    goToDefinition(params: SymbolPositionParams): Promise<GoToDefinitionResult>;
    findReferences(params?: SymbolPositionParams): Promise<FindReferencesResult | SymbolRef[]>;
    findImplementations(params?: SymbolPositionParams): Promise<FindImplementationsResult>;
    readFile(params: ReadFileParams): Promise<ReadFileResult>;
    /** Codegen Protocol — Apply / Run / Gen */
    codegenApplyFiles(params: import("./codegenTypes.js").CodegenApplyFilesParams): Promise<import("./codegenTypes.js").CodegenApplyFilesResult>;
    codegenRunTests(params: import("./codegenTypes.js").CodegenRunTestsParams): Promise<import("./codegenTypes.js").CodegenRunTestsResult>;
    codegenCancel(params: {
        commandId: string;
    }): Promise<{
        ok: boolean;
    }>;
    codegenGenerateUnitBatch(params: import("./codegenTypes.js").CodegenGenerateUnitBatchParams): Promise<import("./codegenTypes.js").CodegenResultCallback>;
    codegenGenerateE2eBatch(params: import("./codegenTypes.js").CodegenGenerateE2eBatchParams): Promise<import("./codegenTypes.js").CodegenResultCallback>;
    /** Phase 2 — open reusable AI CLI / workspace session */
    codegenOpenSession(params: import("./codegenTypes.js").CodegenOpenSessionParams): Promise<import("./codegenTypes.js").CodegenOpenSessionResult>;
    codegenCloseSession(params: import("./codegenTypes.js").CodegenCloseSessionParams): Promise<import("./codegenTypes.js").CodegenCloseSessionResult>;
    /** Phase C — write Approved TC markdown under `.ai-test/test-cases/` */
    tcSyncApprovedMd(params: import("./tcTypes.js").TcSyncApprovedMdParams): Promise<import("./tcTypes.js").TcSyncApprovedMdResult>;
}
export declare function rpcIdKey(id: JsonRpcId): string;
