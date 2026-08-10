/**
 * Khớp TC/module tiếng Việt ↔ tên file Latin — không gắn cứng domain dự án.
 * Expansion SoT: @aitest/ide-protocol (Desktop + Extension share).
 *
 * Nguồn token (ưu tiên cao → thấp):
 * 1. Gợi ý tường minh: code: / path: / alias:
 * 2. Alias project.meta.codeAliases
 * 3. Động từ IT chung (protocol)
 * 4. Bỏ dấu + PascalCase từ chuỗi VI (extractMatchTokens)
 */
export {
  GENERIC_VI_WORD_ALIASES,
  GENERIC_VI_PHRASE_ALIASES,
  mergeCodeAliasMaps,
  expandVietnameseToCodeTokens,
  matchingProjectAliasTokens,
  normalizeAliasKey,
  extractUnitIntent,
  unitIntentBlob,
  UNIT_INTENT_DEFS,
  isWeakUnitClientPath,
  isBlockedUnitPrimaryPath,
  isDeniedUnitPrimaryPath,
  isPreferredLogicLayerPath,
  filterUnitLogicLayerPaths,
  filterUnitLogicLayerCandidates,
  UNIT_BODY_RULE,
  findBodyRuleHits,
  decideBodyRuleWriteBack,
  expandUnitRelatedPaths,
  formatRelatedMarkerLines,
  type CodeAliasMap,
  type UnitIntent,
  type UnitIntentClass,
  type UnitIntentTcLike,
  type ExtractUnitIntentOpts,
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
