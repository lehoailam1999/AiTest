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

/** Namespace folder segments — not type names for dependency closure. */
const CSHARP_NS_SEGMENTS = new Set(
  [
    "Interfaces",
    "Entities",
    "Repositories",
    "Commands",
    "Queries",
    "Handlers",
    "Dto",
    "Dtos",
    "Models",
    "Services",
    "Data",
    "Core",
    "Common",
    "Extensions",
    "Helpers",
    "Infrastructure",
    "Domain",
    "Application",
    "Crosscutting",
    "Enums",
    "Constants",
    "Configuration",
    "Options",
    "Mapping",
    "Migrations",
    "System",
    "Microsoft",
    "Moq",
    "Xunit",
    "NUnit",
    "FluentAssertions",
  ].map((s) => s.toLowerCase())
);

const CSHARP_PRIMITIVES = new Set(
  [
    "string",
    "int",
    "long",
    "bool",
    "byte",
    "char",
    "decimal",
    "double",
    "float",
    "object",
    "void",
    "Guid",
    "DateTime",
    "DateTimeOffset",
    "TimeSpan",
    "CancellationToken",
    "Task",
    "ValueTask",
    "IEnumerable",
    "IList",
    "List",
    "Dictionary",
    "IDictionary",
    "IQueryable",
    "ILogger",
  ].map((s) => s.toLowerCase())
);

function stripCsharpGenerics(t: string): string {
  return t.replace(/<[^>]*>/g, "").replace(/\?/g, "").trim();
}

function bareCsharpType(t: string): string | null {
  const bare = stripCsharpGenerics(t).split(".").pop() || "";
  if (!bare || !/^[A-Z]/.test(bare)) return null;
  if (CSHARP_PRIMITIVES.has(bare.toLowerCase())) return null;
  if (CSHARP_NS_SEGMENTS.has(bare.toLowerCase())) return null;
  return bare;
}

function addCsharpTypeAndArgs(out: Set<string>, typeExpr: string) {
  const bare = bareCsharpType(typeExpr);
  if (bare) out.add(bare);
  for (const m of typeExpr.matchAll(/<([^>]+)>/g)) {
    for (const part of m[1].split(",")) {
      const inner = bareCsharpType(part.trim());
      if (inner) out.add(inner);
    }
  }
}

/** Prefer ctor / field types over last segment of `using Foo.Bar.Interfaces`. */
function extractCsharpTypeRefs(content: string): string[] {
  const out = new Set<string>();

  const classMatch = content.match(
    /\b(?:public\s+|internal\s+)?(?:sealed\s+|abstract\s+|static\s+|partial\s+)*class\s+(\w+)/
  );
  if (classMatch) {
    const name = classMatch[1];
    const ctorRe = new RegExp(
      `(?:public|private|protected|internal)\\s+${name}\\s*\\(([^)]*)\\)`
    );
    const ctor = content.match(ctorRe);
    if (ctor) {
      for (const part of ctor[1].split(",")) {
        const t = part.trim().match(/^([\w.]+(?:<[^>]+>)?)\s+\w+/);
        if (t) addCsharpTypeAndArgs(out, t[1]);
      }
    }
  }

  // private readonly IFooRepository _repo;
  for (const m of content.matchAll(
    /\b(?:private|protected|internal|public)\s+(?:readonly\s+)?([\w.]+(?:<[^>]+>)?)\s+_\w+\s*[;=]/g
  )) {
    addCsharpTypeAndArgs(out, m[1]);
  }

  // using Alias = Some.Type; or using Some.ConcreteType (rare)
  for (const m of content.matchAll(/^\s*using\s+(?:static\s+)?(?:(\w+)\s*=\s*)?([\w.]+)\s*;/gm)) {
    if (m[1]) {
      out.add(m[1]);
      continue;
    }
    const bare = bareCsharpType(m[2]);
    if (bare) out.add(bare);
  }

  return [...out];
}

const csharpAdapter: LanguageAdapter = {
  id: "csharp",
  matches: (lang, path) =>
    lang.includes("c#") || lang.includes("csharp") || lang.includes(".net") || !!path?.endsWith(".cs"),
  extractImports(content: string) {
    return extractCsharpTypeRefs(content);
  },
  resolveRelativeImport(spec: string, fromFileRel: string) {
    if (!spec.startsWith(".")) return null;
    const fromDir = fromFileRel.includes("/")
      ? fromFileRel.slice(0, fromFileRel.lastIndexOf("/"))
      : "";
    const joined = fromDir ? `${fromDir}/${spec.replace(/\\/g, "/")}` : spec;
    return normalizeRelativePath(joined);
  },
  conventions: () => ({
    testFramework: "xunit",
    testFilePattern: "*Tests.cs",
    mockFramework: "Moq / NSubstitute",
    assertionLibrary: "xunit Assert",
  }),
};

function normalizeRelativePath(p: string): string {
  const parts = p.split("/");
  const stack: string[] = [];
  for (const part of parts) {
    if (!part || part === ".") continue;
    if (part === "..") {
      stack.pop();
      continue;
    }
    stack.push(part);
  }
  return stack.join("/");
}

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
