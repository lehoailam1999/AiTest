/**
 * JSON-RPC WebSocket client — Browser (Desktop) and Node (tests via WebSocketImpl).
 */
import { isNotification, isResponse, makeRequest, parseJsonRpcMessage, } from "./rpc.js";
import { IdeMethods } from "./methods.js";
import { assertIdeSemanticPacket } from "./validate.js";
const WS_OPEN = 1;
function bindWs(ws, handlers) {
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
    ws.on?.("message", (data) => {
        let raw;
        if (typeof data === "string") {
            raw = data;
        }
        else if (data && typeof data === "object" && "toString" in data) {
            raw = data.toString("utf8");
        }
        else {
            raw = String(data);
        }
        handlers.message(raw);
    });
    ws.on?.("close", handlers.close);
}
export class IdeRpcClient {
    opts;
    ws = null;
    pending = new Map();
    authed = false;
    timeoutMs;
    notificationHandlers = new Set();
    constructor(opts) {
        this.opts = opts;
        this.timeoutMs = opts.requestTimeoutMs ?? 10_000;
    }
    /** Subscribe to Plugin → Desktop notifications (e.g. aitest/focusChanged). */
    onNotification(handler) {
        this.notificationHandlers.add(handler);
        return () => this.notificationHandlers.delete(handler);
    }
    get isConnected() {
        return Boolean(this.ws && this.ws.readyState === WS_OPEN && this.authed);
    }
    async connect() {
        if (this.ws && this.ws.readyState === WS_OPEN)
            return;
        const Impl = this.opts.WebSocketImpl ?? globalThis.WebSocket;
        if (!Impl) {
            throw new Error("WebSocket not available — pass WebSocketImpl in Node");
        }
        await new Promise((resolve, reject) => {
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
    disconnect() {
        this.ws?.close();
        this.ws = null;
        this.authed = false;
    }
    onMessage(raw) {
        let msg;
        try {
            msg = parseJsonRpcMessage(raw);
        }
        catch {
            return;
        }
        if (isNotification(msg)) {
            const n = msg;
            for (const h of this.notificationHandlers) {
                try {
                    h(n.method, n.params);
                }
                catch {
                    /* ignore handler errors */
                }
            }
            return;
        }
        if (!isResponse(msg))
            return;
        const key = String(msg.id);
        const pending = this.pending.get(key);
        if (!pending)
            return;
        clearTimeout(pending.timer);
        this.pending.delete(key);
        if ("error" in msg && msg.error) {
            pending.reject(new Error(`${msg.error.code}: ${msg.error.message}`));
        }
        else {
            pending.resolve(msg.result);
        }
    }
    async request(method, params, timeoutMs) {
        if (!this.ws || this.ws.readyState !== WS_OPEN) {
            throw new Error("IDE bridge not connected");
        }
        const req = makeRequest(method, params);
        const key = String(req.id);
        const waitMs = timeoutMs ?? this.timeoutMs;
        const result = await new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pending.delete(key);
                reject(new Error(`IDE RPC timeout: ${method}`));
            }, waitMs);
            this.pending.set(key, { resolve, reject, timer });
            this.ws.send(JSON.stringify(req));
        });
        return result;
    }
    async auth() {
        const params = { token: this.opts.token };
        await this.request(IdeMethods.auth, params);
        this.authed = true;
    }
    health() {
        return this.request(IdeMethods.health);
    }
    async getSemanticContext(params) {
        const raw = await this.request(IdeMethods.getSemanticContext, params ?? {});
        return assertIdeSemanticPacket(raw);
    }
    getCurrentMethod() {
        return this.request(IdeMethods.getCurrentMethod);
    }
    getCurrentClass() {
        return this.request(IdeMethods.getCurrentClass);
    }
    getCurrentFile() {
        return this.request(IdeMethods.getCurrentFile);
    }
    /** P5 — Apply helpers */
    createTestFile(params) {
        return this.request(IdeMethods.createTestFile, params);
    }
    openFile(params) {
        return this.request(IdeMethods.openFile, params);
    }
    /** P10 — Command Layer */
    searchSymbol(params) {
        return this.request(IdeMethods.searchSymbol, params);
    }
    searchText(params) {
        return this.request(IdeMethods.searchText, params);
    }
    goToDefinition(params) {
        return this.request(IdeMethods.goToDefinition, params);
    }
    findReferences(params) {
        return this.request(IdeMethods.findReferences, params ?? {});
    }
    findImplementations(params) {
        return this.request(IdeMethods.findImplementations, params ?? {});
    }
    readFile(params) {
        return this.request(IdeMethods.readFile, params);
    }
    /** Codegen Protocol — Apply / Run / Gen */
    codegenApplyFiles(params) {
        return this.request(IdeMethods.codegenApplyFiles, params, this.timeoutMs * 6);
    }
    codegenRunTests(params) {
        return this.request(IdeMethods.codegenRunTests, params, this.timeoutMs * 30);
    }
    codegenCancel(params) {
        return this.request(IdeMethods.codegenCancel, {
            ...params,
            action: "CANCEL",
        });
    }
    codegenGenerateUnitBatch(params) {
        return this.request(IdeMethods.codegenGenerateUnitBatch, params, this.timeoutMs * 30);
    }
    codegenGenerateE2eBatch(params) {
        return this.request(IdeMethods.codegenGenerateE2eBatch, params, this.timeoutMs * 30);
    }
    /** Phase 2 — open reusable AI CLI / workspace session */
    codegenOpenSession(params) {
        return this.request(IdeMethods.codegenOpenSession, params, this.timeoutMs * 3);
    }
    codegenCloseSession(params) {
        return this.request(IdeMethods.codegenCloseSession, params);
    }
    /** Phase C — write Approved TC markdown under `AItest/test-cases/` */
    tcSyncApprovedMd(params) {
        return this.request(IdeMethods.tcSyncApprovedMd, params, this.timeoutMs * 6);
    }
    /** Unit Approve v2 — IDE Repository Intelligence */
    unitApproveResolve(params) {
        const deadlineMs = Math.min(Math.max(params.limits?.deadlineMs ?? 150_000, 5_000), 180_000);
        return this.request(IdeMethods.unitApproveResolve, params, Math.max(this.timeoutMs, deadlineMs + 5_000));
    }
}
export function rpcIdKey(id) {
    return String(id);
}
