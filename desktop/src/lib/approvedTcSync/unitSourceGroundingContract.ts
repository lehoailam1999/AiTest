/**
 * Layer 5 — Unit Source Grounding Contract.
 * Portable JSON emitted beside Approved TC MD after Approve writeBack.
 * Built from index.db snapshot (+ related / dependencyGraph); no product nouns.
 *
 * Gen/Agent reads this for File→Class→Method→Deps without re-ranking.
 */
import type { UnitApproveConfidence } from "@aitest/ide-protocol";
import { extractTcSourceMarkers } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { listDependencies } from "../codeIndex/lookup";
import { rankUnitRelatedPaths } from "../unitResolve/rankUnitRelatedPaths";
import { parseCodeMarker } from "./progressiveSeedFromCodeIndex";
import { approvedTcMarkdownRelPath } from "./approvedTcMarkdown";
import type { IndexFreshnessStatus } from "../unitResolve/checkIndexFileFreshness";
import { isE2eTestCaseType } from "../testEngine";

export const UNIT_GROUNDING_CONTRACT_SCHEMA = "aitest-unit-grounding-v1" as const;

export type UnitSourceGroundingPrimary = {
  pathRel: string;
  /** Type or Type.Method */
  code: string;
  typeName: string;
  methodName?: string;
  /** 1-based from index when known */
  line?: number;
  endLine?: number;
  contentHash?: string;
};

export type UnitSourceGroundingContract = {
  schema: typeof UNIT_GROUNDING_CONTRACT_SCHEMA;
  emittedAt: string;
  testCaseId?: string;
  primary: UnitSourceGroundingPrimary;
  related: Array<{ pathRel: string; contentHash?: string }>;
  /** Import / type deps from index dependencyGraph ∪ related */
  deps: string[];
  confidence?: UnitApproveConfidence;
  freshness?: IndexFreshnessStatus | "unknown";
  validateChecks?: string[];
  source?: string;
  score?: number;
  /** Only authoritative contracts may bypass Gen retrieval/ranking. */
  authoritative: boolean;
};

export type BuildUnitSourceGroundingContractInput = {
  pathRel: string;
  code: string;
  relatedPaths?: string[] | null;
  codeIndex?: CodeIndexSnapshot | null;
  confidence?: UnitApproveConfidence | null;
  freshness?: IndexFreshnessStatus | null;
  validateChecks?: string[] | null;
  source?: string | null;
  score?: number | null;
  testCaseId?: string | null;
  emittedAt?: string;
};

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

