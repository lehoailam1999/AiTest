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
export const RpcErrorCode = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  /** Auth token missing / mismatch */
  unauthorized: -32001,
  /** Bridge not ready / IDE degraded */
  unavailable: -32002,
} as const;

let _id = 1;
export function nextRpcId(): number {
  return _id++;
}

export function makeRequest<T>(method: string, params?: T, id?: JsonRpcId): JsonRpcRequest<T> {
  return {
    jsonrpc: "2.0",
    id: id ?? nextRpcId(),
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function makeSuccess<T>(id: JsonRpcId, result: T): JsonRpcSuccess<T> {
  return { jsonrpc: "2.0", id, result };
}

export function makeError(
  id: JsonRpcId | null,
  code: number,
  message: string,
  data?: unknown
): JsonRpcFailure {
  return {
    jsonrpc: "2.0",
    id,
    error: { code, message, ...(data !== undefined ? { data } : {}) },
  };
}

export function isRequest(msg: unknown): msg is JsonRpcRequest {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && "id" in m;
}

export function isResponse(msg: unknown): msg is JsonRpcResponse {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && "id" in m && ("result" in m || "error" in m);
}

export function isNotification(msg: unknown): msg is JsonRpcNotification {
  if (!msg || typeof msg !== "object") return false;
  const m = msg as Record<string, unknown>;
  return m.jsonrpc === "2.0" && typeof m.method === "string" && !("id" in m);
}

export function makeNotification<T>(method: string, params?: T): JsonRpcNotification<T> {
  return {
    jsonrpc: "2.0",
    method,
    ...(params !== undefined ? { params } : {}),
  };
}

export function parseJsonRpcMessage(raw: string): unknown {
  try {
    return JSON.parse(raw) as unknown;
  } catch {
    throw Object.assign(new Error("JSON-RPC parse error"), { code: RpcErrorCode.parseError });
  }
}
