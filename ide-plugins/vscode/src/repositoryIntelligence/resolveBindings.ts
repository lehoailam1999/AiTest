import type {
  FieldBindingDecision,
  GroundedSymbol,
  UnitApproveResolveParams,
} from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import type {
  RepoDocument,
  RepoDocumentSymbol,
  RepositoryRuntime,
} from "./runtime";

type PropertyCandidate = {
  property: string;
  ownerType: string;
  ownerRange: RepoDocumentSymbol["range"];
  propertyRange: RepoDocumentSymbol["range"];
  pathRel: string;
  fileHash: ReturnType<typeof sha256>;
  displayNames: string[];
};

export type FieldBindingPickCandidate = {
  property: string;
  ownerType: string;
  ownerPath: string;
  displayNames: readonly string[];
};

export type FieldBindingPick = {
  label: string;
  property: string;
  ownerPath: string;
};

export type FieldBindingPickResult = {
  readonly picks: readonly FieldBindingPick[];
  /**
   * Labels the picker states no candidate can hold. Separating this from "no
   * answer" is what lets Approve call a real gap a gap instead of a failure.
   */
  readonly missing?: readonly string[];
  readonly error?: string;
  readonly engine?: string;
  /** Picks reused from an earlier TC in this batch instead of a new CLI call. */
  readonly memoHit?: boolean;
};

export type FieldBindingPicker = (input: {
  labels: readonly string[];
  inputKeys: readonly string[];
  testCaseTitle: string;
  module: string;
  expected: string;
  constraint?: string;
  candidates: readonly FieldBindingPickCandidate[];
  /** Remaining approve deadline budget (ms). */
  timeoutMs?: number;
}) => Promise<FieldBindingPickResult>;

/** Everything needed to explain a binding outcome without reading IDE logs. */
export type FieldBindingDiagnostics = {
  labels: readonly string[];
  candidateCount: number;
  /** Labels bound from exact source metadata, before any AI involvement. */
  deterministic: readonly string[];
  pickerAttempted: boolean;
  pickerSkipped?: "not_needed" | "not_configured" | "no_budget" | "no_candidates";
  pickerError?: string;
  engine?: string;
  /** Every unresolved label was answered from an earlier TC of this batch. */
  pickerMemoHit?: boolean;
  accepted: readonly string[];
  /** Picks refused because the property/path was not in the shortlist. */
  rejected: readonly string[];
  /** Labels the picker reported as absent from the source. */
  declaredMissing: readonly string[];
  unresolved: readonly string[];
};

export type BindingResolution = {
  bindings: FieldBindingDecision[];
  diagnostics: FieldBindingDiagnostics;
};

function norm(value: string): string {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function pascalCase(value: string): string {
  return value
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join("");
}

function displayNamesFor(doc: RepoDocument, symbol: RepoDocumentSymbol): string[] {
  const lines = doc.text.split(/\r?\n/);
  const start = Math.max(0, symbol.range.start.line - 5);
  const prefix = lines.slice(start, symbol.range.start.line + 1).join("\n");
  const names: string[] = [];
  const patterns = [
    /Display\s*\(\s*Name\s*=\s*"([^"]+)"/gi,
    /DisplayName\s*\(\s*"([^"]+)"/gi,
    /(?:JsonPropertyName|JsonProperty)\s*\(\s*"([^"]+)"/gi,
  ];
  for (const pattern of patterns) {
    for (const match of prefix.matchAll(pattern)) names.push(match[1]);
  }
  return names;
}

function collectProperties(
  doc: RepoDocument,
  symbols: readonly RepoDocumentSymbol[],
  owner?: RepoDocumentSymbol
): PropertyCandidate[] {
  const out: PropertyCandidate[] = [];
  for (const symbol of symbols) {
    const isOwner = [4, 10, 22, 23].includes(symbol.kind);
    const nextOwner = isOwner ? symbol : owner;
    if ([6, 7].includes(symbol.kind) && nextOwner) {
      out.push({
        property: symbol.name,
        ownerType: nextOwner.name,
        ownerRange: nextOwner.range,
        propertyRange: symbol.range,
        pathRel: doc.pathRel.replace(/\\/g, "/"),
        fileHash: sha256(doc.text),
        displayNames: displayNamesFor(doc, symbol),
      });
    }
    out.push(...collectProperties(doc, symbol.children, nextOwner));
  }
  return out;
}

function pathAffinity(pathRel: string, primary: GroundedSymbol): number {
  const path = pathRel.toLowerCase().replace(/\\/g, "/");
  const family = norm(primary.containerName || primary.name).replace(
    /(service|handler|controller|command|query)$/,
    ""
  );
  let score = 0;
  if (family && norm(path).includes(family)) score += 20;
  // Field-carrying types must outrank sibling handlers when the related set is
  // capped; otherwise the DTO discovered through type references is silently
  // truncated before property extraction.
  if (/(dto|model|contract|request|input)/i.test(path)) score += 40;
  if (path.includes(primary.pathRel.replace(/\\/g, "/").split("/").slice(0, -1).join("/").toLowerCase())) {
    score += 8;
  }
  if (/(\b|\/)(test|tests|specs?)(\b|\/)/i.test(path)) score -= 30;
  return score;
}

