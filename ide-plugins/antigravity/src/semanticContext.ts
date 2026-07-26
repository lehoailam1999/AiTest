/**
 * Build IdeSemanticPacket from Antigravity IDE editor + LSP providers.
 */
import * as vscode from "vscode";
import type {
  Confidence,
  IdeKind,
  IdeSemanticPacket,
  SymbolInfo,
  SymbolKind,
  SymbolRef,
  TextRange,
} from "@aitest/ide-protocol";
import { IDE_PROTOCOL_VERSION } from "@aitest/ide-protocol";

const CONTAINER_KINDS = new Set([
  vscode.SymbolKind.Class,
  vscode.SymbolKind.Interface,
  vscode.SymbolKind.Struct,
  vscode.SymbolKind.Enum,
  vscode.SymbolKind.Module,
  vscode.SymbolKind.Namespace,
]);

const METHOD_KINDS = new Set([
  vscode.SymbolKind.Method,
  vscode.SymbolKind.Function,
  vscode.SymbolKind.Constructor,
]);

function detectIde(): IdeKind {
  return "antigravity";
}

function workspaceRoot(): string {
  const folder = vscode.workspace.workspaceFolders?.[0];
  return folder?.uri.fsPath ?? "";
}

function toRel(fsPath: string): string {
  const root = workspaceRoot();
  if (!root) return fsPath.replace(/\\/g, "/");
  const normRoot = root.replace(/\\/g, "/").replace(/\/$/, "");
  const norm = fsPath.replace(/\\/g, "/");
  if (norm.toLowerCase().startsWith(normRoot.toLowerCase() + "/")) {
    return norm.slice(normRoot.length + 1);
  }
  return norm;
}

function rangeOf(r: vscode.Range): TextRange {
  return {
    start: r.start.line,
    end: r.end.line,
    startCharacter: r.start.character,
    endCharacter: r.end.character,
  };
}

function mapKind(k: vscode.SymbolKind): SymbolKind {
  switch (k) {
    case vscode.SymbolKind.Class:
    case vscode.SymbolKind.Struct:
      return "class";
    case vscode.SymbolKind.Interface:
      return "interface";
    case vscode.SymbolKind.Method:
    case vscode.SymbolKind.Constructor:
      return "method";
    case vscode.SymbolKind.Function:
      return "function";
    case vscode.SymbolKind.Property:
    case vscode.SymbolKind.Field:
      return "property";
    case vscode.SymbolKind.Module:
    case vscode.SymbolKind.Namespace:
      return "module";
    case vscode.SymbolKind.File:
      return "file";
    default:
      return "unknown";
  }
}

type FlatSymbol = {
  name: string;
  kind: vscode.SymbolKind;
  range: vscode.Range;
  selectionRange: vscode.Range;
  detail?: string;
  containerName?: string;
  children: FlatSymbol[];
};

function flattenSymbols(
  symbols: vscode.DocumentSymbol[],
  containerName?: string
): FlatSymbol[] {
  const out: FlatSymbol[] = [];
  for (const s of symbols) {
    const node: FlatSymbol = {
      name: s.name,
      kind: s.kind,
      range: s.range,
      selectionRange: s.selectionRange,
      detail: s.detail,
      containerName,
      children: flattenSymbols(s.children ?? [], s.name),
    };
    out.push(node);
    out.push(...node.children);
  }
  return out;
}

function contains(range: vscode.Range, pos: vscode.Position): boolean {
  return range.contains(pos);
}

function findEnclosing(flat: FlatSymbol[], pos: vscode.Position, kinds: Set<vscode.SymbolKind>): FlatSymbol | undefined {
  const hits = flat.filter((s) => kinds.has(s.kind) && contains(s.range, pos));
  if (!hits.length) return undefined;
  hits.sort((a, b) => {
    const aSize = a.range.end.line - a.range.start.line;
    const bSize = b.range.end.line - b.range.start.line;
    return aSize - bSize;
  });
  return hits[0];
}

function languageId(doc: vscode.TextDocument): string {
  return doc.languageId || "plaintext";
}

