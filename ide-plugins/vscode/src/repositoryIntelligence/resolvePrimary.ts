import {
  filterUnitLogicLayerCandidates,
  type GroundedSymbol,
  type GroundedSymbolKind,
  type UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import { discoverPrimaryFromSourceText } from "./deterministicDiscovery";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";
import { expandTypeReferences } from "./relatedTypes";
import { symbolProposerInput, type SymbolProposer } from "./symbolProposer";

export type ProposalDiagnostics = {
  attempted: boolean;
  /** Why the bridge did not run, when it did not. */
  skipped?: "not_needed" | "no_budget" | "not_configured";
  proposedSymbols: readonly string[];
  proposedPaths: readonly string[];
  /** Proposed identifiers the symbol index actually confirmed. */
  verifiedSymbols: readonly string[];
  error?: string;
  engine?: string;
  /** Answer reused from an earlier TC of this batch. */
  memoHit?: boolean;
};

export type SymbolIndexDiagnostics = {
  queries: number;
  hits: number;
  retried: boolean;
};

export type SourceDiscoveryDiagnostics = {
  queries: readonly string[];
  hitPaths: readonly string[];
  candidateCount: number;
};

export type PrimaryResolution = {
  primary: GroundedSymbol | null;
  relatedPaths: string[];
  documents: Map<string, RepoDocument>;
  ambiguous: boolean;
  proposal: ProposalDiagnostics;
  symbolIndex: SymbolIndexDiagnostics;
  sourceDiscovery: SourceDiscoveryDiagnostics;
  /** Set when a path/symbol marker was present but not followed. */
  hintIgnored?: string;
};

type Candidate = {
  id: string;
  name: string;
  kind: string;
  pathRel: string;
  containerName?: string;
  range: {
    start: number;
    end: number;
    startCharacter?: number;
    endCharacter?: number;
  };
  score: number;
};

const STRONG_CANDIDATE_SCORE = 90;
const TEST_PATH =
  /(^|[\\/])(tests?|spec|specs|__tests__|e2e)([\\/]|$)|\.(test|spec)\.[cm]?[jt]sx?$/i;
const GENERIC_ENTRY_METHODS = new Set(["handle", "execute", "invoke", "run", "call"]);
const STRUCTURAL_QUERY_QUERIES = [
  "GetAllQueryHandler",
  "QueryHandler",
  "SearchQueryHandler",
  "ListQueryHandler",
];

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

/**
 * Only a hint the repository has already corroborated may become a query. An
 * unverified marker written by a previous refusal would otherwise search for its
 * own wrong symbol and re-elect it, so the mistake would never wash out.
 */
function expandTerms(values: readonly (string | undefined)[]): string[] {
  const out: string[] = [];
  for (const value of values) {
    if (!value?.trim()) continue;
    out.push(value.trim());
    for (const token of value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[\p{L}\d]+/gu) || []) {
      if (token.length >= 3) out.push(token);
    }
  }
  return [...new Set(out)];
}

function takeTerms(values: readonly string[], limit: number): string[] {
  return values.slice(0, limit);
}

function isGenericEntryMethod(name: string): boolean {
  return GENERIC_ENTRY_METHODS.has(norm(name));
}

/**
 * Target fields and operation-family names are reserved so a long requirement
 * title cannot starve the queries that actually reach production handlers.
 */
function queryTerms(
  params: UnitApproveResolveParams,
  trustedSymbol?: string
): string[] {
  const fields = expandTerms(params.tcIr.testData.target?.fields || []);
  const inputKeys = expandTerms(Object.keys(params.tcIr.testData.input || {}));
  const operations = impliesQueryList(params) ? STRUCTURAL_QUERY_QUERIES : [];
  const rest = expandTerms([
    trustedSymbol,
    params.tcIr.title,
    params.tcIr.hints?.sourceSignal,
    params.tcIr.requirement.behaviorId,
    params.tcIr.requirement.title,
    params.tcIr.module,
  ]);
  return [
    ...takeTerms(fields, 4),
    ...takeTerms(inputKeys, 4),
    ...takeTerms(operations, 4),
    ...takeTerms(rest, 6),
  ].filter((value, index, all) => all.indexOf(value) === index);
}

/**
 * Tokens are normalized one word at a time: normalizing the joined text first
 * collapses everything into a single token that can never match a symbol name.
 */
