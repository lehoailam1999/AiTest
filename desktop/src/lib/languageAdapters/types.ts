export type LanguageConventions = {
  testFramework?: string;
  testFilePattern?: string;
  mockFramework?: string;
  assertionLibrary?: string;
};

export interface LanguageAdapter {
  readonly id: string;
  matches(language: string, filePath?: string): boolean;
  extractImports(content: string): string[];
  resolveRelativeImport(spec: string, fromFileRel: string): string | null;
  conventions(language: string, framework?: string): LanguageConventions;
}