async function loadShortlist(
  params: UnitApproveResolveParams,
  primary: GroundedSymbol,
  relatedPaths: readonly string[],
  runtime: RepositoryRuntime,
  maxRelatedFiles: number,
  maxFileBytes: number,
  documents: Map<string, RepoDocument>
): Promise<RepoDocument[]> {
  const paths = new Set<string>([primary.pathRel, ...relatedPaths]);
  const labels = params.tcIr.testData.target?.fields || [];
  const inputKeys = Object.keys(params.tcIr.testData.input || {});
  for (const query of [...labels, ...inputKeys].slice(0, 6)) {
    const result = await runtime.searchSymbol(query, 8);
    for (const hit of result.hits) paths.add(hit.pathRel);
  }
  const sourceFiles = await runtime.findSourceFiles(Math.max(30, maxRelatedFiles * 5));
  for (const path of [...sourceFiles].sort(
    (a, b) => pathAffinity(b, primary) - pathAffinity(a, primary)
  )) {
    if (paths.size >= maxRelatedFiles + 1) break;
    if (pathAffinity(path, primary) > 0) paths.add(path);
  }

  const docs: RepoDocument[] = [];
  const rankedPaths = [...paths].sort(
    (a, b) => pathAffinity(b, primary) - pathAffinity(a, primary)
  );
  for (const path of rankedPaths.slice(0, maxRelatedFiles + 1)) {
    const key = path.replace(/\\/g, "/").toLowerCase();
    const doc = documents.get(key) || (await runtime.readDocument(path, maxFileBytes));
    if (!doc) continue;
    documents.set(key, doc);
    docs.push(doc);
  }
  return docs;
}

function uniqueExact(
  properties: readonly PropertyCandidate[],
  propertyName: string
): PropertyCandidate | null {
  const matches = properties.filter(
    (candidate) => norm(candidate.property) === norm(propertyName)
  );
  return matches.length === 1 ? matches[0] : null;
}

function chooseProperty(
  label: string,
  properties: readonly PropertyCandidate[],
  inputKeys: readonly string[],
  manualProperty: string | undefined
): { candidate: PropertyCandidate; source: FieldBindingDecision["source"]; confidence: "HIGH" } | null {
  const labelNorm = norm(label);

  if (manualProperty) {
    const candidate = uniqueExact(properties, manualProperty);
    if (candidate) return { candidate, source: "approved_alias", confidence: "HIGH" };
  }
  const direct = uniqueExact(properties, label);
  if (direct) return { candidate: direct, source: "exact_symbol", confidence: "HIGH" };
  const displayMatches = properties.filter((candidate) =>
    candidate.displayNames.some((name) => norm(name) === labelNorm)
  );
  if (displayMatches.length === 1) {
    return { candidate: displayMatches[0], source: "display_attribute", confidence: "HIGH" };
  }
  for (const key of inputKeys) {
    if (norm(key) !== labelNorm) continue;
    const candidate = uniqueExact(properties, pascalCase(key));
    if (candidate) return { candidate, source: "input_key", confidence: "HIGH" };
  }
  return null;
}