function signalTokens(params: UnitApproveResolveParams, minLength: number): string[] {
  const words = [
    params.tcIr.requirement.behaviorId,
    params.tcIr.requirement.title,
    params.tcIr.title,
    params.tcIr.module,
    ...(params.tcIr.testData.target?.fields || []),
  ]
    .filter((value): value is string => Boolean(value))
    .flatMap(
      (value) => value.match(/[A-Z]?[a-z]+|[A-Z]+(?![a-z])|[\p{L}\d]+/gu) || []
    );
  const tokens = words
    .map((word) => norm(word))
    .filter((token) => token.length >= minLength);
  return [...new Set(tokens)];
}

/**
 * A path/symbol marker is only a hint, and stale markers written by an earlier
 * resolver are common, so it is trusted only when the repository confirms it and
 * it actually relates to what this test case is about.
 */
function hintIsTrustworthy(
  hintPath: string,
  symbolName: string,
  params: UnitApproveResolveParams
): boolean {
  if (TEST_PATH.test(hintPath)) return false;
  const haystack = norm(`${symbolName} ${hintPath}`);
  return signalTokens(params, 4).some((token) => haystack.includes(token));
}

type ScoreContext = {
  trustedHint: { pathRel?: string; symbol?: string } | null;
  /**
   * Normalized identifiers proposed for this test case and found in the repo,
   * mapped to the rank the proposer gave them. A proposal answer lists the
   * subject first and its collaborators after, and scoring every confirmed name
   * the same amount makes the handler, its command and its DTO score identically
   * — which reads as ambiguity even though the proposer did rank them.
   */
  proposedSymbols: ReadonlyMap<string, number>;
  proposedPaths: ReadonlySet<string>;
  deterministicIds: ReadonlySet<string>;
  /** Files where deterministic source-text discovery matched the test case. */
  discoveredPaths: ReadonlySet<string>;
};

function tcCorpus(params: UnitApproveResolveParams): string {
  return [
    params.tcIr.title,
    params.tcIr.expected.description,
    params.tcIr.expected.observable,
    params.tcIr.testData.target?.constraint,
    ...(params.tcIr.steps.execute || []),
  ]
    .filter(Boolean)
    .join(" ");
}

function impliesQueryList(params: UnitApproveResolveParams): boolean {
  return /(?:quan sát:\s*)?query\b|danh\s*sách|getall|findall|\blist\b|chỉ\s+trả\s+về|tìm\s+kiếm|truy\s+vấn|\bsearch\b|\blookup\b|\bfilter\b|\bpaged\b/i.test(
    tcCorpus(params)
  );
}

function looksLikeQueryHandler(candidate: Candidate): boolean {
  return /(queryhandler|getall|findall|searchquery|listquery)/i.test(
    `${candidate.name} ${candidate.containerName || ""} ${candidate.pathRel}`
  );
}

function scoreCandidate(
  candidate: Candidate,
  params: UnitApproveResolveParams,
  context: ScoreContext
): number {
  const { trustedHint } = context;
  const haystack = norm(
    `${candidate.name} ${candidate.containerName || ""} ${candidate.pathRel}`
  );
  let score = candidate.score * 20;
  if (candidate.kind === "method" || candidate.kind === "function") score += 18;
  if (candidate.kind === "class") score += 10;
  if (/(^|\/)(dist|build|out|node_modules)(\/|$)/i.test(candidate.pathRel)) score -= 100;
  if (/(^|\/)(configuration|startup)(\/|$)|appsettings|program\.cs$/i.test(candidate.pathRel)) {
    score -= 40;
  }
  for (const token of signalTokens(params, 3)) {
    if (haystack.includes(token)) score += Math.min(16, token.length * 2);
  }
  if (impliesQueryList(params)) {
    if (/(query|getall|findall)/i.test(`${candidate.name} ${candidate.pathRel}`)) score += 45;
    else if (/(command|create|update|delete)handler/i.test(candidate.name)) score -= 15;
  }
  if (trustedHint?.pathRel && norm(candidate.pathRel) === norm(trustedHint.pathRel)) {
    score += 200;
  }
  if (trustedHint?.symbol && norm(candidate.name) === norm(trustedHint.symbol)) {
    score += 150;
  }
  const nameRank = context.proposedSymbols.get(norm(candidate.name));
  if (nameRank !== undefined) score += Math.max(32, 60 - nameRank * 7);
  const containerRank = context.proposedSymbols.get(norm(candidate.containerName || ""));
  if (containerRank !== undefined) score += Math.max(26, 50 - containerRank * 7);
  if (
    context.proposedPaths.has(norm(candidate.pathRel)) &&
    (context.proposedSymbols.has(norm(candidate.name)) ||
      context.proposedSymbols.has(norm(candidate.containerName || "")))
  ) {
    score += 30;
  }
  if (context.deterministicIds.has(candidate.id)) score += 90;
  // Source-text discovery reached this file from the test case, so a symbol
  // living in it outranks an equally-named symbol found only by fuzzy search.
  if (context.discoveredPaths.has(norm(candidate.pathRel))) score += 12;
  return score;
}