function frameworkHints(lang: string, text: string): string[] {
  const hints: string[] = [];
  if (lang === "typescript" || lang === "javascript") {
    if (/@angular\//.test(text) || /@Component\(/.test(text)) hints.push("angular");
    if (/from ['"]react['"]/.test(text) || /from ['"]react\//.test(text)) hints.push("react");
    if (/describe\(|it\(|test\(/.test(text)) hints.push("jest");
  }
  if (lang === "csharp") {
    if (/\[Fact\]|\[Theory\]/.test(text)) hints.push("xunit");
    if (/NUnit/.test(text) || /\[Test\]/.test(text)) hints.push("nunit");
  }
  if (lang === "python" && /pytest|unittest/.test(text)) hints.push("pytest");
  return hints;
}

function extractImports(text: string, lang: string): string[] {
  const lines = text.split(/\r?\n/).slice(0, 120);
  const imports: string[] = [];
  for (const line of lines) {
    if (lang === "csharp") {
      const m = line.match(/^\s*using\s+([\w.]+)\s*;/);
      if (m) imports.push(m[1]);
    } else if (lang === "python") {
      const m = line.match(/^\s*(?:from\s+(\S+)\s+import|import\s+(\S+))/);
      if (m) imports.push(m[1] || m[2]);
    } else {
      const m = line.match(/^\s*import\s+.+?\s+from\s+['"]([^'"]+)['"]/);
      const m2 = line.match(/^\s*import\s+['"]([^'"]+)['"]/);
      if (m) imports.push(m[1]);
      else if (m2) imports.push(m2[1]);
    }
  }
  return imports.slice(0, 40);
}

function ctorFromClass(cls: FlatSymbol | undefined, text: string): IdeSemanticPacket["constructors"] {
  if (!cls) return [];
  const ctor = cls.children.find(
    (c) => c.kind === vscode.SymbolKind.Constructor || c.name === "constructor"
  );
  if (ctor?.detail) {
    const params = [...ctor.detail.matchAll(/(\w+)\s*:\s*([\w.<>[\]]+)/g)].map((m) => ({
      name: m[1],
      type: m[2],
    }));
    if (params.length) return [{ params, snippet: ctor.detail }];
  }
  // C# / TS fallback: constructor(...) lines near class start
  const slice = text
    .split(/\r?\n/)
    .slice(cls.range.start.line, Math.min(cls.range.start.line + 40, cls.range.end.line + 1))
    .join("\n");
  const m = slice.match(/constructor\s*\(([^)]*)\)/);
  if (m) {
    const params = m[1]
      .split(",")
      .map((p) => p.trim())
      .filter(Boolean)
      .map((p) => {
        const mm = p.match(/(?:(?:private|public|protected|readonly)\s+)*(\w+)\s*:\s*([\w.<>[\]]+)/);
        if (mm) return { name: mm[1], type: mm[2] };
        const cs = p.match(/([\w.<>[\]]+)\s+(\w+)\s*$/);
        if (cs) return { name: cs[2], type: cs[1] };
        return { name: p, type: "unknown" };
      });
    return [{ params }];
  }
  return [];
}

function snippetAround(doc: vscode.TextDocument, range: vscode.Range, maxLines = 80): string {
  const start = Math.max(0, range.start.line);
  const end = Math.min(doc.lineCount - 1, Math.max(range.end.line, start + 1));
  const capped = Math.min(end, start + maxLines - 1);
  const parts: string[] = [];
  for (let i = start; i <= capped; i++) parts.push(doc.lineAt(i).text);
  return parts.join("\n");
}

async function getDocumentSymbols(doc: vscode.TextDocument): Promise<vscode.DocumentSymbol[]> {
  try {
    const result = await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
      "vscode.executeDocumentSymbolProvider",
      doc.uri
    );
    return Array.isArray(result) ? result : [];
  } catch {
    return [];
  }
}

async function findRefs(doc: vscode.TextDocument, pos: vscode.Position, limit = 12): Promise<SymbolRef[]> {
  try {
    const locs = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      doc.uri,
      pos
    );
    if (!Array.isArray(locs)) return [];
    return locs.slice(0, limit).map((l) => ({
      file: toRel(l.uri.fsPath),
      range: rangeOf(l.range),
    }));
  } catch {
    return [];
  }
}

async function findImpls(doc: vscode.TextDocument, pos: vscode.Position, limit = 8): Promise<SymbolRef[]> {
  try {
    const locs = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeImplementationProvider",
      doc.uri,
      pos
    );
    if (!Array.isArray(locs)) return [];
    return locs.slice(0, limit).map((l) => ({
      file: toRel(l.uri.fsPath),
      range: rangeOf(l.range),
    }));
  } catch {
    return [];
  }
}

export type FocusSnapshot = {
  focus: IdeSemanticPacket["focus"];
  confidence: Confidence;
  language: string;
  workspaceRoot: string;
};

export async function buildFocusSnapshot(
  editor?: vscode.TextEditor | null
): Promise<FocusSnapshot | null> {
  const ed = editor ?? vscode.window.activeTextEditor;
  if (!ed) return null;
  const doc = ed.document;
  if (doc.uri.scheme !== "file") return null;

  const pos = ed.selection.active;
  const symbols = await getDocumentSymbols(doc);
  const flat = flattenSymbols(symbols);
  const method = findEnclosing(flat, pos, METHOD_KINDS);
  const cls = findEnclosing(flat, pos, CONTAINER_KINDS);

  const file = toRel(doc.uri.fsPath);
  let confidence: Confidence = "high";
  const gaps: string[] = [];

  if (!symbols.length) {
    confidence = "low";
    gaps.push("no_document_symbols");
  } else if (!method && !cls) {
    confidence = "medium";
    gaps.push("no_enclosing_symbol");
  }

  const symbol = cls?.name || method?.name || doc.fileName.split(/[/\\]/).pop() || "unknown";
  const kind = cls ? mapKind(cls.kind) : method ? mapKind(method.kind) : "file";

  return {
    focus: {
      file,
      symbol,
      kind,
      method: method?.name,
      range: method ? rangeOf(method.range) : cls ? rangeOf(cls.range) : rangeOf(ed.selection),
    },
    confidence,
    language: languageId(doc),
    workspaceRoot: workspaceRoot(),
  };
}

export async function buildSemanticPacket(opts?: {
  includeDependencies?: boolean;
  maxSnippetChars?: number;
  editor?: vscode.TextEditor | null;
}): Promise<IdeSemanticPacket | null> {
  const ed = opts?.editor ?? vscode.window.activeTextEditor;
  if (!ed) return null;
  const doc = ed.document;
  if (doc.uri.scheme !== "file") return null;

  const snap = await buildFocusSnapshot(ed);
  if (!snap) return null;

  const pos = ed.selection.active;
  const symbols = await getDocumentSymbols(doc);
  const flat = flattenSymbols(symbols);
  const method = findEnclosing(flat, pos, METHOD_KINDS);
  const cls = findEnclosing(flat, pos, CONTAINER_KINDS);
  const text = doc.getText();
  const maxChars = opts?.maxSnippetChars ?? 12_000;

  let focusSnippet = "";
  if (method) focusSnippet = snippetAround(doc, method.range);
  else if (cls) focusSnippet = snippetAround(doc, cls.range);
  else focusSnippet = text.slice(0, Math.min(maxChars, 4000));
  if (focusSnippet.length > maxChars) focusSnippet = focusSnippet.slice(0, maxChars);

  const signatures: string[] = [];
  if (method?.detail) signatures.push(`${method.name}${method.detail}`);
  else if (method) signatures.push(method.name);

  const gaps = snap.confidence === "low" ? ["no_document_symbols"] : [];
  if (snap.confidence === "medium") gaps.push("no_enclosing_symbol");

  const targetPos = method?.selectionRange.start ?? cls?.selectionRange.start ?? pos;
  const references = await findRefs(doc, targetPos);
  const implementations = await findImpls(doc, targetPos);

  const packet: IdeSemanticPacket = {
    protocolVersion: IDE_PROTOCOL_VERSION,
    ide: detectIde(),
    workspaceRoot: snap.workspaceRoot,
    language: snap.language,
    frameworkHints: frameworkHints(snap.language, text),
    focus: snap.focus,
    signatures,
    constructors: ctorFromClass(cls, text),
    imports: extractImports(text, snap.language),
    dependencies: [],
    references,
    implementations,
    callHierarchy: { callees: [], callers: [] },
    focusSnippet,
    diagnostics: { confidence: snap.confidence, gaps },
  };

  return packet;
}

export function symbolInfoFromFocus(
  focus: IdeSemanticPacket["focus"],
  role: "method" | "class"
): SymbolInfo | null {
  if (role === "method") {
    if (!focus.method && focus.kind !== "method" && focus.kind !== "function") return null;
    return {
      name: focus.method || focus.symbol,
      kind: focus.method ? "method" : focus.kind,
      file: focus.file,
      containerName: focus.method ? focus.symbol : undefined,
      range: focus.range,
    };
  }
  return {
    name: focus.symbol,
    kind: focus.kind,
    file: focus.file,
    range: focus.range,
  };
}

export async function getCurrentSelection(): Promise<{
  file: string;
  text: string;
  range: TextRange;
} | null> {
  const ed = vscode.window.activeTextEditor;
  if (!ed || ed.document.uri.scheme !== "file") return null;
  return {
    file: toRel(ed.document.uri.fsPath),
    text: ed.document.getText(ed.selection),
    range: rangeOf(ed.selection),
  };
}

export { detectIde, workspaceRoot, toRel };
