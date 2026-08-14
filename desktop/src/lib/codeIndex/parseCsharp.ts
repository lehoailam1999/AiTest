/**
 * Lightweight C# structural extract for Code Index / Approve.
 * Regex heuristics — not Roslyn. Enough for class/handler/method symbol rank.
 */
import { languageFromPath, normalizeRelPath } from "./constants";
import {
  findMatchingBraceClose,
  lineOfIndex,
  methodBodyEndLine,
} from "./braceRange";
import type { FileParseResult, ImportEdge, IndexedSymbol, SymbolKind } from "./types";

function stripCommentsAndStrings(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/@"(?:""|[^"])*"/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, "''");
}

function pushSymbol(
  out: IndexedSymbol[],
  name: string,
  kind: SymbolKind,
  line: number,
  opts?: { parent?: string; exported?: boolean; endLine?: number }
) {
  if (!name || !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) return;
  out.push({
    name,
    kind,
    line,
    endLine: opts?.endLine,
    parent: opts?.parent,
    exported: opts?.exported,
  });
}

const CS_KEYWORDS = new Set([
  "if",
  "for",
  "while",
  "switch",
  "catch",
  "using",
  "return",
  "new",
  "typeof",
  "sizeof",
  "checked",
  "unchecked",
  "lock",
  "fixed",
  "get",
  "set",
  "add",
  "remove",
  "where",
  "select",
  "from",
  "group",
  "join",
  "into",
  "let",
  "orderby",
  "on",
  "equals",
  "by",
  "ascending",
  "descending",
]);