/**
 * Workspace-symbol providers are fuzzy and can return unrelated production
 * symbols for every query. A candidate may become the SUT only when at least
 * one repository-backed bridge corroborates it: semantic identifier overlap,
 * deterministic source-text discovery, a verified proposal, or a trusted hint.
 */
function isCorroboratedCandidate(
  candidate: Candidate,
  params: UnitApproveResolveParams,
  context: ScoreContext
): boolean {
  const path = norm(candidate.pathRel);
  const name = norm(`${candidate.name} ${candidate.containerName || ""}`);
  if (context.deterministicIds.has(candidate.id)) return true;
  if (context.proposedSymbols.has(norm(candidate.name))) return true;
  if (context.proposedSymbols.has(norm(candidate.containerName || ""))) return true;
  if (
    context.proposedPaths.has(path) &&
    (context.proposedSymbols.has(norm(candidate.name)) ||
      context.proposedSymbols.has(norm(candidate.containerName || "")))
  ) {
    return true;
  }
  if (context.discoveredPaths.has(path)) return true;
  if (
    context.trustedHint?.pathRel &&
    path === norm(context.trustedHint.pathRel)
  ) {
    return true;
  }
  return signalTokens(params, 4).some(
    (token) => name.includes(token) || path.includes(token)
  );
}

function flattenSymbols(
  symbols: readonly RepoDocumentSymbol[],
  out: RepoDocumentSymbol[] = []
): RepoDocumentSymbol[] {
  for (const symbol of symbols) {
    out.push(symbol);
    flattenSymbols(symbol.children, out);
  }
  return out;
}

function kindOf(kind: string): GroundedSymbolKind {
  if (kind === "class" || kind === "interface" || kind === "function") return kind;
  if (kind === "property") return "property";
  return "method";
}

async function toGrounded(
  candidate: Candidate,
  runtime: RepositoryRuntime,
  maxFileBytes: number,
  documents: Map<string, RepoDocument>
): Promise<GroundedSymbol | null> {
  const pathRel = candidate.pathRel.replace(/\\/g, "/");
  const doc = await runtime.readDocument(pathRel, maxFileBytes);
  if (!doc?.text) return null;
  documents.set(pathRel.toLowerCase(), doc);
  const symbol = flattenSymbols(doc.symbols).find(
    (item) =>
      norm(item.name) === norm(candidate.name) &&
      item.selectionRange.start.line === candidate.range.start
  );
  const selection = symbol?.selectionRange || {
    start: {
      line: candidate.range.start,
      character: candidate.range.startCharacter || 0,
    },
    end: {
      line: candidate.range.end,
      character: candidate.range.endCharacter || 0,
    },
  };
  const full = symbol?.range || selection;
  const fileHash = sha256(doc.text);
  return {
    symbolId: candidate.id,
    pathRel,
    name: candidate.name,
    kind: kindOf(candidate.kind),
    containerName: candidate.containerName,
    signature: symbol?.detail,
    selectionRange: selection,
    fullRange: full,
    fileHash,
  };
}

