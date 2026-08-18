import type { UnitApproveResolveParams } from "@aitest/ide-protocol";
import { lastJsonObject } from "./parseAgentJson";

export type SymbolProposal = {
  /** Candidate identifiers as they would be written in the source language. */
  readonly symbols: readonly string[];
  /** Candidate repository-relative paths. */
  readonly paths: readonly string[];
  /** Why no usable proposal came back, so a silent failure stays visible. */
  readonly error?: string;
  /** Which executable produced the proposal, for diagnosing a missing CLI. */
  readonly engine?: string;
  /** Answer reused from an earlier TC in this batch instead of a new CLI call. */
  readonly memoHit?: boolean;
};

export type ExistingSymbolCandidate = {
  readonly name: string;
  readonly pathRel: string;
};

export type SymbolProposerInput = {
  readonly title: string;
  readonly module: string;
  readonly requirement: string;
  readonly expected: string;
  /** Classified intent of the TC — stable across sibling TCs, unlike the title. */
  readonly primaryBucket: string;
  readonly scenario: string;
  readonly expectedType: string;
  readonly steps: readonly string[];
  readonly fields: readonly string[];
  readonly inputKeys: readonly string[];
  readonly existingCandidates: readonly ExistingSymbolCandidate[];
  readonly timeoutMs: number;
};

/**
 * Bridges business vocabulary to source identifiers. Test cases are written in
 * the domain language (often not English) while code identifiers are English, so
 * a symbol-index query built from test-case words matches only by accident. The
 * proposer suggests identifier spellings; the repository still decides what
 * exists.
 */
export type SymbolProposer = (
  input: SymbolProposerInput
) => Promise<SymbolProposal>;

export function symbolProposerInput(
  params: UnitApproveResolveParams,
  timeoutMs: number,
  existingCandidates: readonly ExistingSymbolCandidate[] = []
): SymbolProposerInput {
  const target = params.tcIr.testData.target;
  return {
    title: params.tcIr.title,
    module: params.tcIr.module || "",
    requirement:
      params.tcIr.requirement.title || params.tcIr.requirement.behaviorId || "",
    expected: params.tcIr.expected.description,
    primaryBucket: params.tcIr.primaryBucket,
    scenario: params.tcIr.scenario,
    expectedType: params.tcIr.expected.type,
    steps: [
      ...(params.tcIr.steps.prepare || []),
      ...(params.tcIr.steps.execute || []),
    ].slice(0, 8),
    fields: target?.fields || [],
    inputKeys: Object.keys(params.tcIr.testData.input || {}),
    existingCandidates,
    timeoutMs,
  };
}

const MAX_PROPOSALS = 8;

function cleanSymbols(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = values.flatMap((value) => {
    if (typeof value !== "string") return [];
    // Accept "Type.Method" or "Method()" spellings but keep bare identifiers.
    const identifier = value.split(".").pop()?.replace(/\(.*$/, "").trim() || "";
    return /^[A-Za-z_][A-Za-z0-9_]*$/.test(identifier) ? [identifier] : [];
  });
  return [...new Set(out)].slice(0, MAX_PROPOSALS);
}

function cleanPaths(values: unknown): string[] {
  if (!Array.isArray(values)) return [];
  const out = values.flatMap((value) => {
    if (typeof value !== "string") return [];
    const path = value.replace(/\\/g, "/").replace(/^\.?\//, "").trim();
    // Reject absolute paths and traversal: proposals stay inside the workspace.
    return path && !path.includes("..") && !/^[a-z]:/i.test(path) ? [path] : [];
  });
  return [...new Set(out)].slice(0, MAX_PROPOSALS);
}

export function parseSymbolProposal(raw: string): SymbolProposal {
  const value = lastJsonObject(raw);
  if (!value) return { symbols: [], paths: [] };
  return {
    symbols: cleanSymbols(value.symbols),
    paths: cleanPaths(value.paths),
  };
}

export function buildCursorSymbolPrompt(input: SymbolProposerInput): string {
  const shortlist = input.existingCandidates
    .slice(0, 12)
    .map((item) => `- ${item.name} @ ${item.pathRel}`)
    .join("\n");
  return [
    "You translate a business test case into the identifier names a developer",
    "would have used in this repository's source code.",
    "Name the production type/method that implements the behaviour under test.",
    "Never name a test, spec, fixture or mock. Never invent a framework symbol.",
    "Prefer command/query handlers, services, validators and request DTOs.",
    "Bridge non-English business vocabulary to English source terminology.",
    shortlist
      ? // The shortlist already comes from the IDE symbol index, so asking for a
        // repository search on top of it only spends the call's whole timeout on
        // work the index has done. Answer from the list instead.
        [
          "Do not search or read repository files. The candidates below already",
          "come from the IDE symbol index and are the only verified names you",
          "have; answer from them and from the test-case wording alone.",
          "Select only from these repository-backed candidates when any of them",
          "implements the behaviour. Do not invent a sibling name that is absent",
          "from this list:",
          shortlist,
        ].join("\n")
      : [
          "No shortlist is available, so use one bounded repository search and",
          "return only identifiers and paths you verified actually exist here.",
        ].join("\n"),
    "Do not propose bare entry methods such as Handle or Execute by themselves.",
    "Return JSON only:",
    '{"symbols":["CreateSomethingHandler"],"paths":["src/App/Commands/CreateSomething.cs"]}',
    "Include both word orders for the same concept, because repositories differ:",
    "e.g. CreateEvidenceCommandHandler and EvidenceCreateCommandHandler.",
    "Give at most 8 symbols and 8 paths, ordered most likely first.",
    "",
    `TITLE: ${input.title}`,
    `REQUIREMENT: ${input.requirement}`,
    `MODULE: ${input.module}`,
    `EXPECTED: ${input.expected}`,
    `STEPS: ${JSON.stringify(input.steps)}`,
    `TARGET_FIELDS: ${JSON.stringify(input.fields)}`,
    `INPUT_KEYS: ${JSON.stringify(input.inputKeys)}`,
  ].join("\n");
}
