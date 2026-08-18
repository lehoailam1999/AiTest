import type { UnitApproveResolveParams } from "@aitest/ide-protocol";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";

const DENIED_PATH =
  /(^|[\\/])(tests?|specs?|__tests__|e2e|node_modules|dist|build|out|migrations?|clientapp)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const LOGIC_PATH =
  /(^|[\\/])(application|domain|services?|handlers?|commands?|queries?|validators?|policies)([\\/]|$)/i;
const LOGIC_NAME =
  /(Handler|Service|UseCase|Validator|Policy|Command|Query|Controller)$/i;
const ENTRY_METHOD = /^(Handle|HandleAsync|Execute|ExecuteAsync|Validate|Create|Update|Delete)$/i;

export type DeterministicCandidate = {
  id: string;
  name: string;
  kind: "class" | "interface" | "method" | "function";
  pathRel: string;
  containerName?: string;
  range: {
    start: number;
    end: number;
    startCharacter?: number;
    endCharacter?: number;
  };
  /** Source-backed relevance; independent of workspace-symbol fuzzy scores. */
  evidenceScore: number;
};

export type DeterministicDiscovery = {
  candidates: DeterministicCandidate[];
  documents: RepoDocument[];
  queries: string[];
  hitPaths: string[];
};

function phrases(params: UnitApproveResolveParams): string[] {
  const values = [
    params.tcIr.requirement.title,
    params.tcIr.module,
    ...params.tcIr.title.split(/\s+[-–—]\s+/),
  ]
    .map((value) => String(value || "").trim())
    .filter((value) => value.length >= 5 && value.split(/\s+/).length >= 2);
  return [...new Set(values)].slice(0, 4);
}

function flatten(
  symbols: readonly RepoDocumentSymbol[],
  parent: string | undefined,
  out: Array<{ symbol: RepoDocumentSymbol; parent?: string }>
): void {
  for (const symbol of symbols) {
    out.push({ symbol, parent });
    flatten(symbol.children, symbol.name, out);
  }
}

function kindOf(kind: number): DeterministicCandidate["kind"] | null {
  if (kind === 4 || kind === 10) return "class";
  if (kind === 11) return "interface";
  if (kind === 12) return "function";
  // VS Code SymbolKind.Method = 5, Constructor = 8.
  if (kind === 5 || kind === 8) return "method";
  return null;
}

function pathScore(pathRel: string): number {
  let score = LOGIC_PATH.test(pathRel) ? 25 : 0;
  if (/(Handler|Service|Validator|Policy|UseCase)\.[^.]+$/i.test(pathRel)) score += 20;
  if (/Controller\.[^.]+$/i.test(pathRel)) score -= 8;
  return score;
}

/**
 * Source-first discovery: search exact business phrases inside production files,
 * then inspect document symbols in the matching files. This works across
 * languages without a VI→EN dictionary whenever source strings, attributes, or
 * comments preserve the business vocabulary. Cursor is consulted only if this
 * repository evidence is absent or ambiguous.
 */
export async function discoverPrimaryFromSourceText(
  params: UnitApproveResolveParams,
  runtime: RepositoryRuntime,
  limits: { maxSymbolCandidates: number; maxFileBytes: number }
): Promise<DeterministicDiscovery> {
  const queries = phrases(params);
  if (!runtime.searchText || !queries.length) {
    return { candidates: [], documents: [], queries: [], hitPaths: [] };
  }

  const byPath = new Map<string, { pathRel: string; hits: number; chars: number }>();
  for (const query of queries) {
    const result = await runtime.searchText(query, 20, 800);
    for (const hit of result.hits) {
      if (DENIED_PATH.test(hit.pathRel)) continue;
      const key = hit.pathRel.replace(/\\/g, "/").toLowerCase();
      const old = byPath.get(key) || { pathRel: hit.pathRel, hits: 0, chars: 0 };
      old.hits += 1;
      old.chars += query.length;
      byPath.set(key, old);
    }
  }

  const rankedPaths = [...byPath.values()]
    .sort(
      (a, b) =>
        b.hits * 30 +
        b.chars +
        pathScore(b.pathRel) -
        (a.hits * 30 + a.chars + pathScore(a.pathRel))
    )
    .slice(0, 6);
  const documents: RepoDocument[] = [];
  const candidates: DeterministicCandidate[] = [];

  for (const entry of rankedPaths) {
    const doc = await runtime.readDocument(entry.pathRel, limits.maxFileBytes);
    if (!doc?.text) continue;
    documents.push(doc);
    const flat: Array<{ symbol: RepoDocumentSymbol; parent?: string }> = [];
    flatten(doc.symbols, undefined, flat);
    for (const { symbol, parent } of flat) {
      const kind = kindOf(symbol.kind);
      if (!kind) continue;
      const isLogicType =
        (kind === "class" || kind === "interface") && LOGIC_NAME.test(symbol.name);
      const isEntry = kind === "method" && ENTRY_METHOD.test(symbol.name);
      if (!isLogicType && !isEntry) continue;
      const evidenceScore =
        entry.hits * 35 +
        Math.min(20, entry.chars / 2) +
        pathScore(entry.pathRel) +
        (isEntry ? 12 : 8);
      candidates.push({
        id: `${entry.pathRel}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}:${symbol.name}`,
        name: symbol.name,
        kind,
        pathRel: entry.pathRel,
        containerName: parent,
        range: {
          start: symbol.selectionRange.start.line,
          end: symbol.selectionRange.end.line,
          startCharacter: symbol.selectionRange.start.character,
          endCharacter: symbol.selectionRange.end.character,
        },
        evidenceScore,
      });
    }
  }

  return {
    candidates: candidates
      .sort((a, b) => b.evidenceScore - a.evidenceScore)
      .slice(0, limits.maxSymbolCandidates),
    documents,
    queries,
    hitPaths: rankedPaths.map((item) => item.pathRel),
  };
}
