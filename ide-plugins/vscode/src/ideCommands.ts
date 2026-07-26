/**
 * P10 — IDE Command Layer handlers (VS Code / Cursor).
 * Hard-capped hits + bytes — never dump workspace.
 */
import * as vscode from "vscode";
import {
  IdeCommandLimits,
  type FindImplementationsResult,
  type FindReferencesResult,
  type GoToDefinitionResult,
  type ReadFileParams,
  type ReadFileResult,
  type SearchSymbolParams,
  type SearchSymbolResult,
  type SearchTextParams,
  type SearchTextResult,
  type SymbolHit,
  type SymbolKind,
  type SymbolPositionParams,
  type SymbolRef,
  type TextHit,
  type TextRange,
} from "@aitest/ide-protocol";
import { toRel, workspaceRoot } from "./semanticContext";

function clampMax(n: number | undefined, hard: number): number {
  if (n == null || !Number.isFinite(n) || n <= 0) return hard;
  return Math.min(Math.floor(n), hard);
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

function makeSymbolId(pathRel: string, range: vscode.Range, name: string): string {
  return `${pathRel}:${range.start.line}:${range.start.character}:${name}`;
}

/** Build/output trees — prefer real source when ranking search hits. */
const BUILD_PATH_RE =
  /(^|\/)(node_modules|dist|build|out|\.next|coverage|\.turbo|__pycache__|\.git)(\/|$)/i;

const FIND_FILES_EXCLUDE =
  "{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.next/**,**/coverage/**}";

function isBuildArtifactPath(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/");
  return BUILD_PATH_RE.test(p);
}

function sourcePreferScore(pathRel: string): number {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (isBuildArtifactPath(p)) return -100;
  if (p.endsWith(".d.ts")) return -25;
  if (/\.(ts|tsx|cs|java|py|go|kt)$/.test(p)) return 25;
  if (/\.(js|jsx)$/.test(p)) return 10;
  return 0;
}

function rankSymbolHits(hits: SymbolHit[], query: string): SymbolHit[] {
  const q = query.toLowerCase();
  return [...hits].sort((a, b) => {
    const nameRank = (n: string) => {
      const x = n.toLowerCase();
      if (x === q) return 3;
      if (x.startsWith(q)) return 2;
      if (x.includes(q)) return 1;
      return 0;
    };
    const da =
      nameRank(a.name) * 40 +
      sourcePreferScore(a.pathRel) +
      (a.score ?? 0) * 10;
    const db =
      nameRank(b.name) * 40 +
      sourcePreferScore(b.pathRel) +
      (b.score ?? 0) * 10;
    return db - da;
  });
}

function parseSymbolId(
  id: string
): { pathRel: string; line: number; character: number; name: string } | null {
  const m = id.match(/^(.+):(\d+):(\d+):(.+)$/);
  if (!m) return null;
  return {
    pathRel: m[1],
    line: Number(m[2]),
    character: Number(m[3]),
    name: m[4],
  };
}

function absUri(pathRel: string): vscode.Uri | null {
  const root = workspaceRoot();
  if (!root) return null;
  const joined = `${root.replace(/[\\/]$/, "")}/${pathRel.replace(/\\/g, "/")}`;
  return vscode.Uri.file(joined);
}

async function resolvePosition(
  params: SymbolPositionParams
): Promise<{ uri: vscode.Uri; position: vscode.Position } | null> {
  if (params.symbolId) {
    const parsed = parseSymbolId(params.symbolId);
    if (parsed) {
      const uri = absUri(parsed.pathRel);
      if (uri) {
        return { uri, position: new vscode.Position(parsed.line, parsed.character) };
      }
    }
  }
  if (params.pathRel != null && params.line != null) {
    const uri = absUri(params.pathRel);
    if (uri) {
      return {
        uri,
        position: new vscode.Position(params.line, params.character ?? 0),
      };
    }
  }
  const ed = vscode.window.activeTextEditor;
  if (ed && ed.document.uri.scheme === "file") {
    return { uri: ed.document.uri, position: ed.selection.active };
  }
  return null;
}

export async function handleSearchSymbol(params: SearchSymbolParams): Promise<SearchSymbolResult> {
  const query = (params.query || "").trim();
  const max = clampMax(params.maxResults, IdeCommandLimits.searchSymbolMaxResults);
  if (!query) return { hits: [], truncated: false };

  let infos: vscode.SymbolInformation[] = [];
  try {
    const result = await vscode.commands.executeCommand<vscode.SymbolInformation[]>(
      "vscode.executeWorkspaceSymbolProvider",
      query
    );
    infos = Array.isArray(result) ? result : [];
  } catch {
    infos = [];
  }

  let hits: SymbolHit[] = infos
    .filter((s) => s.location?.uri?.scheme === "file")
    .map((s) => {
      const pathRel = toRel(s.location.uri.fsPath);
      const kind = mapKind(s.kind);
      return {
        id: makeSymbolId(pathRel, s.location.range, s.name),
        name: s.name,
        kind,
        pathRel,
        containerName: s.containerName || undefined,
        range: rangeOf(s.location.range),
        score: s.name.toLowerCase() === query.toLowerCase() ? 1 : 0.75,
      };
    });

  if (params.kinds?.length) {
    const set = new Set(params.kinds);
    hits = hits.filter((h) => set.has(h.kind));
  }

  // Prefer source (src/*.ts) over dist/*.d.ts when both match.
  const sourceOnly = hits.filter((h) => !isBuildArtifactPath(h.pathRel));
  if (sourceOnly.length > 0) hits = sourceOnly;
  hits = rankSymbolHits(hits, query);

  const truncated = hits.length > max;
  return { hits: hits.slice(0, max), truncated };
}

export async function handleSearchText(params: SearchTextParams): Promise<SearchTextResult> {
  const query = params.query || "";
  const max = clampMax(params.maxResults, IdeCommandLimits.searchTextMaxResults);
  const maxBytes = clampMax(params.maxBytesPerHit, IdeCommandLimits.searchTextMaxBytesPerHit);
  if (!query) return { hits: [], truncated: false };

  const hits: TextHit[] = [];
  let truncated = false;

  // Prefer findTextInFiles when available (VS Code / Cursor)
  type FindTextFn = (
    query: { pattern: string; isRegExp?: boolean },
    options: {
      maxResults?: number;
      include?: string;
      previewOptions?: { matchLines: number; charsPerLine: number };
    },
    callback: (result: {
      uri?: vscode.Uri;
      ranges?: vscode.Range | vscode.Range[];
      preview?: { text?: string };
    }) => void
  ) => Thenable<unknown>;

  const findText = (vscode.workspace as unknown as { findTextInFiles?: FindTextFn })
    .findTextInFiles;

  // Proposed API — may throw if not in enabledApiProposals; always fall back.
  if (typeof findText === "function") {
    try {
      await new Promise<void>((resolve, reject) => {
        void findText(
          { pattern: query, isRegExp: false },
          {
            maxResults: max + 1,
            include: params.glob,
            previewOptions: { matchLines: 1, charsPerLine: maxBytes },
          },
          (result) => {
            if (hits.length >= max) {
              truncated = true;
              return;
            }
            if (!result.ranges || !result.uri || result.uri.scheme !== "file") return;
            const range = Array.isArray(result.ranges) ? result.ranges[0] : result.ranges;
            const preview =
              result.preview?.text?.trim().slice(0, maxBytes) || query.slice(0, maxBytes);
            hits.push({
              pathRel: toRel(result.uri.fsPath),
              line: range.start.line,
              character: range.start.character,
              preview,
            });
          }
        ).then(
          () => resolve(),
          (err: unknown) => reject(err)
        );
      });
      return { hits: hits.slice(0, max), truncated: truncated || hits.length > max };
    } catch {
      hits.length = 0;
      truncated = false;
      // fall through to findFiles scan
    }
  }

  // Fallback: scan a small set of files (never whole tree)
  const include = params.glob || "**/*.{ts,tsx,js,jsx,cs,py,java,go}";
  const uris = await vscode.workspace.findFiles(include, FIND_FILES_EXCLUDE, 40);
  const rankedUris = [...uris].sort(
    (a, b) => sourcePreferScore(toRel(b.fsPath)) - sourcePreferScore(toRel(a.fsPath))
  );
  for (const uri of rankedUris) {
    if (hits.length >= max) {
      truncated = true;
      break;
    }
    if (isBuildArtifactPath(toRel(uri.fsPath))) continue;
    let text: string;
    try {
      const doc = await vscode.workspace.openTextDocument(uri);
      text = doc.getText();
    } catch {
      continue;
    }
    if (text.length > IdeCommandLimits.readFileMaxBytes * 4) {
      text = text.slice(0, IdeCommandLimits.readFileMaxBytes * 4);
    }
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const idx = lines[i].indexOf(query);
      if (idx < 0) continue;
      hits.push({
        pathRel: toRel(uri.fsPath),
        line: i,
        character: idx,
        preview: lines[i].trim().slice(0, maxBytes),
      });
      if (hits.length >= max) {
        truncated = true;
        break;
      }
    }
  }
  return { hits, truncated };
}