function uniquePickCandidates(
  properties: readonly PropertyCandidate[]
): FieldBindingPickCandidate[] {
  const seen = new Set<string>();
  const result: FieldBindingPickCandidate[] = [];
  for (const candidate of properties) {
    const key = `${candidate.pathRel.toLowerCase()}:${candidate.property.toLowerCase()}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push({
      property: candidate.property,
      ownerType: candidate.ownerType,
      ownerPath: candidate.pathRel,
      displayNames: candidate.displayNames,
    });
  }
  return result;
}

function validateAiPick(
  pick: FieldBindingPick,
  label: string,
  properties: readonly PropertyCandidate[]
): PropertyCandidate | null {
  if (norm(pick.label) !== norm(label)) return null;
  const ownerPath = pick.ownerPath.replace(/\\/g, "/").toLowerCase();
  const matches = properties.filter(
    (candidate) =>
      norm(candidate.property) === norm(pick.property) &&
      candidate.pathRel.toLowerCase() === ownerPath
  );
  // Never accept an invented or ambiguous property from AI.
  return matches.length === 1 ? matches[0] : null;
}

export async function resolveBindings(
  params: UnitApproveResolveParams,
  primary: GroundedSymbol,
  relatedPaths: readonly string[],
  runtime: RepositoryRuntime,
  limits: { maxRelatedFiles: number; maxFileBytes: number },
  documents: Map<string, RepoDocument>,
  pickFields?: FieldBindingPicker,
  remainingMs?: number
): Promise<BindingResolution> {
  const requiredLabels = params.tcIr.testData.target?.fields || [];
  const inputKeys = Object.keys(params.tcIr.testData.input || {});
  // Input-only aliases are useful for canonical payload generation, but only
  // target fields are readiness requirements and may invoke the AI fallback.
  const labels = [...new Set([...requiredLabels, ...inputKeys])];
  const emptyDiagnostics = (
    overrides?: Partial<FieldBindingDiagnostics>
  ): FieldBindingDiagnostics => ({
    labels,
    candidateCount: 0,
    deterministic: [],
    pickerAttempted: false,
    accepted: [],
    rejected: [],
    declaredMissing: [],
    unresolved: [],
    ...overrides,
  });
  if (!labels.length) {
    return {
      bindings: [],
      diagnostics: emptyDiagnostics({ pickerSkipped: "not_needed" }),
    };
  }
  const docs = await loadShortlist(
    params,
    primary,
    relatedPaths,
    runtime,
    limits.maxRelatedFiles,
    limits.maxFileBytes,
    documents
  );
  const properties = docs
    .flatMap((doc) => collectProperties(doc, doc.symbols))
    .sort(
      (a, b) =>
        pathAffinity(b.pathRel, primary) - pathAffinity(a.pathRel, primary)
    );
  const manual = new Map(
    (params.manualSourceHint?.propertyBindings || []).map((item) => [
      norm(item.label),
      item.property,
    ])
  );

  const bindings: FieldBindingDecision[] = [];
  const unresolved: string[] = [];
  const deterministic: string[] = [];
  for (const label of labels) {
    const selected = chooseProperty(label, properties, inputKeys, manual.get(norm(label)));
    if (!selected) {
      if (requiredLabels.some((required) => norm(required) === norm(label))) {
        unresolved.push(label);
      }
      continue;
    }
    deterministic.push(label);
    const { candidate } = selected;
    bindings.push({
      label,
      property: candidate.property,
      owner: {
        pathRel: candidate.pathRel,
        typeName: candidate.ownerType,
        range: candidate.ownerRange,
        fileHash: candidate.fileHash,
      },
      source: selected.source,
      confidence: selected.confidence,
    });
  }

  const pickCandidates = uniquePickCandidates(properties);
  const diagnostics: FieldBindingDiagnostics = emptyDiagnostics({
    candidateCount: pickCandidates.length,
    deterministic,
    unresolved,
  });

  if (!unresolved.length) {
    return { bindings, diagnostics: { ...diagnostics, pickerSkipped: "not_needed" } };
  }
  if (!pickFields) {
    return { bindings, diagnostics: { ...diagnostics, pickerSkipped: "not_configured" } };
  }
  if (!pickCandidates.length) {
    return { bindings, diagnostics: { ...diagnostics, pickerSkipped: "no_candidates" } };
  }
  const budget = typeof remainingMs === "number" ? remainingMs : 25_000;
  if (budget < 4_000) {
    // Fail closed on unresolved labels — do not start AI with no time left.
    return { bindings, diagnostics: { ...diagnostics, pickerSkipped: "no_budget" } };
  }

  const result = await pickFields({
    labels: unresolved,
    inputKeys,
    testCaseTitle: params.tcIr.title,
    module: params.tcIr.module || "",
    expected: params.tcIr.expected.description,
    constraint: params.tcIr.testData.target?.constraint,
    candidates: pickCandidates,
    timeoutMs: Math.min(60_000, Math.max(4_000, budget - 1_000)),
  });
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const label of unresolved) {
    const pick = result.picks.find((item) => norm(item.label) === norm(label));
    if (!pick) continue;
    const candidate = validateAiPick(pick, label, properties);
    if (!candidate) {
      rejected.push(`${label} → ${pick.property} @ ${pick.ownerPath}`);
      continue;
    }
    accepted.push(label);
    bindings.push({
      label,
      property: candidate.property,
      owner: {
        pathRel: candidate.pathRel,
        typeName: candidate.ownerType,
        range: candidate.ownerRange,
        fileHash: candidate.fileHash,
      },
      source: "bounded_shortlist_pick",
      confidence: "MEDIUM",
    });
  }
  const declaredMissing = unresolved.filter((label) =>
    (result.missing || []).some((item) => norm(item) === norm(label))
  );
  return {
    bindings,
    diagnostics: {
      ...diagnostics,
      pickerAttempted: true,
      pickerError: result.error,
      engine: result.engine,
      pickerMemoHit: result.memoHit,
      accepted,
      rejected,
      declaredMissing,
      unresolved: unresolved.filter((label) => !accepted.includes(label)),
    },
  };
}
