/**
 * Desktop helpers for VI ↔ code token expansion.
 * Logic SoT: @aitest/ide-protocol — this file only adds parseCodeHintsFromText.
 */
export {
  expandCodeMatchTokens,
  expandVietnameseToCodeTokens,
  matchingProjectAliasTokens,
  type CodeAliasMap,
  type ExpandCodeTokensOpts,
} from "@aitest/ide-protocol";

/**
 * Parse gợi ý tường minh (mọi dự án):
 *   code: MyService
 *   path: Services/Foo
 *   alias: FooController, IFooService
 */
export function parseCodeHintsFromText(text: string | null | undefined): {
  codeTokens: string[];
  pathHints: string[];
} {
  const raw = text || "";
  const codeTokens: string[] = [];
  const pathHints: string[] = [];

  for (const m of raw.matchAll(/(?:^|\n)\s*(?:code|alias)\s*:\s*(.+)$/gim)) {
    codeTokens.push(
      ...m[1]
        .split(/[,;|/]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }
  for (const m of raw.matchAll(/(?:^|\n)\s*path\s*:\s*(.+)$/gim)) {
    pathHints.push(
      ...m[1]
        .split(/[,;|]+/)
        .map((s) => s.trim())
        .filter(Boolean)
    );
  }

  return {
    codeTokens: [...new Set(codeTokens)],
    pathHints: [...new Set(pathHints)],
  };
}
