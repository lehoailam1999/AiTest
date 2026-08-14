/** Minimal JSON-RPC 2.0 types + helpers (no transport). */
export type JsonRpcId = string | number;
export type JsonRpcRequest<T = unknown> = {
    jsonrpc: "2.0";
    id: JsonRpcId;
    method: string;
    params?: T;
};
export type JsonRpcSuccess<T = unknown> = {
    jsonrpc: "2.0";
    id: JsonRpcId;
    result: T;
};
export type JsonRpcErrorObject = {
    code: number;
    message: string;
    data?: unknown;
};
export type JsonRpcFailure = {
    jsonrpc: "2.0";
    id: JsonRpcId | null;
    error: JsonRpcErrorObject;
};
export type JsonRpcResponse<T = unknown> = JsonRpcSuccess<T> | JsonRpcFailure;
export type JsonRpcNotification<T = unknown> = {
    jsonrpc: "2.0";
    method: string;
    params?: T;
};
/** Standard JSON-RPC error codes + AITest bridge codes */
export declare const RpcErrorCode: {
    readonly parseError: -32700;
    readonly invalidRequest: -32600;
    readonly methodNotFound: -32601;
    readonly invalidParams: -32602;
    readonly internalError: -32603;
    /** Auth token missing / mismatch */
    readonly unauthorized: -32001;
    /** Bridge not ready / IDE degraded */
    readonly unavailable: -32002;
};
export declare function nextRpcId(): number;
export declare function makeRequest<T>(method: string, params?: T, id?: JsonRpcId): JsonRpcRequest<T>;
export declare function makeSuccess<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T>;
export declare function makeError(id: JsonRpcId | null, code: number, message: string, data?: unknown): JsonRpcFailure;
export declare function isRequest(msg: unknown): msg is JsonRpcRequest;
export declare function isResponse(msg: unknown): msg is JsonRpcResponse;
export declare function isNotification(msg: unknown): msg is JsonRpcNotification;
export declare function makeNotification<T>(method: string, params?: T): JsonRpcNotification<T>;
export declare function parseJsonRpcMessage(raw: string): unknown;
