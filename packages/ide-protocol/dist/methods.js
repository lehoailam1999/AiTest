/**
 * JSON-RPC method names (MVP P0/P1 + P10 Command Layer).
 * Desktop → Plugin and Plugin notifications.
 */
export const IdeMethods = {
    /** Auth handshake after WS connect */
    auth: "aitest/auth",
    /** Health / status */
    health: "aitest/health",
    /** Current editor focus → IdeSemanticPacket (may be partial) */
    getSemanticContext: "aitest/getSemanticContext",
    getCurrentFile: "aitest/getCurrentFile",
    getCurrentSelection: "aitest/getCurrentSelection",
    getCurrentMethod: "aitest/getCurrentMethod",
    getCurrentClass: "aitest/getCurrentClass",
    /** P10 — Command Layer (bounded hits / bytes) */
    searchSymbol: "aitest/searchSymbol",
    searchText: "aitest/searchText",
    goToDefinition: "aitest/goToDefinition",
    findReferences: "aitest/findReferences",
    findImplementations: "aitest/findImplementations",
    readFile: "aitest/readFile",
    /** Apply helpers */
    createTestFile: "aitest/workspace.createTestFile",
    openFile: "aitest/workspace.openFile",
    runTest: "aitest/test.run",
    /** Codegen Protocol (Unit/E2E) — Desktop → Extension */
    codegenApplyFiles: "aitest/codegen.applyFiles",
    codegenRunTests: "aitest/codegen.runTests",
    codegenCancel: "aitest/codegen.cancel",
    codegenGenerateUnitBatch: "aitest/codegen.generateUnitBatch",
    codegenGenerateE2eBatch: "aitest/codegen.generateE2eBatch",
    /** Phase 2 — AI CLI / workspace session reuse */
    codegenOpenSession: "aitest/codegen.openSession",
    codegenCloseSession: "aitest/codegen.closeSession",
    /** Phase C — sync Approved TC markdown into `AItest/test-cases/` */
    tcSyncApprovedMd: "aitest/tc.syncApprovedMd",
    /** Unit Approve v2 — IDE Repository Intelligence resolve */
    unitApproveResolve: "aitest/unitApprove.resolve",
};
/** Plugin → Desktop notifications (no id / no response) */
export const IdeNotifications = {
    /** Caret/selection changed — Desktop should refresh focus UI (<1s) */
    focusChanged: "aitest/focusChanged",
    /** Codegen progress stream */
    codegenProgress: "aitest/codegen.progress",
    /** Codegen final / partial result callback */
    codegenResult: "aitest/codegen.result",
};
