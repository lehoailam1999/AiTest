/** Minimal JSON-RPC 2.0 types + helpers (no transport). */
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
};
let _id = 1;
export function nextRpcId() {
    return _id++;
}
export function makeRequest(method, params, id) {
    return {
        jsonrpc: "2.0",
        id: id ?? nextRpcId(),
        method,
        ...(params !== undefined ? { params } : {}),
    };
}
export function makeSuccess(id, result) {
    return { jsonrpc: "2.0", id, result };
}
export function makeError(id, code, message, data) {
    return {
        jsonrpc: "2.0",
        id,
        error: { code, message, ...(data !== undefined ? { data } : {}) },
    };
}
export function isRequest(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    const m = msg;
    return m.jsonrpc === "2.0" && typeof m.method === "string" && "id" in m;
}
export function isResponse(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    const m = msg;
    return m.jsonrpc === "2.0" && "id" in m && ("result" in m || "error" in m);
}
export function isNotification(msg) {
    if (!msg || typeof msg !== "object")
        return false;
    const m = msg;
    return m.jsonrpc === "2.0" && typeof m.method === "string" && !("id" in m);
}
export function makeNotification(method, params) {
    return {
        jsonrpc: "2.0",
        method,
        ...(params !== undefined ? { params } : {}),
    };
}
export function parseJsonRpcMessage(raw) {
    try {
        return JSON.parse(raw);
    }
    catch {
        throw Object.assign(new Error("JSON-RPC parse error"), { code: RpcErrorCode.parseError });
    }
}