function parseTypeAndMethods(src: string, cleaned: string): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  const seen = new Set<string>();

  const typeRe =
    /\b(?:public|internal|protected|private|static|abstract|sealed|partial|file)\s+(?:(?:public|internal|protected|private|static|abstract|sealed|partial|file)\s+)*(class|record|interface|enum|struct)\s+([A-Za-z_][A-Za-z0-9_]*)/g;

  let m: RegExpExecArray | null;
  while ((m = typeRe.exec(cleaned))) {
    const rawKind = m[1].toLowerCase();
    const kind: SymbolKind =
      rawKind === "interface"
        ? "interface"
        : rawKind === "enum"
          ? "enum"
          : "class";
    const name = m[2];
    const key = `${kind}:${name}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const line = lineOfIndex(src, m.index);
    pushSymbol(symbols, name, kind, line, { exported: true });
  }

  // Methods inside class/record/struct bodies (shallow brace walk on original src)
  const classHead =
    /\b(?:public|internal|protected|private|static|abstract|sealed|partial|file\s+)?(?:(?:public|internal|protected|private|static|abstract|sealed|partial|file)\s+)*(?:class|record|struct)\s+([A-Za-z_][A-Za-z0-9_]*)[^{]*\{/g;
  while ((m = classHead.exec(src))) {
    const parent = m[1];
    const openBrace = (m.index || 0) + m[0].length - 1;
    const bodyStart = openBrace + 1;
    const classEnd = findMatchingBraceClose(src, openBrace);
    const i = classEnd >= 0 ? classEnd : src.length;
    // Attach endLine on the type symbol when present
    const typeSym = symbols.find(
      (s) =>
        s.name === parent &&
        (s.kind === "class" || s.kind === "interface" || s.kind === "enum")
    );
    if (typeSym && classEnd >= 0) {
      typeSym.endLine = lineOfIndex(src, classEnd);
    }
    const body = src.slice(bodyStart, i);
    const methodRe =
      /(?:^|\n)\s*(?:public|private|protected|internal|static|virtual|override|async|new|sealed|partial|\s)*[A-Za-z_<>\[\],\s\.]+\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(body))) {
      const name = mm[1];
      if (CS_KEYWORDS.has(name) || name === parent) continue;
      const abs = bodyStart + (mm.index || 0);
      const mkey = `method:${parent}.${name}`;
      if (seen.has(mkey)) continue;
      seen.add(mkey);
      pushSymbol(symbols, name, "method", lineOfIndex(src, abs), {
        parent,
        endLine: methodBodyEndLine(src, abs),
      });
    }
    // Auto-properties: SearchTerm { get; set; } (nullable string? ok)
    const propRe =
      /(?:^|\n)\s*(?:public|private|protected|internal|static|virtual|override|required|\s)*(?:[A-Za-z_][\w.<>,\[\]\s\?]*)\s+([A-Za-z_][A-Za-z0-9_]*)\s*\{\s*get\s*;/g;
    let pp: RegExpExecArray | null;
    while ((pp = propRe.exec(body))) {
      const name = pp[1];
      if (CS_KEYWORDS.has(name) || name === parent) continue;
      const pkey = `prop:${parent}.${name}`;
      if (seen.has(pkey)) continue;
      seen.add(pkey);
      const abs = bodyStart + (pp.index || 0);
      pushSymbol(symbols, name, "variable", lineOfIndex(src, abs), {
        parent,
        exported: true,
      });
    }
  }

  return symbols;
}

/** BCL / framework types — not project deps for Unit related expand. */
const CS_SKIP_TYPES = new Set([
  ...CS_KEYWORDS,
  "string",
  "int",
  "long",
  "short",
  "byte",
  "bool",
  "boolean",
  "decimal",
  "double",
  "float",
  "object",
  "void",
  "var",
  "dynamic",
  "task",
  "valuetask",
  "cancellationtoken",
  "datetime",
  "datetimeoffset",
  "timespan",
  "guid",
  "uri",
  "type",
  "exception",
  "action",
  "func",
  "predicate",
  "ienumerable",
  "icollection",
  "ilist",
  "ireadonlylist",
  "ireadonlycollection",
  "idictionary",
  "list",
  "dictionary",
  "hashset",
  "array",
  "span",
  "readonlyspan",
  "memory",
  "readonlymemory",
  "httpcontext",
  "httprequest",
  "httpresponse",
  "ilogger",
  "dbcontext",
  "dbset",
]);

const CS_SKIP_NS_PREFIX = /^(System|Microsoft|Azure|Newtonsoft|Serilog|NUnit|Xunit|Moq|AutoMapper)\b/i;

function stripGenericArgs(typeName: string): string {
  return typeName.replace(/<[^>]*>/g, "").replace(/\?+$/, "").trim();
}

function isProjectTypeName(name: string): boolean {
  const bare = stripGenericArgs(name);
  if (!bare || !/^[A-Z][A-Za-z0-9_]*$/.test(bare)) return false;
  if (CS_SKIP_TYPES.has(bare.toLowerCase())) return false;
  return true;
}

/**
 * Extract using directives + local type refs (ctor/fields/params) for dependency graph.
 * Specifiers are type or namespace names — resolved later via symbolIndex.
 */
export function parseCsharpImports(src: string, cleaned: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const seen = new Set<string>();

  const push = (from: string, names: string[], line: number) => {
    const key = `${from}|${names.join(",")}`;
    if (!from || seen.has(key)) return;
    seen.add(key);
    edges.push({ from, names, line });
  };

  const usingRe =
    /^\s*using\s+(?:static\s+)?([A-Za-z_][\w.]*)\s*;/gm;
  let m: RegExpExecArray | null;
  while ((m = usingRe.exec(cleaned))) {
    const ns = m[1];
    if (CS_SKIP_NS_PREFIX.test(ns)) continue;
    push(ns, [], lineOfIndex(src, m.index));
  }

  // Field / property / local-ish: Type name = …
  const fieldRe =
    /(?:^|\n)\s*(?:public|private|protected|internal|static|readonly|required|\s)*([A-Z][A-Za-z0-9_]*(?:<[^;\n{]+>)?\??)\s+([A-Za-z_][A-Za-z0-9_]*)\s*(?:[=;{,]|\{|=>)/g;
  while ((m = fieldRe.exec(cleaned))) {
    const typeName = stripGenericArgs(m[1]);
    if (!isProjectTypeName(typeName)) continue;
    // Skip property accessors mistaken as types
    if (CS_SKIP_TYPES.has((m[2] || "").toLowerCase())) continue;
    push(typeName, [typeName], lineOfIndex(src, m.index));
  }

  // Constructor / method params: (IFoo foo, BarDto bar)
  const paramRe =
    /\(\s*([^)]{0,800})\)/g;
  while ((m = paramRe.exec(cleaned))) {
    const params = m[1];
    if (!params || /=>/.test(params)) continue;
    const parts = params.split(",");
    for (const part of parts) {
      const pm =
        /^\s*(?:(?:ref|out|in|params|this)\s+)?([A-Z][A-Za-z0-9_]*(?:<[^>]+>)?\??)\s+[A-Za-z_]/.exec(
          part
        );
      if (!pm) continue;
      const typeName = stripGenericArgs(pm[1]);
      if (!isProjectTypeName(typeName)) continue;
      push(typeName, [typeName], lineOfIndex(src, m.index));
    }
  }

  return edges.slice(0, 40);
}

/** Lightweight C# parse for index.db — symbols + using/type edges for related/planner. */
export function parseCsharpSource(
  pathRel: string,
  content: string
): FileParseResult | null {
  const lang = languageFromPath(pathRel);
  if (lang !== "cs") return null;
  const src = content || "";
  const cleaned = stripCommentsAndStrings(src);
  const symbols = parseTypeAndMethods(src, cleaned);
  return {
    pathRel: normalizeRelPath(pathRel),
    language: "cs",
    symbols,
    imports: parseCsharpImports(src, cleaned),
    exports: symbols
      .filter((s) => s.kind === "class" || s.kind === "interface" || s.kind === "enum")
      .map((s) => ({ name: s.name, line: s.line })),
  };
}