function uniqPaths(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const p = normPath(x);
    if (!p) continue;
    const k = p.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

function resolveFileKey(
  snap: CodeIndexSnapshot | null | undefined,
  pathRel: string
): string | null {
  if (!snap?.files) return null;
  const want = normPath(pathRel);
  if (snap.files[want]) return want;
  const low = want.toLowerCase();
  for (const k of Object.keys(snap.files)) {
    if (normPath(k).toLowerCase() === low) return k;
  }
  return null;
}

function pickSymbolRange(
  snap: CodeIndexSnapshot | null | undefined,
  pathKey: string,
  typeName: string,
  methodName?: string
): { line?: number; endLine?: number } {
  if (!snap) return {};
  const symbols = snap.symbolsByFile[pathKey] || [];
  const typeLow = typeName.toLowerCase();
  if (methodName) {
    const mLow = methodName.toLowerCase();
    const method = symbols.find(
      (s) =>
        s.kind === "method" &&
        s.name.toLowerCase() === mLow &&
        s.parent?.toLowerCase() === typeLow
    );
    if (method) return { line: method.line, endLine: method.endLine };
  }
  const typeSym = symbols.find(
    (s) => s.name.toLowerCase() === typeLow && s.kind !== "method"
  );
  if (typeSym) return { line: typeSym.line, endLine: typeSym.endLine };
  const any = symbols.find((s) => s.name.toLowerCase() === typeLow);
  if (any) return { line: any.line, endLine: any.endLine };
  return {};
}

/**
 * Build grounding contract from Approve markers + optional index snapshot.
 */
export function buildUnitSourceGroundingContract(
  input: BuildUnitSourceGroundingContractInput
): UnitSourceGroundingContract | null {
  const pathRel = normPath(input.pathRel);
  const code = String(input.code || "").trim();
  if (!pathRel || !code) return null;

  const { typeName, methodName } = parseCodeMarker(code);
  if (!typeName) return null;

  const snap = input.codeIndex || null;
  const pathKey = resolveFileKey(snap, pathRel) || pathRel;
  const range = pickSymbolRange(snap, pathKey, typeName, methodName);
  const fileRec = snap?.files[pathKey];
  const symbols = snap?.symbolsByFile[pathKey] || [];
  const typeCoLocated = symbols.some(
    (s) => s.kind !== "method" && s.kind !== "variable" && s.name.toLowerCase() === typeName.toLowerCase()
  );
  const methodCoLocated =
    !methodName ||
    symbols.some(
      (s) =>
        s.kind === "method" &&
        s.name.toLowerCase() === methodName.toLowerCase() &&
        s.parent?.toLowerCase() === typeName.toLowerCase()
    );

  const relatedRaw = rankUnitRelatedPaths(
    pathRel,
    (input.relatedPaths || []).map(normPath).filter(Boolean),
    { maxRelated: 4 }
  );
  const related = relatedRaw.map((p) => {
    const key = resolveFileKey(snap, p) || p;
    return {
      pathRel: p,
      contentHash: snap?.files[key]?.contentHash,
    };
  });

  const graphDeps = snap ? listDependencies(snap, pathKey) : [];
  const deps = rankUnitRelatedPaths(pathRel, uniqPaths([...graphDeps, ...relatedRaw]), {
    maxRelated: 8,
  }).filter((p) => p.toLowerCase() !== pathRel.toLowerCase());

  const confidence =
    input.confidence === "HIGH" ||
    input.confidence === "MEDIUM" ||
    input.confidence === "LOW"
      ? input.confidence
      : undefined;
  const checks = input.validateChecks?.length ? [...input.validateChecks] : [];
  const requiredChecks = ["indexFile", "moduleGate", "crudVerb", "symbolCoLocated"];
  const authoritative =
    Boolean(fileRec?.contentHash) &&
    typeCoLocated &&
    methodCoLocated &&
    (confidence === "HIGH" || confidence === "MEDIUM") &&
    input.freshness === "fresh" &&
    requiredChecks.every((check) => checks.includes(check));

  return {
    schema: UNIT_GROUNDING_CONTRACT_SCHEMA,
    emittedAt: input.emittedAt || new Date().toISOString(),
    testCaseId: input.testCaseId?.trim() || undefined,
    primary: {
      pathRel,
      code,
      typeName,
      methodName,
      line: range.line,
      endLine: range.endLine,
      contentHash: fileRec?.contentHash,
    },
    related,
    deps,
    confidence,
    freshness: input.freshness || "unknown",
    validateChecks: checks.length ? checks : undefined,
    source: input.source?.trim() || undefined,
    score:
      typeof input.score === "number" && Number.isFinite(input.score)
        ? input.score
        : undefined,
    authoritative,
  };
}

/** Companion path next to Approved TC MD. */
export function unitGroundingContractRelPath(mdRelPath: string): string {
  const p = normPath(mdRelPath);
  if (/\.md$/i.test(p)) return p.replace(/\.md$/i, ".grounding.json");
  return `${p}.grounding.json`;
}

/** Parse confidence=HIGH|MEDIUM|LOW from auto-enrich comment line. */
export function parseConfidenceFromTestData(
  testData: string | null | undefined
): UnitApproveConfidence | null {
  const m = String(testData || "").match(
    /\bconfidence=(HIGH|MEDIUM|LOW)\b/i
  );
  if (!m) return null;
  return m[1]!.toUpperCase() as UnitApproveConfidence;
}

export function serializeUnitSourceGroundingContract(
  contract: UnitSourceGroundingContract
): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

/**
 * Companion `.grounding.json` files for Approved Unit TCs that have path:/code:.
 */
export function buildUnitGroundingContractFiles(
  cases: Array<
    Pick<
      TestCase,
      "testCaseId" | "id" | "type" | "module" | "testData" | "reviewStatus"
    >
  >,
  opts?: {
    codeIndex?: CodeIndexSnapshot | null;
  }
): Array<{ path: string; content: string; testCaseId: string }> {
  const out: Array<{ path: string; content: string; testCaseId: string }> = [];
  for (const tc of cases) {
    if (String(tc.reviewStatus || "").toLowerCase() !== "approved") continue;
    if (isE2eTestCaseType(tc.type)) continue;
    const markers = extractTcSourceMarkers(tc.testData || "");
    const pathRel = markers.paths[0];
    const code = markers.codes[0];
    if (!pathRel || !code) continue;
    let mdRel: string;
    try {
      mdRel = approvedTcMarkdownRelPath(tc as TestCase);
    } catch {
      continue;
    }
    const contract = buildUnitSourceGroundingContract({
      pathRel,
      code,
      relatedPaths: markers.related,
      codeIndex: opts?.codeIndex,
      confidence: parseConfidenceFromTestData(tc.testData),
      freshness: parseFreshnessFromTestData(tc.testData),
      validateChecks: parseValidateChecksFromTestData(tc.testData),
      testCaseId: tc.testCaseId,
      source: /index\.db/i.test(tc.testData || "") ? "index.db" : undefined,
      score: parseScoreFromTestData(tc.testData),
    });
    if (!contract) continue;
    out.push({
      path: unitGroundingContractRelPath(mdRel),
      content: serializeUnitSourceGroundingContract(contract),
      testCaseId: tc.testCaseId,
    });
  }
  return out;
}

function parseFreshnessFromTestData(
  testData: string | null | undefined
): IndexFreshnessStatus | undefined {
  const m = String(testData || "").match(
    /\bfreshness=(fresh|stale|missing_file|skipped)\b/i
  );
  return m?.[1]?.toLowerCase() as IndexFreshnessStatus | undefined;
}

function parseValidateChecksFromTestData(
  testData: string | null | undefined
): string[] {
  const m = String(testData || "").match(/\bchecks=([A-Za-z0-9_+-]+)/);
  return m?.[1] ? m[1].split("+").filter(Boolean) : [];
}

function parseScoreFromTestData(testData: string | null | undefined): number | undefined {
  const m = String(testData || "").match(/\bscore=(\d+(?:\.\d+)?)\b/i);
  if (!m) return undefined;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : undefined;
}
