/**
 * Project-agnostic Unit Gen post/pre guards (Extension + Desktop).
 * Fail-closed on stack mismatch, weak SUT↔TC alignment, and invented validators.
 */
export type UnitCodeStack = "csharp" | "typescript" | "javascript" | "python" | "java" | "go" | "unknown";
/** Extract path:/code:/related: markers from TC text (project-agnostic hints). */
export declare function extractTcSourceMarkers(text: string): {
    paths: string[];
    codes: string[];
    related: string[];
};
/**
 * Phase 5 — Gen requires both path: and code: (from Approve write-back or manual).
 */
export declare function hasUnitSourceMarkers(text: string | null | undefined): boolean;
/** Approve fail-closed skip note without usable markers. */
export declare function isUnitSutResolveSkipped(text: string | null | undefined): boolean;
/** Significant tokens for alignment (paths, PascalCase, words ≥4). */
export declare function significantTokens(text: string): string[];
export declare function sutTcAlignmentScore(opts: {
    tcText: string;
    primaryPath: string;
    sourceExcerpt: string;
    /** Optional project VI→code aliases (meta.codeAliases) */
    codeAliases?: Record<string, string[]> | null;
}): {
    score: number;
    shared: string[];
    markersHit: number;
};
/**
 * Minimum alignment to accept a resolved SUT (fail-closed below this).
 * With path:/code: markers, a low bar is OK (markers already weigh heavily).
 * Without markers, require stronger token overlap — otherwise weak words like
 * "file" / "form" latch onto unrelated admin modules (e.g. digital-file vs evidence upload).
 */
export declare const UNIT_SUT_ALIGN_MIN = 2;
/** Stricter floor when TC has no path:/code:/file:/sut: markers. */
export declare const UNIT_SUT_ALIGN_MIN_NO_MARKER = 6;
export declare function unitSutAlignMin(markersHit: number): number;
export declare function isSutAlignedEnough(opts: {
    score: number;
    markersHit: number;
}): boolean;
/**
 * Domain nouns expected from TC (aliases + markers), excluding IT verbs.
 * e.g. "vật chứng" + aliases → ["evidence"].
 */
export declare function expectedDomainTokensFromTc(tcText: string, codeAliases?: Record<string, string[]> | null): string[];
/**
 * Domain hints from a SUT path: Commands/{Domain}/ or basename prefix
 * (AccountCreateCommandHandler → account).
 */
export declare function extractPathDomainHints(primaryPath: string): string[];
export type SutDomainConflict = {
    conflict: boolean;
    expected: string[];
    pathDomains: string[];
};
/**
 * True when TC aliases/markers imply domain D1 but path is clearly D2 (e.g. Evidence vs Account).
 */
export declare function sutDomainConflict(opts: {
    tcText: string;
    primaryPath: string;
    codeAliases?: Record<string, string[]> | null;
}): SutDomainConflict;
/** Packet/path usable only when aligned AND not a domain conflict. */
export declare function isPacketSutAcceptable(opts: {
    tcText: string;
    primaryPath: string;
    sourceExcerpt: string;
    codeAliases?: Record<string, string[]> | null;
}): boolean;
/** Extra stop-words for disk path ranking (not for TC↔SUT token overlap). */
export declare const PATH_RANK_STOP: Set<string>;
export declare function detectCodeStack(code: string): UnitCodeStack;
export declare function stackForPath(relPath: string): UnitCodeStack | "any";
export declare function assertStackMatchesPath(relPath: string, code: string): void;
/**
 * Heuristics for invented production rules inside the test file.
 * Project-agnostic — flags local BR/validator/hardcoded allow-lists not imported from SUT.
 */
export declare function findInventedRuleSmells(code: string, sutExcerpt: string): string[];
/**
 * Heuristics for non-portable test harness dependencies.
 * Generated tests should compile in plain AItest projects without private helpers.
 */
export declare function findNonPortableTestHarnessSmells(code: string): string[];
export declare function assertUnitGenQuality(opts: {
    relPath: string;
    code: string;
    tcText: string;
    primaryPath: string;
    sutExcerpt: string;
}): void;
/** Map C# usings / common APIs → NuGet packages for AItest.UnitTests.csproj. */
export declare const CSHARP_USING_TO_PACKAGE: Record<string, string>;
export declare function detectCsharpPackagesFromTestCode(code: string): string[];
