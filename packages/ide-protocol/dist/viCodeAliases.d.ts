export type CodeAliasMap = Record<string, string[]>;
/** IT verbs/actions — loaded from defaults JSON (override via SUT code-aliases). */
export declare const GENERIC_VI_WORD_ALIASES: CodeAliasMap;
/** Portable IT phrases — domain phrases belong on SUT code-aliases.json. */
export declare const GENERIC_VI_PHRASE_ALIASES: CodeAliasMap;
export declare function normalizeAliasKey(raw: string): string;
export declare function mergeCodeAliasMaps(projectAliases?: CodeAliasMap | null): {
    phrases: CodeAliasMap;
    words: CodeAliasMap;
};
export declare function expandVietnameseToCodeTokens(raw: string, projectAliases?: CodeAliasMap | null): string[];
export type ExpandCodeTokensOpts = {
    projectAliases?: CodeAliasMap | null;
    /** When set, merge index stems + optionally filter bootstrap tokens to index hits. */
    indexPaths?: string[] | null;
    /**
     * When indexPaths present: filter static VI→Latin bootstrap tokens to those hitting paths.
     * Index-derived stems are always kept. Default true.
     */
    indexFilterBootstrap?: boolean;
};
/**
 * Unified expansion: VI defaults + project aliases + optional index stems.
 * Index is SoT — bootstrap tokens that miss all paths are dropped when indexPaths set.
 */
export declare function expandCodeMatchTokens(raw: string, opts?: ExpandCodeTokensOpts): string[];
/**
 * Domain tokens from **project** `.ai-test/code-aliases.json` only
 * (not generic IT verbs). Used to keep Approve body-rule from latching
 * unrelated *Service with throw/Validate.
 */
export declare function matchingProjectAliasTokens(raw: string, projectAliases?: CodeAliasMap | null): string[];
