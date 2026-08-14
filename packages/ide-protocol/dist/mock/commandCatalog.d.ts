import type { FindImplementationsResult, FindReferencesResult, GoToDefinitionResult, ReadFileParams, ReadFileResult, SearchSymbolParams, SearchSymbolResult, SearchTextParams, SearchTextResult, SymbolPositionParams } from "../methods.js";
import type { SymbolKind } from "../types.js";
export type MockFile = {
    pathRel: string;
    content: string;
};
export type MockSymbol = {
    name: string;
    kind: SymbolKind;
    pathRel: string;
    line: number;
    character: number;
    endLine: number;
    containerName?: string;
};
export declare function defaultMockFiles(): MockFile[];
export declare function defaultMockSymbols(): MockSymbol[];
export declare function mockSearchSymbol(symbols: MockSymbol[], params: SearchSymbolParams): SearchSymbolResult;
export declare function mockSearchText(files: MockFile[], params: SearchTextParams): SearchTextResult;
export declare function mockGoToDefinition(symbols: MockSymbol[], params: SymbolPositionParams): GoToDefinitionResult;
export declare function mockFindReferences(symbols: MockSymbol[], files: MockFile[], params: SymbolPositionParams): FindReferencesResult;
export declare function mockFindImplementations(symbols: MockSymbol[], params: SymbolPositionParams): FindImplementationsResult;
export declare function mockReadFile(files: MockFile[], params: ReadFileParams): ReadFileResult;
