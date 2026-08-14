/**
 * Lightweight TS/JS structural extract (Phase 1).
 * Not a full AST — regex/line heuristics for class/fn/interface/enum/import/export.
 * Upgrade path: tree-sitter or typescript.createSourceFile (documented in roadmap).
 */
import { languageFromPath, normalizeRelPath } from "./constants";
import {
  findMatchingBraceClose,
  lineOfIndex,
  methodBodyEndLine,
} from "./braceRange";
import type {
  ExportInfo,
  FileParseResult,
  ImportEdge,
  IndexedSymbol,
  SymbolKind,
} from "./types";

function stripCommentsAndStrings(src: string): string {
  // Enough to reduce false positives in imports/classes inside comments/strings.
  return src
    .replace(/\/\*[\s\S]*?\*\//g, (m) => m.replace(/[^\n]/g, " "))
    .replace(/\/\/[^\n]*/g, "")
    .replace(/`(?:\\.|[^`\\])*`/g, '""')
    .replace(/'(?:\\.|[^'\\])*'/g, '""')
    .replace(/"(?:\\.|[^"\\])*"/g, '""');
}

function pushSymbol(
  out: IndexedSymbol[],
  name: string,
  kind: SymbolKind,
  line: number,
  opts?: { parent?: string; exported?: boolean; endLine?: number }
) {
  if (!name || !/^[$A-Za-z_][$A-Za-z0-9_]*$/.test(name)) return;
  out.push({
    name,
    kind,
    line,
    endLine: opts?.endLine,
    parent: opts?.parent,
    exported: opts?.exported,
  });
}

function parseImports(src: string, cleaned: string): ImportEdge[] {
  const edges: ImportEdge[] = [];
  const re =
    /\bimport\s+(type\s+)?(?:(\*\s+as\s+[$A-Za-z_][$A-Za-z0-9_]*)|(\{[^}]*\})|([$A-Za-z_][$A-Za-z0-9_]*))?\s*(?:,\s*(?:(\{[^}]*\})|([$A-Za-z_][$A-Za-z0-9_]*)))?\s*from\s*["']([^"']+)["']/g;
  const sideEffect = /\bimport\s*["']([^"']+)["']/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(cleaned))) {
    const isTypeOnly = Boolean(m[1]);
    const names: string[] = [];
    const brace = m[3] || m[5];
    const def = m[4] || m[6];
    if (brace) {
      for (const part of brace.replace(/[{}]/g, "").split(",")) {
        const id = part
          .trim()
          .replace(/^type\s+/, "")
          .split(/\s+as\s+/)[0]
          ?.trim();
        if (id) names.push(id);
      }
    }
    if (def) names.push(def.replace(/\*\s+as\s+/, "").trim());
    edges.push({
      from: m[7],
      names,
      isTypeOnly,
      line: lineOfIndex(src, m.index),
    });
  }
  while ((m = sideEffect.exec(cleaned))) {
    edges.push({
      from: m[1],
      names: [],
      line: lineOfIndex(src, m.index),
    });
  }
  return edges;
}

function parseExports(src: string, cleaned: string): ExportInfo[] {
  const out: ExportInfo[] = [];
  const named =
    /\bexport\s+(?:async\s+)?(?:function|class|interface|enum|type|const|let|var)\s+([$A-Za-z_][$A-Za-z0-9_]*)/g;
  const def =
    /\bexport\s+default\s+(?:async\s+)?(?:function|class)?\s*([$A-Za-z_][$A-Za-z0-9_]*)?/g;
  let m: RegExpExecArray | null;
  while ((m = named.exec(cleaned))) {
    out.push({ name: m[1], line: lineOfIndex(src, m.index) });
  }
  while ((m = def.exec(cleaned))) {
    out.push({
      name: m[1] || "default",
      line: lineOfIndex(src, m.index),
      isDefault: true,
    });
  }
  return out;
}

function parseTopLevelSymbols(src: string, cleaned: string): IndexedSymbol[] {
  const symbols: IndexedSymbol[] = [];
  const exportedRe =
    /\bexport\s+(?:declare\s+)?(?:async\s+)?(function|class|interface|enum|type|const|let|var)\s+([$A-Za-z_][$A-Za-z0-9_]*)/g;
  const plainRe =
    /(?:^|[\n;{}])\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?(function|class|interface|enum|type)\s+([$A-Za-z_][$A-Za-z0-9_]*)/g;

  const kindMap: Record<string, SymbolKind> = {
    function: "function",
    class: "class",
    interface: "interface",
    enum: "enum",
    type: "type",
    const: "variable",
    let: "variable",
    var: "variable",
  };

  let m: RegExpExecArray | null;
  const seen = new Set<string>();
  while ((m = exportedRe.exec(cleaned))) {
    const kind = kindMap[m[1]] || "variable";
    const key = `${kind}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushSymbol(symbols, m[2], kind, lineOfIndex(src, m.index), { exported: true });
  }
  while ((m = plainRe.exec(cleaned))) {
    const kind = kindMap[m[1]] || "function";
    const key = `${kind}:${m[2]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushSymbol(symbols, m[2], kind, lineOfIndex(src, m.index));
  }

  // class methods (shallow) — brace-balanced body extract
  const classHead = /\bclass\s+([$A-Za-z_][$A-Za-z0-9_]*)[^{]*\{/g;
  while ((m = classHead.exec(src))) {
    const parent = m[1];
    const openBrace = (m.index || 0) + m[0].length - 1;
    const bodyStart = openBrace + 1;
    const classEnd = findMatchingBraceClose(src, openBrace);
    const i = classEnd >= 0 ? classEnd : src.length;
    const typeSym = symbols.find((s) => s.name === parent && s.kind === "class");
    if (typeSym && classEnd >= 0) {
      typeSym.endLine = lineOfIndex(src, classEnd);
    }
    const body = src.slice(bodyStart, i);
    const methodRe =
      /(?:^|\n)\s*(?:public|private|protected|static|async|readonly|override|\s)*([$A-Za-z_][$A-Za-z0-9_]*)\s*\(/g;
    let mm: RegExpExecArray | null;
    while ((mm = methodRe.exec(body))) {
      const name = mm[1];
      if (
        name === "constructor" ||
        name === "if" ||
        name === "for" ||
        name === "while" ||
        name === "switch" ||
        name === "catch" ||
        name === "get" ||
        name === "set"
      ) {
        continue;
      }
      const abs = bodyStart + (mm.index || 0);
      pushSymbol(symbols, name, "method", lineOfIndex(src, abs), {
        parent,
        endLine: methodBodyEndLine(src, abs),
      });
    }
  }

  // decorators @Foo
  const decRe = /@([$A-Za-z_][$A-Za-z0-9_]*)/g;
  while ((m = decRe.exec(cleaned))) {
    pushSymbol(symbols, m[1], "decorator", lineOfIndex(src, m.index));
  }

  return symbols;
}

export function parseTsJsSource(pathRel: string, content: string): FileParseResult | null {
  const lang = languageFromPath(pathRel);
  if (!lang || lang === "cs") return null;
  const cleaned = stripCommentsAndStrings(content);
  return {
    pathRel: normalizeRelPath(pathRel),
    language: lang,
    symbols: parseTopLevelSymbols(content, cleaned),
    // Imports/exports: parse on original source — string stripping empties `from "…"`.
    imports: parseImports(content, content),
    exports: parseExports(content, content),
  };
}
