import type { SymbolKind, SymbolRef, TextRange } from "./types.js";
/**
 * JSON-RPC method names (MVP P0/P1 + P10 Command Layer).
 * Desktop → Plugin and Plugin notifications.
 */
export declare const IdeMethods: {
    /** Auth handshake after WS connect */
    readonly auth: "aitest/auth";
    /** Health / status */
    readonly health: "aitest/health";
    /** Current editor focus → IdeSemanticPacket (may be partial) */
    readonly getSemanticContext: "aitest/getSemanticContext";
    readonly getCurrentFile: "aitest/getCurrentFile";
    readonly getCurrentSelection: "aitest/getCurrentSelection";
    readonly getCurrentMethod: "aitest/getCurrentMethod";
    readonly getCurrentClass: "aitest/getCurrentClass";
    /** P10 — Command Layer (bounded hits / bytes) */
    readonly searchSymbol: "aitest/searchSymbol";
    readonly searchText: "aitest/searchText";
    readonly goToDefinition: "aitest/goToDefinition";
    readonly findReferences: "aitest/findReferences";
    readonly findImplementations: "aitest/findImplementations";
    readonly readFile: "aitest/readFile";
    /** Apply helpers */
    readonly createTestFile: "aitest/workspace.createTestFile";
    readonly openFile: "aitest/workspace.openFile";
    readonly runTest: "aitest/test.run";
    /** Codegen Protocol (Unit/E2E) — Desktop → Extension */
    readonly codegenApplyFiles: "aitest/codegen.applyFiles";
    readonly codegenRunTests: "aitest/codegen.runTests";
    readonly codegenCancel: "aitest/codegen.cancel";
    readonly codegenGenerateUnitBatch: "aitest/codegen.generateUnitBatch";
    readonly codegenGenerateE2eBatch: "aitest/codegen.generateE2eBatch";
    /** Phase 2 — AI CLI / workspace session reuse */
    readonly codegenOpenSession: "aitest/codegen.openSession";
    readonly codegenCloseSession: "aitest/codegen.closeSession";
    /** Phase C — sync Approved TC markdown into `AItest/test-cases/` */
    readonly tcSyncApprovedMd: "aitest/tc.syncApprovedMd";
    /** Unit Approve v2 — IDE Repository Intelligence resolve */
    readonly unitApproveResolve: "aitest/unitApprove.resolve";
};
export type IdeMethodName = (typeof IdeMethods)[keyof typeof IdeMethods];
/** Plugin → Desktop notifications (no id / no response) */
export declare const IdeNotifications: {
    /** Caret/selection changed — Desktop should refresh focus UI (<1s) */
    readonly focusChanged: "aitest/focusChanged";
    /** Codegen progress stream */
    readonly codegenProgress: "aitest/codegen.progress";
    /** Codegen final / partial result callback */
    readonly codegenResult: "aitest/codegen.result";
};
export type IdeNotificationName = (typeof IdeNotifications)[keyof typeof IdeNotifications];
export type FocusChangedParams = {
    focus: {
        file: string;
        symbol: string;
        kind: string;
        method?: string;
        range?: {
            start: number;
            end: number;
            startCharacter?: number;
            endCharacter?: number;
        };
    };
    confidence?: "high" | "medium" | "low";
    workspaceRoot?: string;
    language?: string;
};
export type AuthParams = {
    token: string;
};
export type AuthResult = {
    ok: true;
    ide: string;
};
export type GetSemanticContextParams = {
    /** Include dependency snippets */
    includeDependencies?: boolean;
    maxDependencyFiles?: number;
    maxSnippetChars?: number;
};
/** Opaque id: typically `pathRel:line:character:name` */
export type SymbolId = string;
export type SearchSymbolParams = {
    query: string;
    kinds?: SymbolKind[];
    maxResults?: number;
};
export type SymbolHit = {
    id: SymbolId;
    name: string;
    kind: SymbolKind;
    pathRel: string;
    range?: TextRange;
    containerName?: string;
    score?: number;
};
export type SearchSymbolResult = {
    hits: SymbolHit[];
    truncated: boolean;
};
export type SearchTextParams = {
    query: string;
    /** Glob include pattern (e.g. TypeScript / C# extensions) */
    glob?: string;
    maxResults?: number;
    maxBytesPerHit?: number;
};
export type TextHit = {
    pathRel: string;
    line: number;
    character?: number;
    preview: string;
};
export type SearchTextResult = {
    hits: TextHit[];
    truncated: boolean;
};
export type SymbolPositionParams = {
    /** Prefer symbolId when available from a prior search */
    symbolId?: SymbolId;
    pathRel?: string;
    line?: number;
    character?: number;
    maxResults?: number;
};
export type DefinitionLocation = {
    pathRel: string;
    range?: TextRange;
    name?: string;
};
export type GoToDefinitionResult = {
    locations: DefinitionLocation[];
};
export type FindReferencesResult = {
    refs: SymbolRef[];
    truncated: boolean;
};
export type FindImplementationsResult = {
    locations: DefinitionLocation[];
    truncated: boolean;
};
export type ReadFileParams = {
    pathRel: string;
    /** 0-based inclusive start line */
    startLine?: number;
    /** 0-based inclusive end line */
    endLine?: number;
    maxBytes?: number;
};
export type ReadFileResult = {
    pathRel: string;
    content: string;
    startLine: number;
    endLine: number;
    truncated: boolean;
    totalLines?: number;
};
export type CreateTestFileParams = {
    pathRel: string;
    content: string;
    open?: boolean;
};
export type OpenFileParams = {
    pathRel: string;
};
export type RunTestParams = {
    filter?: string;
    pathRel?: string;
};