export async function handleGoToDefinition(
  params: SymbolPositionParams
): Promise<GoToDefinitionResult> {
  const resolved = await resolvePosition(params);
  if (!resolved) return { locations: [] };

  let locs: (vscode.Location | vscode.LocationLink)[] = [];
  try {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeDefinitionProvider",
      resolved.uri,
      resolved.position
    );
    locs = Array.isArray(result) ? result : [];
  } catch {
    locs = [];
  }

  const locations = locs.slice(0, 8).map((l) => {
    if ("targetUri" in l) {
      return {
        pathRel: toRel(l.targetUri.fsPath),
        range: rangeOf(l.targetRange),
      };
    }
    return {
      pathRel: toRel(l.uri.fsPath),
      range: rangeOf(l.range),
    };
  });
  return { locations };
}

export async function handleFindReferences(
  params: SymbolPositionParams
): Promise<FindReferencesResult> {
  const max = clampMax(params.maxResults, IdeCommandLimits.findReferencesMaxResults);
  const resolved = await resolvePosition(params);
  if (!resolved) return { refs: [], truncated: false };

  let locs: vscode.Location[] = [];
  try {
    const result = await vscode.commands.executeCommand<vscode.Location[]>(
      "vscode.executeReferenceProvider",
      resolved.uri,
      resolved.position
    );
    locs = Array.isArray(result) ? result : [];
  } catch {
    locs = [];
  }

  const truncated = locs.length > max;
  const refs: SymbolRef[] = locs.slice(0, max).map((l) => ({
    file: toRel(l.uri.fsPath),
    range: rangeOf(l.range),
  }));
  return { refs, truncated };
}

