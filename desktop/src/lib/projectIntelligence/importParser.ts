import { getLanguageAdapter } from "../languageAdapters/registry";

export function extractImportSpecifiers(
  content: string,
  language: string,
  filePath?: string
): string[] {
  return getLanguageAdapter(language, filePath).extractImports(content);
}

export function resolveImportToPath(
  spec: string,
  fromFileRel: string,
  language: string
): string | null {
  return getLanguageAdapter(language, fromFileRel).resolveRelativeImport(spec, fromFileRel);
}

export function guessPathsForSymbol(
  symbol: string,
  byStem: Map<string, { pathRel: string }[]>
): string[] {
  const key = symbol.toLowerCase();
  const direct = byStem.get(key);
  if (direct?.length) return direct.map((f) => f.pathRel);

  const withoutSuffix = symbol.replace(/(Service|Controller|Repository|Handler|Tests?)$/i, "");
  if (withoutSuffix !== symbol) {
    const alt = byStem.get(withoutSuffix.toLowerCase());
    if (alt?.length) return alt.map((f) => f.pathRel);
  }
  return [];
}
