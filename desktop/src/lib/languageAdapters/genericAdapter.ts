import type { LanguageAdapter, LanguageConventions } from "./types";

export function createRegexAdapter(
  id: string,
  test: (lang: string, path?: string) => boolean,
  importPatterns: RegExp[],
  mapSpec: (m: RegExpMatchArray) => string | null
): LanguageAdapter {
  return {
    id,
    matches: test,
    extractImports(content: string) {
      const out = new Set<string>();
      for (const re of importPatterns) {
        for (const m of content.matchAll(re)) {
          const spec = mapSpec(m);
          if (spec) out.add(spec);
        }
      }
      return [...out];
    },
    resolveRelativeImport(spec: string, fromFileRel: string) {
      if (!spec.startsWith(".")) return null;
      const fromDir = fromFileRel.includes("/")
        ? fromFileRel.slice(0, fromFileRel.lastIndexOf("/"))
        : "";
      const joined = fromDir ? `${fromDir}/${spec.replace(/\\/g, "/")}` : spec;
      return normalizeRelative(joined);
    },
    conventions(): LanguageConventions {
      return {};
    },
  };
}

function normalizeRelative(p: string): string {
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