export async function handleFindImplementations(
  params: SymbolPositionParams
): Promise<FindImplementationsResult> {
  const max = clampMax(params.maxResults, IdeCommandLimits.findImplementationsMaxResults);
  const resolved = await resolvePosition(params);
  if (!resolved) return { locations: [], truncated: false };

  let locs: (vscode.Location | vscode.LocationLink)[] = [];
  try {
    const result = await vscode.commands.executeCommand<(vscode.Location | vscode.LocationLink)[]>(
      "vscode.executeImplementationProvider",
      resolved.uri,
      resolved.position
    );
    locs = Array.isArray(result) ? result : [];
  } catch {
    locs = [];
  }

  const truncated = locs.length > max;
  const locations = locs.slice(0, max).map((l) => {
    if ("targetUri" in l) {
      return { pathRel: toRel(l.targetUri.fsPath), range: rangeOf(l.targetRange) };
    }
    return { pathRel: toRel(l.uri.fsPath), range: rangeOf(l.range) };
  });
  return { locations, truncated };
}

export async function handleReadFile(params: ReadFileParams): Promise<ReadFileResult> {
  const pathRel = params.pathRel?.replace(/\\/g, "/");
  if (!pathRel) {
    return { pathRel: "", content: "", startLine: 0, endLine: 0, truncated: false };
  }
  const uri = absUri(pathRel);
  if (!uri) {
    return { pathRel, content: "", startLine: 0, endLine: 0, truncated: false };
  }

  let doc: vscode.TextDocument;
  try {
    doc = await vscode.workspace.openTextDocument(uri);
  } catch {
    return { pathRel, content: "", startLine: 0, endLine: 0, truncated: false };
  }

  const maxBytes = clampMax(params.maxBytes, IdeCommandLimits.readFileMaxBytes);
  const start = Math.max(0, params.startLine ?? 0);
  let end =
    params.endLine ??
    Math.min(doc.lineCount - 1, start + IdeCommandLimits.readFileMaxLines - 1);
  end = Math.min(end, doc.lineCount - 1, start + IdeCommandLimits.readFileMaxLines - 1);

  const parts: string[] = [];
  for (let i = start; i <= end; i++) parts.push(doc.lineAt(i).text);
  let content = parts.join("\n");
  let truncated = end < doc.lineCount - 1 || start > 0;
  if (content.length > maxBytes) {
    content = content.slice(0, maxBytes);
    truncated = true;
  }

  return {
    pathRel,
    content,
    startLine: start,
    endLine: end,
    truncated,
    totalLines: doc.lineCount,
  };
}
