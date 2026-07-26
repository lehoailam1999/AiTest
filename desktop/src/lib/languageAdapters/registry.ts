import type { LanguageAdapter } from "./types";
import { createRegexAdapter } from "./genericAdapter";

const pythonAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "python",
    (lang) => lang.includes("python"),
    [/^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))/gm],
    (m) => (m[1] || m[2] || "").split(".")[0] || null
  ),
  conventions: () => ({
    testFramework: "pytest",
    testFilePattern: "test_*.py",
    mockFramework: "unittest.mock / pytest-mock",
    assertionLibrary: "assert / pytest.raises",
  }),
};

const typescriptAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "typescript",
    (lang, path) =>
      lang.includes("typescript") ||
      lang.includes("javascript") ||
      lang.includes("node") ||
      !!path?.match(/\.(tsx?|jsx?)$/i),
    [/from\s+['"]([^'"]+)['"]/g, /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g],
    (m) => m[1] || null
  ),
  conventions: (_language, framework) => {
    const fw = (framework || "").toLowerCase();
    const vitest = fw.includes("vitest");
    return {
      testFramework: vitest ? "vitest" : "jest",
      testFilePattern: vitest ? "*.test.ts" : "*.spec.ts",
      mockFramework: vitest ? "vi.mock" : "jest.mock",
      assertionLibrary: "expect",
    };
  },
};

const csharpAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "csharp",
    (lang, path) =>
      lang.includes("c#") || lang.includes("csharp") || lang.includes(".net") || !!path?.endsWith(".cs"),
    [/^\s*using\s+([\w.]+)\s*;/gm],
    (m) => {
      const parts = m[1].split(".");
      return parts[parts.length - 1] || null;
    }
  ),
  conventions: () => ({
    testFramework: "xunit",
    testFilePattern: "*Tests.cs",
    mockFramework: "Moq / NSubstitute",
    assertionLibrary: "xunit Assert",
  }),
};

const javaAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "java",
    (lang, path) => lang.includes("java") || lang.includes("kotlin") || !!path?.match(/\.(java|kt)$/i),
    [/^\s*import\s+(?:static\s+)?([\w.]+)/gm],
    (m) => {
      const parts = m[1].split(".");
      const last = parts[parts.length - 1];
      return last && last !== "*" ? last : null;
    }
  ),
  conventions: () => ({
    testFramework: "junit",
    testFilePattern: "*Test.java",
    mockFramework: "Mockito",
    assertionLibrary: "JUnit Assertions / AssertJ",
  }),
};

const goAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "go",
    (lang, path) => lang.includes("go") || !!path?.endsWith(".go"),
    [/^\s*import\s+"([^"]+)"/gm],
    (m) => {
      const seg = m[1].split("/").pop();
      return seg || null;
    }
  ),
  conventions: () => ({
    testFramework: "gotest",
    testFilePattern: "*_test.go",
    mockFramework: "interfaces / gomock",
    assertionLibrary: "testing + testify (if present)",
  }),
};

const rustAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "rust",
    (lang, path) => lang.includes("rust") || !!path?.endsWith(".rs"),
    [/^\s*use\s+([\w:]+)/gm],
    (m) => {
      const parts = m[1].split("::");
      return parts[parts.length - 1] || null;
    }
  ),
  conventions: () => ({
    testFramework: "cargo",
    testFilePattern: "*_test.rs / #[cfg(test)]",
    mockFramework: "mockall (if present)",
    assertionLibrary: "assert! / assert_eq!",
  }),
};

const phpAdapter: LanguageAdapter = {
  ...createRegexAdapter(
    "php",
    (lang, path) => lang.includes("php") || !!path?.endsWith(".php"),
    [/^\s*use\s+([\w\\]+)/gm],
    (m) => {
      const parts = m[1].split("\\");
      return parts[parts.length - 1] || null;
    }
  ),
  conventions: () => ({
    testFramework: "phpunit",
    testFilePattern: "*Test.php",
    mockFramework: "PHPUnit mocks / Prophecy",
    assertionLibrary: "PHPUnit assertions",
  }),
};

const ADAPTERS: LanguageAdapter[] = [
  pythonAdapter,
  typescriptAdapter,
  csharpAdapter,
  javaAdapter,
  goAdapter,
  rustAdapter,
  phpAdapter,
];

const fallback: LanguageAdapter = {
  id: "generic",
  matches: () => true,
  extractImports: () => [],
  resolveRelativeImport: () => null,
  conventions: () => ({}),
};

export function getLanguageAdapter(language: string, filePath?: string): LanguageAdapter {
  const lang = language.toLowerCase();
  for (const a of ADAPTERS) {
    if (a.matches(lang, filePath)) return a;
  }
  return fallback;
}

export function listLanguageAdapterIds(): string[] {
  return ADAPTERS.map((a) => a.id);
}