export async function resolvePrimary(
  params: UnitApproveResolveParams,
  runtime: RepositoryRuntime,
  limits: { maxSymbolCandidates: number; maxImplementations: number; maxFileBytes: number },
  options?: { proposeSymbols?: SymbolProposer; remainingMs?: number }
): Promise<PrimaryResolution> {
  const candidates = new Map<string, Candidate>();
  const documents = new Map<string, RepoDocument>();
  const hintPath = params.manualSourceHint?.pathRel?.replace(/\\/g, "/");
  const hintSymbol = params.manualSourceHint?.symbol?.trim();
  let trustedHint: { pathRel?: string; symbol?: string } | null = null;
  let hintExact = false;

  // A marker is followed only when the repository confirms the symbol and the
  // marker relates to this test case. An unverified marker is dropped outright:
  // keeping it as a low-scoring candidate still let it win whenever the business
  // vocabulary scored nothing, which is exactly how a wrong marker survived.
  let hintIgnored: string | undefined;
  if (hintPath && TEST_PATH.test(hintPath)) {
    hintIgnored = `${hintPath} is a test path`;
  } else if (hintPath) {
    const hinted = await runtime.readDocument(hintPath, limits.maxFileBytes);
    const flat = hinted?.text ? flattenSymbols(hinted.symbols) : [];
    const exact = hintSymbol
      ? flat.filter((symbol) => norm(symbol.name) === norm(hintSymbol))
      : [];
    const seed = hintSymbol
      ? exact
      : // Method/Function/Constructor-ish symbols for a path-only marker.
        flat.filter((symbol) => [5, 11, 8].includes(symbol.kind)).slice(0, 8);
    const trusted =
      seed.length > 0 &&
      hintIsTrustworthy(hintPath, hintSymbol ? seed[0].name : "", params);

    if (!hinted?.text) {
      hintIgnored = `${hintPath} could not be read`;
    } else if (!seed.length) {
      hintIgnored = `${hintSymbol || "symbol"} is absent from ${hintPath}`;
    } else if (!trusted) {
      hintIgnored = `${hintPath} does not relate to this test case`;
    } else {
      documents.set(hintPath.toLowerCase(), hinted);
      for (const symbol of seed) {
        const candidate: Candidate = {
          id: `${hintPath}:${symbol.selectionRange.start.line}:${symbol.selectionRange.start.character}:${symbol.name}`,
          name: symbol.name,
          kind:
            symbol.kind === 4 || symbol.kind === 10
              ? "class"
              : symbol.kind === 11
                ? "interface"
                : symbol.kind === 12
                  ? "function"
                  : "method",
          pathRel: hintPath,
          containerName: undefined,
          range: {
            start: symbol.selectionRange.start.line,
            end: symbol.selectionRange.end.line,
            startCharacter: symbol.selectionRange.start.character,
            endCharacter: symbol.selectionRange.end.character,
          },
          score: 100,
        };
        candidates.set(candidate.id, candidate);
      }
      trustedHint = { pathRel: hintPath, symbol: hintSymbol ? seed[0].name : undefined };
      hintExact = Boolean(hintSymbol);
    }
  }

  let indexRetried = false;
  const proposedSymbols = new Map<string, number>();
  const proposedPaths = new Set<string>();
  const deterministicIds = new Set<string>();
  const discoveredPaths = new Set<string>();
  /** Query/list handlers harvested for the proposer shortlist only. */
  const structuralIds = new Set<string>();
  const context = (): ScoreContext => ({
    trustedHint,
    proposedSymbols,
    proposedPaths,
    deterministicIds,
    discoveredPaths,
  });
  const bestCorroboratedScore = () =>
    Math.max(
      0,
      ...[...candidates.values()]
        .filter((item) => isCorroboratedCandidate(item, params, context()))
        .map((item) => scoreCandidate(item, params, context()))
    );

  // A symbol provider that is still indexing answers every query with zero hits,
  // which is indistinguishable from "the symbol does not exist" unless counted.
  let searchCalls = 0;
  let searchHits = 0;

  async function sweep(
    queries: readonly string[],
    options?: { keepQuerying?: boolean }
  ): Promise<void> {
    for (const query of queries) {
      searchCalls++;
      const result = await runtime.searchSymbol(query, limits.maxSymbolCandidates);
      searchHits += result.hits.length;
      for (const hit of result.hits) {
        if (!["class", "interface", "method", "function"].includes(hit.kind)) continue;
        if (!hit.range) continue;
        // A Unit SUT is production code by definition; an existing test can only
        // ever be evidence, never the subject.
        if (TEST_PATH.test(hit.pathRel)) continue;
        const candidate: Candidate = {
          id: hit.id,
          name: hit.name,
          kind: hit.kind,
          pathRel: hit.pathRel,
          containerName: hit.containerName,
          range: hit.range,
          score: hit.score || 0,
        };
        const old = candidates.get(hit.id);
        if (
          !old ||
          scoreCandidate(candidate, params, context()) >
            scoreCandidate(old, params, context())
        ) {
          candidates.set(hit.id, candidate);
        }
      }
      // A crowded candidate pool must not silence the remaining queries when the
      // caller asked for named identifiers: dropping them turns "exists" into
      // "confirmed none" and leaves the case without a primary.
      if (!options?.keepQuerying && candidates.size >= limits.maxSymbolCandidates * 2) {
        break;
      }
      // Stop only on a strong corroborated candidate. A high raw fuzzy score is
      // not enough: it used to silence the remaining queries that would have
      // found the real handler.
      if (bestCorroboratedScore() >= STRONG_CANDIDATE_SCORE) break;
    }
  }

  let sourceDiscovery: SourceDiscoveryDiagnostics = {
    queries: [],
    hitPaths: [],
    candidateCount: 0,
  };
  if (!hintExact) {
    const discovered = await discoverPrimaryFromSourceText(params, runtime, limits);
    sourceDiscovery = {
      queries: discovered.queries,
      hitPaths: discovered.hitPaths,
      candidateCount: discovered.candidates.length,
    };
    for (const doc of discovered.documents) {
      documents.set(doc.pathRel.replace(/\\/g, "/").toLowerCase(), doc);
    }
    for (const hitPath of discovered.hitPaths) {
      if (!TEST_PATH.test(hitPath)) discoveredPaths.add(norm(hitPath));
    }
    for (const item of discovered.candidates) {
      deterministicIds.add(item.id);
      candidates.set(item.id, {
        ...item,
        score: Math.min(1, item.evidenceScore / 100),
      });
    }
  }

  // Harvest existing query/list handlers before asking the CLI to guess names.
  // Business terms never match English identifiers, so this sweep is what puts
  // real handlers in front of the proposer. Being a query handler is a shape,
  // not evidence about this test case, so a harvested candidate is offered as a
  // choice only and never scores or corroborates itself into the primary slot.
  if (!hintExact && impliesQueryList(params)) {
    await sweep(STRUCTURAL_QUERY_QUERIES, { keepQuerying: true });
    for (const candidate of candidates.values()) {
      if (looksLikeQueryHandler(candidate)) structuralIds.add(candidate.id);
    }
  }

  // Test cases speak the business language while identifiers are English, so a
  // term sweep can miss the subject entirely. Ask for identifier spellings, then
  // let the symbol index decide which of them exist. This runs before the fuzzy
  // term sweep so the proposed names are searched against an uncrowded pool.
  const diagnostics: ProposalDiagnostics = {
    attempted: false,
    proposedSymbols: [],
    proposedPaths: [],
    verifiedSymbols: [],
  };
  const remainingMs = options?.remainingMs ?? 0;
  // Leave room for field binding, which may also consult the CLI afterwards.
  const budget = Math.min(60_000, remainingMs - 30_000);
  if (!options?.proposeSymbols) {
    diagnostics.skipped = "not_configured";
  } else if (hintExact || bestCorroboratedScore() >= STRONG_CANDIDATE_SCORE) {
    diagnostics.skipped = "not_needed";
  } else if (budget < 4_000) {
    diagnostics.skipped = "no_budget";
  } else {
    diagnostics.attempted = true;
    const shortlist = [...candidates.values()]
      .filter(
        (item) =>
          isCorroboratedCandidate(item, params, context()) ||
          structuralIds.has(item.id)
      )
      .sort(
        (a, b) =>
          scoreCandidate(b, params, context()) - scoreCandidate(a, params, context())
      )
      .slice(0, 12)
      .map((item) => ({ name: item.name, pathRel: item.pathRel.replace(/\\/g, "/") }));
    const proposal = await options.proposeSymbols(
      symbolProposerInput(params, budget, shortlist)
    );
    diagnostics.proposedSymbols = proposal.symbols;
    diagnostics.proposedPaths = proposal.paths;
    diagnostics.error = proposal.error;
    diagnostics.engine = proposal.engine;
    diagnostics.memoHit = proposal.memoHit;
    const usableSymbols = proposal.symbols.filter(
      (symbol) => !isGenericEntryMethod(symbol)
    );
    await sweep(usableSymbols, { keepQuerying: true });
    // Zero hits across every query means the index was not ready, not that all
    // of these identifiers are absent; one bounded retry separates the two.
    if (searchCalls > 0 && searchHits === 0 && usableSymbols.length) {
      await new Promise((resolve) => setTimeout(resolve, 2_000));
      indexRetried = true;
      await sweep(usableSymbols, { keepQuerying: true });
    }
    const foundNames = new Set(
      [...candidates.values()].flatMap((item) =>
        [norm(item.name), item.containerName ? norm(item.containerName) : ""].filter(
          Boolean
        )
      )
    );
    const foundPaths = new Set(
      [...candidates.values()].map((item) => norm(item.pathRel))
    );
    diagnostics.verifiedSymbols = usableSymbols.filter((symbol) =>
      foundNames.has(norm(symbol))
    );
    // Unverified guesses must not corroborate anything. Bare Handle/Execute
    // names are dropped above because they match every handler in the repo.
    diagnostics.verifiedSymbols.forEach((symbol, rank) => {
      const key = norm(symbol);
      if (!proposedSymbols.has(key)) proposedSymbols.set(key, rank);
    });
    for (const path of proposal.paths) {
      if (!TEST_PATH.test(path) && foundPaths.has(norm(path))) {
        proposedPaths.add(norm(path));
      }
    }
  }

  // A verified path+symbol hint, a strong source-text match or a confirmed
  // proposal is authoritative enough to avoid broad fuzzy queries.
  if (!hintExact && bestCorroboratedScore() < STRONG_CANDIDATE_SCORE) {
    await sweep(queryTerms(params, trustedHint?.symbol));
  }

  const scored = [...candidates.values()]
    .filter((candidate) => isCorroboratedCandidate(candidate, params, context()))
    .map((candidate) => ({
      candidate,
      pathRel: candidate.pathRel,
      score: scoreCandidate(candidate, params, context()),
    }));
  const ranked = filterUnitLogicLayerCandidates(scored, {
    tcText: tcCorpus(params),
  })
    .sort((a, b) => b.score - a.score)
    .slice(0, limits.maxSymbolCandidates);
  const symbolIndex: SymbolIndexDiagnostics = {
    queries: searchCalls,
    hits: searchHits,
    retried: indexRetried,
  };
  if (!ranked.length) {
    return {
      primary: null,
      relatedPaths: [],
      documents,
      ambiguous: false,
      proposal: diagnostics,
      symbolIndex,
      sourceDiscovery,
      hintIgnored,
    };
  }

  const related = new Set<string>();
  for (const entry of ranked.slice(0, 3)) {
    const position = { symbolId: entry.candidate.id };
    const [definitions, implementations] = await Promise.all([
      runtime.definition(position),
      runtime.implementations({ ...position, maxResults: limits.maxImplementations }),
    ]);
    for (const location of definitions.locations) related.add(location.pathRel);
    for (const location of implementations.locations) related.add(location.pathRel);
  }

  const primary = await toGrounded(
    ranked[0].candidate,
    runtime,
    limits.maxFileBytes,
    documents
  );
  // Field binding needs the type that declares the fields, which sits behind the
  // primary's own type references rather than among its sibling implementations.
  const primaryDoc = primary
    ? documents.get(primary.pathRel.replace(/\\/g, "/").toLowerCase())
    : undefined;
  if (primaryDoc) {
    const known = new Set(
      [...related, primary?.pathRel || ""].map((path) =>
        path.replace(/\\/g, "/").toLowerCase()
      )
    );
    const expansion = await expandTypeReferences(primaryDoc, runtime, {
      maxPaths: 4,
      maxFileBytes: limits.maxFileBytes,
      known,
      deadlineAt: options?.remainingMs
        ? Date.now() + Math.max(0, options.remainingMs - 20_000)
        : undefined,
    });
    for (const path of expansion.paths) related.add(path);
    symbolIndex.queries += expansion.searches;
  }

  related.delete(primary?.pathRel || "");
  const ambiguous =
    ranked.length > 1 &&
    ranked[0].score === ranked[1].score &&
    ranked[0].candidate.pathRel !== ranked[1].candidate.pathRel;
  return {
    primary,
    relatedPaths: [...related],
    documents,
    ambiguous,
    proposal: diagnostics,
    symbolIndex,
    sourceDiscovery,
    hintIgnored,
  };
}
