/** Desktop LanguageAdapter port (W3) — mirrors BE ports contract. */

import { suggestUnitTestPath } from "../lib/stackHints";

export type LanguageAdapter = {
  language: string;
  sourceExtensions: () => string[];
  suggestUnitTestPath: (sourceRel: string, className: string) => string;
  defaultTestCommand: (framework?: string | null) => string;
};

const csharp: LanguageAdapter = {
  language: "csharp",
  sourceExtensions: () => [".cs"],
  suggestUnitTestPath: (sourceRel, className) =>
    suggestUnitTestPath({
      language: "C#",
      sourceFileName: sourceRel,
      className,
    }).relativePath,
  defaultTestCommand: () => "dotnet test",
};

const typescript: LanguageAdapter = {
  language: "typescript",
  sourceExtensions: () => [".ts", ".tsx"],
  suggestUnitTestPath: (sourceRel) =>
    suggestUnitTestPath({
      language: "TypeScript",
      sourceFileName: sourceRel,
    }).relativePath,
  defaultTestCommand: (fw) =>
    (fw || "").toLowerCase().includes("vitest")
      ? "npx vitest run"
      : "npx jest --config AItest/jest.config.cjs --runInBand --passWithNoTests",
};

const python: LanguageAdapter = {
  language: "python",
  sourceExtensions: () => [".py"],
  suggestUnitTestPath: (sourceRel) =>
    suggestUnitTestPath({
      language: "Python",
      sourceFileName: sourceRel,
    }).relativePath,
  defaultTestCommand: () => "pytest",
};

const go: LanguageAdapter = {
  language: "go",
  sourceExtensions: () => [".go"],
  suggestUnitTestPath: (sourceRel) =>
    suggestUnitTestPath({
      language: "Go",
      sourceFileName: sourceRel,
    }).relativePath,
  defaultTestCommand: () => "go test ./...",
};

const ADAPTERS: LanguageAdapter[] = [csharp, typescript, python, go];

export function languageAdapterFor(language?: string | null): LanguageAdapter | null {
  const lang = (language || "").toLowerCase();
  if (!lang) return null;
  if (lang.includes("c#") || lang.includes("csharp") || lang.includes("dotnet")) return csharp;
  if (lang.includes("typescript") || lang.includes("javascript")) return typescript;
  if (lang.includes("python")) return python;
  if (lang.includes("go")) return go;
  return ADAPTERS.find((a) => lang.includes(a.language)) ?? null;
}
