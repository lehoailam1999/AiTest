import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { ReadFileResult } from "@aitest/ide-protocol";
import {
  handleFindImplementations,
  handleFindReferences,
  handleGoToDefinition,
  handleReadFile,
  handleSearchSymbol,
  handleSearchText,
} from "../ideCommands";
import { toRel, workspaceRoot } from "../semanticContext";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";

const execFileAsync = promisify(execFile);

function mapSymbol(symbol: vscode.DocumentSymbol): RepoDocumentSymbol {
  return {
    name: symbol.name,
    detail: symbol.detail || undefined,
    kind: symbol.kind,
    range: {
      start: { line: symbol.range.start.line, character: symbol.range.start.character },
      end: { line: symbol.range.end.line, character: symbol.range.end.character },
    },
    selectionRange: {
      start: {
        line: symbol.selectionRange.start.line,
        character: symbol.selectionRange.start.character,
      },
      end: {
        line: symbol.selectionRange.end.line,
        character: symbol.selectionRange.end.character,
      },
    },
    children: symbol.children.map(mapSymbol),
  };
}

async function documentSymbols(uri: vscode.Uri): Promise<RepoDocumentSymbol[]> {
  try {
    const symbols =
      (await vscode.commands.executeCommand<vscode.DocumentSymbol[]>(
        "vscode.executeDocumentSymbolProvider",
        uri
      )) || [];
    return symbols.map(mapSymbol);
  } catch {
    return [];
  }
}

/** Hard ceiling so a pathological file cannot pin the extension host. */
const MAX_DOCUMENT_CHARS = 2_000_000;

async function readDocument(pathRel: string, maxBytes: number): Promise<RepoDocument | null> {
  const root = workspaceRoot();
  if (!root) return null;
  const uri = vscode.Uri.file(
    `${root.replace(/[\\/]$/, "")}/${pathRel.replace(/\\/g, "/")}`
  );
  try {
    const doc = await vscode.workspace.openTextDocument(uri);
    // Text must stay whole: Gen re-hashes the full file and any truncation here
    // would silently invalidate the approved decision. maxBytes only bounds the
    // fallback read when the document cannot be opened as text.
    const text = doc.getText();
    const content =
      text.length > 0
        ? text
        : ((await handleReadFile({ pathRel, maxBytes })) as ReadFileResult).content;
    if (content.length > MAX_DOCUMENT_CHARS) return null;
    return {
      pathRel: toRel(uri.fsPath),
      language: doc.languageId,
      text: content,
      version: doc.version,
      dirty: doc.isDirty,
      symbols: await documentSymbols(uri),
    };
  } catch {
    return null;
  }
}

export const vscodeRepositoryRuntime: RepositoryRuntime = {
  workspaceRoot,
  now: () => new Date(),
  async git(args) {
    const root = workspaceRoot();
    if (!root) throw new Error("No workspace");
    const { stdout } = await execFileAsync("git", [...args], {
      cwd: root,
      windowsHide: true,
      timeout: 3000,
      maxBuffer: 1024 * 1024,
    });
    return stdout.trim();
  },
  async dirtyDocuments() {
    const docs: RepoDocument[] = [];
    for (const doc of vscode.workspace.textDocuments) {
      if (!doc.isDirty || doc.uri.scheme !== "file") continue;
      docs.push({
        pathRel: toRel(doc.uri.fsPath),
        language: doc.languageId,
        text: doc.getText(),
        version: doc.version,
        dirty: true,
        symbols: await documentSymbols(doc.uri),
      });
    }
    return docs;
  },
  searchSymbol: (query, maxResults) => handleSearchSymbol({ query, maxResults }),
  searchText: (query, maxResults, maxBytesPerHit) =>
    handleSearchText({
      query,
      glob: "**/*.{cs,ts,tsx,js,jsx,java,kt,py,go}",
      maxResults,
      maxBytesPerHit,
    }),
  definition: handleGoToDefinition,
  references: handleFindReferences,
  implementations: handleFindImplementations,
  readDocument,
  async findSourceFiles(maxResults) {
    const uris = await vscode.workspace.findFiles(
      "**/*.{cs,ts,tsx,js,jsx,java,kt,py,go}",
      "{**/node_modules/**,**/dist/**,**/build/**,**/out/**,**/.git/**}",
      maxResults
    );
    return uris.map((uri) => toRel(uri.fsPath));
  },
};
