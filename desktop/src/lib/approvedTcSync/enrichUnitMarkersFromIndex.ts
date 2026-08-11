/**
 * Auto-fill path:/code: into Approved TC Test Data.
 * Prefer unified pipeline: Query → retrieveUnitSources → rank → body-rule → markers.
 * Fallback: ProjectFileIndex progressive seed when index.db missing.
 */
import {
  applyBodyRuleToCandidate,
  applyProjectIntentRules,
  applyProfileDomainGuards,
  clipBodyExcerpt,
  collapseBodyRuleContenders,
  decideBodyRuleWriteBack,
  expandUnitRelatedPaths,
  extractTcSourceMarkers,
  extractUnitIntent,
  filterUnitLogicLayerCandidates,
  formatBodyRuleLog,
  formatRelatedMarkerLines,
  hasStrongWriteBackSignal,
  isAnemicEntityLikePath,
  matchingProjectAliasTokens,
  orderCandidatesForBodyRuleOpen,
  preferDtoValidatorForHints,
  applyLayerHintPrimaryPromotion,
  parseUnitLayerHint,
  resolveSutMapPin,
  softCrossCuttingDenied,
  tcImpliesBehaviorPrimary,
  UNIT_BODY_RULE,
  type BodyRuleScoredCandidate,
  type UnitIntent,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { isTauri, listSourceFiles, readTextFile } from "../../tauri/bridge";
import { loadIndexSnapshot } from "../codeIndex/indexStore";
import { createTauriCodeIndexIo } from "../codeIndex/tauriIo";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { buildProjectIndexCached } from "../projectIntelligence/projectIndex";
import {
  extractMatchTokens,
  resolveSeedCandidates,
  type SeedResolveOptions,
} from "../projectIntelligence/tcSeedResolver";
import type { ProjectFileIndex, SeedCandidate } from "../projectIntelligence/types";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";
import { isUnsuitableUnitPrimary } from "../retrieval/rankScore";
import { sourceExtensionsForLanguage } from "../stackHints";
import {
  buildUnitApproveQuery,
  llmPickUnitPrimary,
  LLM_PICK_RETRY_TIMEOUT_MS,
  resolveUnitPrimaryFromIndex,
  snapshotFromPaths,
  type PickFromShortlistFn,
} from "../unitResolve";
import { isUnitTestCaseType } from "../testEngine";
import {
  preferredSymbolFromCodeIndex,
  resolveSeedsFromCodeIndex,
} from "./progressiveSeedFromCodeIndex";
import {
  filterCandidatesByDomainGuards,
  loadUnitEnrichProfileKnobs,
  type UnitEnrichProfileKnobs,
} from "./loadUnitEnrichProfile";

/** Fail-closed: only write markers when top seed is clearly ahead + intent-aligned. */
export const UNIT_AUTO_MARKER = {
  minScore: 56,
  minMargin: 20,
  minRatio: 1.45,
  /**
   * Soft Approve path when TC does NOT require body-rule (e.g. plain «tải lên» /
   * «từ chối» without size/BR). Strict margin was skipping almost all bulk Approves.
   */
  softMinMargin: 8,
  softMinRatio: 1.15,
} as const;

function uniqTokens(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const t = String(x || "").trim();
    if (!t) continue;
    const k = t.toLowerCase();
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
  }
  return out;
}

const AUTO_ENRICHED_RE = /#\s*auto-enriched\b/i;

/** No product-/feature-specific intent maps — fail-closed on weak seeds only. */

export type UnitMarkerEnrichResult = {
  testData: string;
  enriched: boolean;
  pathRel?: string;
  code?: string;
  score?: number;
  reason?: string;
  source?: "index.db" | "path-index";
  /** Why enrich did not write markers (for MD Grounding) */
  skipReason?: string;
  ruleHits?: string[];
  relatedPaths?: string[];
  candidatesTop3?: Array<{
    pathRel: string;
    score: number;
    baseScore?: number;
    ruleHits: string[];
  }>;
  writeBack?: boolean;
  /** Compact body-rule log line */
  bodyRuleLog?: string;
};

export type ReadSourceExcerpt = (pathRel: string) => Promise<string | null>;

/** Repo-relative only — strip drive / projectRoot prefixes. */
export function toRepoRelativePath(
  pathLike: string,
  projectRoot?: string | null
): string {
  let p = (pathLike || "").replace(/\\/g, "/").trim();
  if (!p) return "";
  if (projectRoot) {
    const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
    const low = p.toLowerCase();
    const rootLow = root.toLowerCase();
    if (low.startsWith(rootLow + "/")) p = p.slice(root.length + 1);
    else if (low === rootLow) return "";
  }
  p = p.replace(/^[A-Za-z]:\//, "");
  p = p.replace(/^\/+/, "");
  if (/^[A-Za-z]:/.test(p)) p = p.replace(/^[A-Za-z]:/, "").replace(/^\/+/, "");
  return p;
}

/**
 * Symbol for code: — PascalCase type from file stem.
 * resumable-upload.service.ts → ResumableUploadService
 */
export function symbolCodeFromPathRel(pathRel: string): string {
  const base = pathRel.replace(/\\/g, "/").split("/").pop() || pathRel;
  let stem = base.replace(/\.[^.]+$/, "");
  stem = stem.replace(/\.(service|component|pipe|directive|guard|interceptor)$/i, "");
  if (/[A-Z]/.test(stem) && !stem.includes("-") && !stem.includes("_")) {
    return stem;
  }
  const parts = stem.split(/[-_.]+/).filter(Boolean);
  const pascal = parts
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase())
    .join("");
  if (/\.service\./i.test(base) && !/service$/i.test(pascal)) {
    return `${pascal}Service`;
  }
  return pascal || stem;
}

export function hasManualUnitSourceMarkers(
  testData: string | null | undefined
): boolean {
  const td = testData || "";
  const markers = extractTcSourceMarkers(td);
  if (!markers.paths.length && !markers.codes.length) return false;
  if (AUTO_ENRICHED_RE.test(td)) return false;
  return true;
}

/** Approved Unit TC has both path: and code: (manual or auto-enriched). */
export function hasUnitPathCodeMarkers(
  testData: string | null | undefined
): boolean {
  const markers = extractTcSourceMarkers(testData || "");
  return markers.paths.length > 0 && markers.codes.length > 0;
}

function shouldEnrichUnitTc(tc: TestCase): boolean {
  if (String(tc.reviewStatus || "").toLowerCase() !== "approved") return false;
  if (!isUnitTestCaseType(tc.type)) return false;
  if (hasManualUnitSourceMarkers(tc.testData)) return false;
  return true;
}

/** Strip previous auto-enriched path:/code: block; keep human/trace lines. */
export function stripAutoEnrichedMarkers(testData: string): string {
  if (!AUTO_ENRICHED_RE.test(testData || "")) return (testData || "").trim();
  return (testData || "")
    .split(/\r?\n/)
    .filter((line) => {
      if (/^\s*#\s*auto-enriched\b/i.test(line)) return false;
      if (/^\s*(?:path|file|source)\s*[:=]/i.test(line)) return false;
      if (/^\s*(?:code|class|symbol|type|sut)\s*[:=]/i.test(line)) return false;
      if (/^\s*related\s*[:=]/i.test(line)) return false;
      return true;
    })
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const SUT_SKIP_RE = /^\s*#\s*sut-resolve:\s*skipped\b/im;

/** Append / replace skip note so MD explains missing path:/code:. */
export function withSutResolveSkipNote(
  testData: string | null | undefined,
  reason: string
): string {
  const note = `# sut-resolve: skipped — ${reason}`;
  const base = (testData || "")
    .split(/\r?\n/)
    .filter((line) => !SUT_SKIP_RE.test(line) && !/^\s*#\s*auto-enriched\b/i.test(line))
    .join("\n")
    .trim();
  return base ? `${base}\n${note}` : note;
}

function explainEnrichSkip(
  _tc: TestCase,
  opts?: { hadIndex?: boolean; detail?: string }
): string {
  if (opts?.detail) return opts.detail;
  if (!opts?.hadIndex) {
    return "no index.db / path-index files available under project root";
  }
  return "no confident Module→Function→Title match from index (fail-closed)";
}

function collectSeedCandidates(
  tc: TestCase,
  index: ProjectFileIndex,
  opts?: SeedResolveOptions & { codeIndex?: CodeIndexSnapshot | null }
): { candidates: SeedCandidate[]; source: "index.db" | "path-index" } {
  if (opts?.codeIndex && Object.keys(opts.codeIndex.files || {}).length) {
    const dbCands = resolveSeedsFromCodeIndex(tc, opts.codeIndex, {
      requirementTitle: opts.requirementTitle,
      projectAliases: opts.projectAliases,
      limit: opts.limit ?? 8,
    });
    if (dbCands.length) {
      return { candidates: dbCands, source: "index.db" };
    }
  }
  return {
    candidates: resolveSeedCandidates(tc, index, {
      ...opts,
      limit: opts?.limit ?? 8,
    }),
    source: "path-index",
  };
}

async function rescoreWithBodyRules(
  candidates: SeedCandidate[],
  intent: UnitIntent,
  readExcerpt: ReadSourceExcerpt,
  tcText?: string | null,
  preferTokens?: string[] | null
): Promise<BodyRuleScoredCandidate[]> {
  const usable = filterUnitLogicLayerCandidates(
    candidates.filter((c) => !isUnsuitableUnitPrimary(c.pathRel)),
    { tcText: tcText || intent.classes.join(" ") }
  );
  // Prefer Handler/Service over Query when opening excerpts (validate_reject).
  const top = orderCandidatesForBodyRuleOpen(
    usable,
    intent,
    UNIT_BODY_RULE.topN
  );

  const out: BodyRuleScoredCandidate[] = await Promise.all(
    top.map(async (c) => {
      let excerpt = "";
      try {
        excerpt = clipBodyExcerpt(await readExcerpt(c.pathRel));
      } catch {
        excerpt = "";
      }
      return applyBodyRuleToCandidate(c, excerpt, intent, tcText, {
        preferTokens,
      });
    })
  );
  out.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
  return out;
}

export function pickConfidentUnitSeed(
  candidates: SeedCandidate[],
  tc?: TestCase,
  opts?: { minScore?: number; minMargin?: number; minRatio?: number }
): SeedCandidate | null {
  const minScore = opts?.minScore ?? UNIT_AUTO_MARKER.minScore;
  const minMargin = opts?.minMargin ?? UNIT_AUTO_MARKER.minMargin;
  const minRatio = opts?.minRatio ?? UNIT_AUTO_MARKER.minRatio;
  const tcText = tc
    ? [tc.title, tc.module, tc.steps, tc.expectedResult, tc.testData].filter(Boolean).join("\n")
    : "";
  const usableRaw = filterUnitLogicLayerCandidates(
    candidates.filter((c) => !isUnsuitableUnitPrimary(c.pathRel)),
    { tcText }
  );
  // Reuse body-rule contender collapse (I* vs impl, Query behind Service)
  const asBody: BodyRuleScoredCandidate[] = usableRaw.map((c) => ({
    ...c,
    reason: c.reason || "seed",
    baseScore: c.score,
    ruleHits: [] as string[],
  }));
  const usable = collapseBodyRuleContenders(asBody);
  const toSeed = (c: BodyRuleScoredCandidate): SeedCandidate => ({
    pathRel: c.pathRel,
    score: c.score,
    reason: c.reason || "seed",
    hits: c.hits,
  });
  const best = usable[0];
  if (!best || best.score < minScore) return null;
  const second = usable[1];
  if (!second) return toSeed(best);
  const margin = best.score - second.score;
  if (margin >= minMargin) return toSeed(best);
  if (best.score >= second.score * minRatio) return toSeed(best);
  const bStem = symbolCodeFromPathRel(best.pathRel).toLowerCase();
  const sStem = symbolCodeFromPathRel(second.pathRel).toLowerCase();
  if (bStem && bStem === sStem) return toSeed(best);
  return null;
}

export function enrichTestDataWithUnitMarkers(
  testData: string | null | undefined,
  seed: Pick<SeedCandidate, "pathRel" | "score"> & {
    reason?: string;
    ruleHits?: string[];
  },
  sourceNote = "ProjectFileIndex",
  projectRoot?: string | null,
  codeOverride?: string | null,
  relatedPaths?: string[] | null
): UnitMarkerEnrichResult {
  let existing = (testData || "").trim();
  if (hasManualUnitSourceMarkers(existing)) {
    return { testData: existing, enriched: false };
  }
  if (AUTO_ENRICHED_RE.test(existing)) {
    existing = stripAutoEnrichedMarkers(existing);
  }
  const pathRel = toRepoRelativePath(seed.pathRel, projectRoot);
  const code = (codeOverride || "").trim() || symbolCodeFromPathRel(pathRel);
  if (!pathRel || !code || /^[A-Za-z]:/.test(pathRel) || pathRel.includes(":/")) {
    return { testData: existing, enriched: false };
  }
  if (isUnsuitableUnitPrimary(pathRel)) {
    return { testData: existing, enriched: false };
  }
  const fromDb = /index\.db/i.test(sourceNote);
  const ruleHits =
    "ruleHits" in seed && Array.isArray((seed as BodyRuleScoredCandidate).ruleHits)
      ? (seed as BodyRuleScoredCandidate).ruleHits
      : [];
  const related = (relatedPaths || [])
    .map((p) => toRepoRelativePath(p, projectRoot))
    .filter((p) => p && p !== pathRel);
  const rulePart = ruleHits.length ? ` ruleHits=${ruleHits.join("+")}` : "";
  const relatedPart = related.length ? ` related=${related.length}` : "";
  const block = [
    `path: ${pathRel}`,
    `code: ${code}`,
    ...formatRelatedMarkerLines(related),
    `# auto-enriched from ${sourceNote} (score=${seed.score}${rulePart}${relatedPart} writeBack=yes)`,
  ].join("\n");
  const next = existing ? `${existing}\n${block}` : block;
  return {
    testData: next,
    enriched: true,
    pathRel,
    code,
    score: seed.score,
    reason: seed.reason,
    source: fromDb ? "index.db" : "path-index",
    ruleHits,
    relatedPaths: related,
    writeBack: true,
  };
}

function pathHitsDomainToken(pathRel: string, token: string): boolean {
  const low = (pathRel || "").replace(/\\/g, "/").toLowerCase();
  const tl = (token || "").toLowerCase();
  if (!low || tl.length < 4) return false;
  return low.includes(tl);
}

/**
 * When project code-aliases match the TC module/requirement, keep only
 * candidates whose path contains those domain tokens — blocks body-rule
 * latch onto unrelated *Service (Image/Auth/Mail) that merely throw/Validate.
 */
export function filterCandidatesByProjectAliases<T extends { pathRel: string }>(
  candidates: T[],
  opts: {
    requirementTitle?: string | null;
    module?: string | null;
    title?: string | null;
    projectAliases?: CodeAliasMap | null;
  }
): { candidates: T[]; domainTokens: string[]; filtered: boolean } {
  const blob = [opts.requirementTitle, opts.module, opts.title]
    .filter(Boolean)
    .join(" ");
  const domainTokens = matchingProjectAliasTokens(blob, opts.projectAliases);
  if (!domainTokens.length || !candidates.length) {
    return { candidates, domainTokens, filtered: false };
  }
  const hit = candidates.filter((c) =>
    domainTokens.some((t) => pathHitsDomainToken(c.pathRel, t))
  );
  if (!hit.length) {
    return { candidates: [], domainTokens, filtered: true };
  }
  return { candidates: hit, domainTokens, filtered: true };
}

function relatedPathsForSeed(
  entryPathRel: string,
  index: ProjectFileIndex,
  codeIndex: CodeIndexSnapshot | null | undefined,
  featureTokens: string[],
  preferDtoValidator = false
): string[] {
  const fromDb = codeIndex ? Object.keys(codeIndex.files || {}) : [];
  const fromIndex = index.files.map((f) => f.pathRel);
  const allPaths = [...new Set([...fromDb, ...fromIndex].map((p) => p.replace(/\\/g, "/")))];
  return expandUnitRelatedPaths({
    entryPathRel: entryPathRel.replace(/\\/g, "/"),
    allPaths,
    featureTokens,
    preferDtoValidator,
  });
}

function preferDtoValidatorForIntent(
  intent: UnitIntent,
  testData?: string | null
): boolean {
  return preferDtoValidatorForHints(intent, testData);
}

function allPathsForRelated(
  index: ProjectFileIndex,
  codeIndex: CodeIndexSnapshot | null | undefined
): string[] {
  const fromDb = codeIndex ? Object.keys(codeIndex.files || {}) : [];
  const fromIndex = index.files.map((f) => f.pathRel);
  return [...new Set([...fromDb, ...fromIndex].map((p) => p.replace(/\\/g, "/")))];
}

function promoteSeedForLayerHint(
  seed: SeedCandidate,
  relatedPaths: string[],
  testData: string | null | undefined,
  index: ProjectFileIndex,
  codeIndex: CodeIndexSnapshot | null | undefined,
  featureTokens: string[],
  symbolFromPath: (pathRel: string) => string | null
): {
  seed: SeedCandidate;
  relatedPaths: string[];
  symbol: string | null;
  promoted: boolean;
} {
  const applied = applyLayerHintPrimaryPromotion({
    testData,
    primaryPath: seed.pathRel,
    relatedPaths,
    allPaths: allPathsForRelated(index, codeIndex),
    featureTokens,
  });
  if (!applied.promoted) {
    return {
      seed,
      relatedPaths,
      symbol: symbolFromPath(seed.pathRel),
      promoted: false,
    };
  }
  return {
    seed: {
      ...seed,
      pathRel: applied.primaryPath,
      reason: `${seed.reason || "seed"}+layerHint`,
      hits: [...(seed.hits || []), "layerHint-promote"],
    },
    relatedPaths: applied.relatedPaths,
    symbol: symbolFromPath(applied.primaryPath),
    promoted: true,
  };
}

function prepareTcForEnrich(tc: TestCase): TestCase {
  const rawTd = (tc.testData || "").trim();
  if (AUTO_ENRICHED_RE.test(rawTd) || SUT_SKIP_RE.test(rawTd)) {
    return {
      ...tc,
      testData: stripAutoEnrichedMarkers(rawTd)
        .split(/\r?\n/)
        .filter((l) => !SUT_SKIP_RE.test(l))
        .join("\n")
        .trim(),
    };
  }
  return tc;
}

/**
 * Sync enrich (path/symbol only).
 * When intent.requiresBodyRule and no excerpt reader → fail-closed skip
 * (body-rule must be verified via enrichTcTestDataFromIndexAsync).
 */
export function enrichTcTestDataFromIndex(
  tc: TestCase,
  index: ProjectFileIndex,
  opts?: SeedResolveOptions & {
    projectRoot?: string | null;
    codeIndex?: CodeIndexSnapshot | null;
  }
): UnitMarkerEnrichResult {
  const rawTd = (tc.testData || "").trim();
  if (hasManualUnitSourceMarkers(rawTd)) {
    return { testData: rawTd, enriched: false, writeBack: false };
  }
  const tcForResolve = prepareTcForEnrich(tc);
  const intent = extractUnitIntent(tcForResolve, {
    projectAliases: opts?.projectAliases,
    requirementTitle: opts?.requirementTitle,
  });
  const hadIndex =
    Boolean(opts?.codeIndex && Object.keys(opts.codeIndex.files || {}).length) ||
    index.files.length > 0;

  const unitScope = opts?.unitScope || "backend";
  if (
    unitScope === "backend" &&
    (intent.uiOnly || intent.primaryClass === "ui_master_create")
  ) {
    const skipReason =
      `FAIL_FEATURE_GAP — intent «${intent.primaryClass || "ui"}» is UI/master; ` +
      `unit.scope=backend (no BE writeBack)`;
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
    };
  }

  if (intent.requiresBodyRule) {
    const skipReason = explainEnrichSkip(tcForResolve, {
      hadIndex,
      detail:
        "body-rule required — need SUT excerpt (Approve via Desktop/Tauri body-rule pass)",
    });
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
    };
  }

  const preferTokens = [
    ...extractMatchTokens(
      [opts?.requirementTitle, tc.module, tc.title].filter(Boolean).join(" "),
      opts?.projectAliases
    ),
    ...intent.featureTokens,
  ];
  const { candidates, source } = collectSeedCandidates(tcForResolve, index, opts);
  // Soft margin for non-body-rule (bulk Approve / storage / enable TCs)
  const seed = pickConfidentUnitSeed(candidates, tcForResolve, {
    minMargin: UNIT_AUTO_MARKER.softMinMargin,
    minRatio: UNIT_AUTO_MARKER.softMinRatio,
  });
  if (!seed) {
    const top = candidates
      .slice(0, 3)
      .map((c) => `${c.pathRel.split("/").pop()}(${c.score})`)
      .join(", ");
    const skipReason = explainEnrichSkip(tcForResolve, {
      hadIndex,
      detail: top
        ? `no confident Module→Function→Title match; top3: ${top}`
        : undefined,
    });
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        baseScore: c.score,
        ruleHits: [],
      })),
    };
  }
  // P0.1 — soft writeBack needs domain/prefer/alias signal (not Create/throw alone)
  if (
    !hasStrongWriteBackSignal({
      pathRel: seed.pathRel,
      ruleHits: [],
      hits: seed.hits,
      preferTokens,
    })
  ) {
    const skipReason =
      "FAIL_SOFT_NO_DOMAIN — soft writeBack needs prefer/phrase/alias on path (not generic IT alone)";
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        baseScore: c.score,
        ruleHits: [],
      })),
    };
  }
  // Module family lock — refuse Account/Auth/Jwt soft latch
  const softGate = uniqTokens([
    ...matchingProjectAliasTokens(
      [opts?.requirementTitle, tc.module].filter(Boolean).join(" "),
      opts?.projectAliases
    ),
    ...extractMatchTokens(tc.module || "", opts?.projectAliases),
  ]);
  if (softCrossCuttingDenied(seed.pathRel, softGate)) {
    const skipReason =
      "FAIL_SOFT_CROSS_CUTTING — refused Auth/Mail/Notification/signed-URL primary (infra soft lock)";
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        baseScore: c.score,
        ruleHits: [],
      })),
    };
  }
  const relatedPaths0 = relatedPathsForSeed(
    seed.pathRel,
    index,
    opts?.codeIndex,
    preferTokens,
    preferDtoValidatorForIntent(intent, tcForResolve.testData)
  );
  const promoted = promoteSeedForLayerHint(
    seed,
    relatedPaths0,
    tcForResolve.testData,
    index,
    opts?.codeIndex,
    preferTokens,
    (pathRel) =>
      source === "index.db" && opts?.codeIndex
        ? preferredSymbolFromCodeIndex(opts.codeIndex, pathRel, preferTokens)
        : null
  );
  return enrichTestDataWithUnitMarkers(
    tcForResolve.testData,
    promoted.seed,
    source === "index.db" ? "index.db" : "ProjectFileIndex",
    opts?.projectRoot,
    promoted.symbol,
    promoted.relatedPaths
  );
}

/**
 * Async enrich with body-rule scoring (Phase 3) + related expand (Phase 4).
 * Opens top-N candidate excerpts via readExcerpt before write-back.
 */
export async function enrichTcTestDataFromIndexAsync(
  tc: TestCase,
  index: ProjectFileIndex,
  opts?: SeedResolveOptions & {
    projectRoot?: string | null;
    projectId?: string | null;
    codeIndex?: CodeIndexSnapshot | null;
    readExcerpt?: ReadSourceExcerpt | null;
    enrichProfile?: UnitEnrichProfileKnobs | null;
    pickFromShortlist?: PickFromShortlistFn | null;
  }
): Promise<UnitMarkerEnrichResult> {
  const rawTd = (tc.testData || "").trim();
  if (hasManualUnitSourceMarkers(rawTd)) {
    return { testData: rawTd, enriched: false, writeBack: false };
  }
  const tcForResolve = prepareTcForEnrich(tc);
  const profile =
    opts?.enrichProfile ||
    (opts?.projectRoot
      ? await loadUnitEnrichProfileKnobs(opts.projectRoot)
      : null);
  const unitScope = opts?.unitScope || profile?.scope || "backend";

  const baseIntent = extractUnitIntent(tcForResolve, {
    projectAliases: opts?.projectAliases,
    requirementTitle: opts?.requirementTitle,
    uiFromTitleModuleOnly: true,
  });
  const applied = applyProjectIntentRules(baseIntent, profile?.intentRules, {
    title: tcForResolve.title,
    module: tcForResolve.module,
    steps: tcForResolve.steps,
    expectedResult: tcForResolve.expectedResult,
    unitScope,
  });
  const intent = applied.intent;

  const preferTokens = [
    ...extractMatchTokens(
      [opts?.requirementTitle, tc.module, tc.title].filter(Boolean).join(" "),
      opts?.projectAliases
    ),
    ...intent.featureTokens,
  ];
  const hadIndex =
    Boolean(opts?.codeIndex && Object.keys(opts.codeIndex.files || {}).length) ||
    index.files.length > 0;

  // Project intent / UI under BE → refuse writeBack
  if (
    applied.scopeRefuse === "FAIL_FEATURE_GAP" ||
    (unitScope === "backend" &&
      (intent.uiOnly || intent.primaryClass === "ui_master_create"))
  ) {
    const skipReason =
      `FAIL_FEATURE_GAP — intent «${applied.matchedIds.join(",") || intent.primaryClass || "ui"}»; ` +
      `unit.scope=${unitScope} (no BE writeBack)`;
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
    };
  }

  // sutMap pin (per-repo) — highest priority when present
  const pinPath = resolveSutMapPin(profile?.sutMap, {
    preferSutMapKey: applied.preferSutMapKey,
    module: tc.module,
    title: tc.title,
    matchedIntentIds: applied.matchedIds,
  });
  if (pinPath && opts?.readExcerpt) {
    const guard = applyProfileDomainGuards({
      moduleText: [tc.module, tc.title].filter(Boolean).join("\n"),
      primaryPath: pinPath,
      rules: profile?.domainGuards,
    });
    if (!guard.pass) {
      return {
        testData: withSutResolveSkipNote(
          tcForResolve.testData,
          `FAIL_DOMAIN_GUARD — sutMap pin denied: ${guard.reason}`
        ),
        enriched: false,
        skipReason: guard.reason,
        writeBack: false,
      };
    }
    const excerpt = await opts.readExcerpt(pinPath);
    if (excerpt?.trim()) {
      const code =
        (opts.codeIndex
          ? preferredSymbolFromCodeIndex(opts.codeIndex, pinPath, preferTokens)
          : null) ||
        pinPath.split("/").pop()?.replace(/\.[^.]+$/, "") ||
        "Sut";
      const relatedPaths = expandUnitRelatedPaths({
        entryPathRel: pinPath,
        allPaths: [
          pinPath,
          ...index.files.map((f) => f.pathRel),
          ...(opts.codeIndex ? Object.keys(opts.codeIndex.files) : []),
        ],
        featureTokens: preferTokens,
        maxRelated: 4,
        preferDtoValidator: preferDtoValidatorForIntent(
          intent,
          tcForResolve.testData
        ),
      }).filter((p) => {
        const g = applyProfileDomainGuards({
          moduleText: [tc.module, tc.title].filter(Boolean).join("\n"),
          primaryPath: p,
          rules: profile?.domainGuards,
        });
        return g.pass;
      });
      const seed: SeedCandidate = {
        pathRel: pinPath,
        score: 999,
        hits: ["sutMap"],
        reason: `sutMap:${applied.preferSutMapKey || applied.matchedIds[0] || "pin"}`,
      };
      return enrichTestDataWithUnitMarkers(
        tcForResolve.testData,
        { ...seed, ruleHits: ["sutMap"] },
        "sutMap",
        opts?.projectRoot,
        code,
        relatedPaths
      );
    }
  }

  const moduleText = [tc.module, tc.title, opts?.requirementTitle]
    .filter(Boolean)
    .join("\n");

  // Unified pipeline (Phase 1): Query → retrieveUnitSources → rank → body-rule → markers
  const codeIndexSnap =
    opts?.codeIndex && Object.keys(opts.codeIndex.files || {}).length
      ? opts.codeIndex
      : index.files.length
        ? snapshotFromPaths(index.files.map((f) => f.pathRel))
        : null;
  const hasCodeIndex = Boolean(codeIndexSnap);
  if (hasCodeIndex && codeIndexSnap) {
    const query = buildUnitApproveQuery(tcForResolve, {
      requirementTitle: opts?.requirementTitle,
      projectAliases: opts?.projectAliases,
      intent,
    });
    const resolved = await resolveUnitPrimaryFromIndex({
      codeIndex: codeIndexSnap,
      query,
      readExcerpt: opts?.readExcerpt
        ? async (p: string): Promise<string> => {
            const text = await opts.readExcerpt!(p);
            return text || "";
          }
        : null,
      topK: intent.requiresBodyRule ? 24 : 16,
      fallbackPaths: index.files.map((f) => f.pathRel),
      pickFromShortlist: opts?.pickFromShortlist ?? null,
      llmPromptFields: {
        projectId: opts?.projectId || null,
        steps: tc.steps,
        expectedResult: tc.expectedResult,
      },
    });

    if (resolved.writeBack && resolved.seed) {
      let seed = resolved.seed;
      if (profile?.domainGuards?.length) {
        const g = applyProfileDomainGuards({
          moduleText,
          primaryPath: seed.pathRel,
          rules: profile.domainGuards,
        });
        if (!g.pass) {
          return {
            testData: withSutResolveSkipNote(
              tcForResolve.testData,
              `FAIL_DOMAIN_GUARD — ${g.reason}`
            ),
            enriched: false,
            skipReason: g.reason,
            writeBack: false,
            candidatesTop3: resolved.candidatesTop3,
            bodyRuleLog: resolved.bodyRuleLog,
          };
        }
      }
      let relatedPaths = filterCandidatesByDomainGuards(
        resolved.relatedPaths.map((pathRel) => ({ pathRel })),
        moduleText,
        profile?.domainGuards
      ).map((c) => c.pathRel);
      const promoted = promoteSeedForLayerHint(
        {
          pathRel: seed.pathRel,
          score: seed.score,
          reason: seed.reason || "unitResolve",
          hits: seed.hits,
          ruleHits: seed.ruleHits,
        },
        relatedPaths,
        tcForResolve.testData,
        index,
        opts?.codeIndex,
        preferTokens,
        (pathRel) =>
          opts?.codeIndex
            ? preferredSymbolFromCodeIndex(opts.codeIndex, pathRel, preferTokens)
            : null
      );
      relatedPaths = filterCandidatesByDomainGuards(
        promoted.relatedPaths.map((pathRel) => ({ pathRel })),
        moduleText,
        profile?.domainGuards
      ).map((c) => c.pathRel);
      const hit = enrichTestDataWithUnitMarkers(
        tcForResolve.testData,
        {
          pathRel: promoted.seed.pathRel,
          score: promoted.seed.score,
          reason: promoted.seed.reason || "unitResolve",
          ruleHits: promoted.seed.ruleHits,
        },
        "index.db",
        opts?.projectRoot,
        promoted.symbol || resolved.symbol,
        relatedPaths
      );
      return {
        ...hit,
        ruleHits: promoted.seed.ruleHits || seed.ruleHits || [],
        relatedPaths: hit.relatedPaths,
        candidatesTop3: resolved.candidatesTop3,
        writeBack: true,
        bodyRuleLog: resolved.bodyRuleLog,
      };
    }

    // Fail-closed from pipeline (do not fall through to progressive dual-path)
    const skipReason =
      resolved.skipReason ||
      explainEnrichSkip(tcForResolve, { hadIndex });
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
      candidatesTop3: resolved.candidatesTop3,
      bodyRuleLog: resolved.bodyRuleLog,
    };
  }

  // Fallback: no index.db — path-index progressive seed (legacy)
  // Body-rule TCs need a wider seed pool so *CommandHandler* stays in range
  // when title tokens rank *Query files ahead of the throw/BadRequest primary.
  const seedLimit = intent.requiresBodyRule
    ? Math.max(opts?.limit ?? 8, 16)
    : opts?.limit ?? 8;
  let { candidates, source } = collectSeedCandidates(tcForResolve, index, {
    ...opts,
    limit: seedLimit,
    unitScope,
  });
  candidates = filterCandidatesByDomainGuards(
    candidates,
    moduleText,
    profile?.domainGuards
  );
  if (!candidates.length) {
    const skipReason =
      profile?.domainGuards?.length
        ? explainEnrichSkip(tcForResolve, {
            hadIndex,
            detail: "domainGuards removed all candidates (or empty index)",
          })
        : explainEnrichSkip(tcForResolve, { hadIndex });
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
    };
  }

  // Project aliases (SoT) — keep only domain-aligned paths; if seed pool missed
  // them, re-seed from full path index by alias tokens.
  const aliasHit = filterCandidatesByProjectAliases(candidates, {
    requirementTitle: opts?.requirementTitle,
    module: tc.module,
    title: tc.title,
    projectAliases: opts?.projectAliases,
  });
  if (aliasHit.filtered) {
    if (aliasHit.candidates.length) {
      candidates = aliasHit.candidates;
    } else if (aliasHit.domainTokens.length) {
      const pool = [
        ...index.files.map((f) => f.pathRel),
        ...(opts?.codeIndex ? Object.keys(opts.codeIndex.files) : []),
      ];
      const domainPaths = [
        ...new Set(
          pool
            .map((p) => p.replace(/\\/g, "/"))
            .filter((p) =>
              aliasHit.domainTokens.some((t) => pathHitsDomainToken(p, t))
            )
        ),
      ];
      const logic = filterUnitLogicLayerCandidates(
        domainPaths
          .filter((p) => !isUnsuitableUnitPrimary(p))
          .map((pathRel) => ({
            pathRel,
            score: 60,
            reason: `alias:${aliasHit.domainTokens.slice(0, 3).join("+")}`,
            hits: aliasHit.domainTokens.slice(0, 4),
          })),
        { tcText: moduleText }
      );
      candidates = filterCandidatesByDomainGuards(
        logic,
        moduleText,
        profile?.domainGuards
      );
      if (!candidates.length) {
        const skipReason = explainEnrichSkip(tcForResolve, {
          hadIndex,
          detail: `no alias-aligned candidates for «${aliasHit.domainTokens.join(", ")}» (check code-aliases.json / index)`,
        });
        return {
          testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
          enriched: false,
          skipReason,
          writeBack: false,
        };
      }
    }
  }

  const readExcerpt = opts?.readExcerpt;
  const tcBlob = [
    tcForResolve.title,
    tcForResolve.module,
    tcForResolve.steps,
    tcForResolve.expectedResult,
    tcForResolve.testData,
  ]
    .filter(Boolean)
    .join("\n");
  if (readExcerpt && (intent.codePatterns.length > 0 || intent.requiresBodyRule)) {
    const fallbackPrefer = uniqTokens([
      ...matchingProjectAliasTokens(moduleText, opts?.projectAliases),
      ...extractMatchTokens(moduleText, opts?.projectAliases).filter(
        (t) => t.length >= 4
      ),
    ]);
    const rescored = await rescoreWithBodyRules(
      candidates,
      intent,
      readExcerpt,
      tcBlob,
      fallbackPrefer
    );
    // Body-rule TCs stay strict; plain upload/reject use soft margin so bulk Approve
    // is not emptied by I*/Query near-ties.
    const marginOpts = intent.requiresBodyRule
      ? {
          minScore: UNIT_AUTO_MARKER.minScore,
          minMargin: UNIT_AUTO_MARKER.minMargin,
          minRatio: UNIT_AUTO_MARKER.minRatio,
        }
      : {
          minScore: UNIT_AUTO_MARKER.minScore,
          minMargin: UNIT_AUTO_MARKER.softMinMargin,
          minRatio: UNIT_AUTO_MARKER.softMinRatio,
        };
    let decision = decideBodyRuleWriteBack(rescored, intent, {
      ...marginOpts,
      preferTokens: fallbackPrefer,
    });
    let seed = decision.seed;

    // Domain guard on chosen primary
    if (seed && profile?.domainGuards?.length) {
      const g = applyProfileDomainGuards({
        moduleText,
        primaryPath: seed.pathRel,
        rules: profile.domainGuards,
      });
      if (!g.pass) {
        decision = {
          writeBack: false,
          seed: null,
          skipReason: `FAIL_DOMAIN_GUARD — ${g.reason}`,
          candidatesTop3: decision.candidatesTop3,
        };
        seed = null;
      }
    }

    // Behavior TC: never writeBack anemic entity/POCO as primary — fall to next Handler/Service
    if (
      seed &&
      tcImpliesBehaviorPrimary(tcBlob) &&
      isAnemicEntityLikePath(seed.pathRel)
    ) {
      const next = collapseBodyRuleContenders(rescored).find(
        (c) =>
          c.ruleHits.length >= 1 &&
          !isAnemicEntityLikePath(c.pathRel) &&
          !isUnsuitableUnitPrimary(c.pathRel)
      );
      if (next && next.score >= UNIT_AUTO_MARKER.minScore) {
        seed = next;
        decision = {
          writeBack: true,
          seed: next,
          candidatesTop3: decision.candidatesTop3,
          skipReason: undefined,
        };
      } else {
        decision = {
          writeBack: false,
          seed: null,
          skipReason: `behavior TC — refusing entity/POCO primary «${seed.pathRel.split("/").pop()}»; prefer Handler/Service`,
          candidatesTop3: decision.candidatesTop3,
        };
        seed = null;
      }
    }

    if ((!decision.writeBack || !seed) && !intent.requiresBodyRule) {
      const collapsed = collapseBodyRuleContenders(
        filterCandidatesByDomainGuards(rescored, moduleText, profile?.domainGuards)
      );
      const softSeed = pickConfidentUnitSeed(
        collapsed.map((c) => ({
          pathRel: c.pathRel,
          score: c.score,
          reason: c.reason || "seed",
          hits: c.hits,
        })),
        tcForResolve,
        {
          minMargin: UNIT_AUTO_MARKER.softMinMargin,
          minRatio: UNIT_AUTO_MARKER.softMinRatio,
        }
      );
      if (softSeed) {
        if (
          tcImpliesBehaviorPrimary(tcBlob) &&
          isAnemicEntityLikePath(softSeed.pathRel)
        ) {
          /* keep skip — do not promote entity */
        } else {
          const softRuleHits =
            collapsed.find((c) => c.pathRel === softSeed.pathRel)?.ruleHits ||
            [];
          const softOk = hasStrongWriteBackSignal({
            pathRel: softSeed.pathRel,
            ruleHits: softRuleHits,
            hits: softSeed.hits,
            preferTokens: fallbackPrefer,
          });
          if (softOk) {
            seed = {
              ...softSeed,
              reason: softSeed.reason || "seed",
              baseScore: softSeed.score,
              ruleHits: softRuleHits,
            };
            decision = {
              writeBack: true,
              seed,
              candidatesTop3: decision.candidatesTop3,
              skipReason: undefined,
            };
          } else {
            decision = {
              writeBack: false,
              seed: null,
              skipReason:
                "FAIL_SOFT_NO_DOMAIN — soft writeBack needs prefer/phrase/alias (not throw/BadRequest/Create alone)",
              candidatesTop3: decision.candidatesTop3,
            };
            seed = null;
          }
        }
      }
    }

    // P0.1 — any soft (!requiresBodyRule) writeBack must carry domain/prefer/phrase signal
    if (decision.writeBack && seed && !intent.requiresBodyRule) {
      const softOk = hasStrongWriteBackSignal({
        pathRel: seed.pathRel,
        ruleHits: seed.ruleHits,
        hits: seed.hits,
        preferTokens: fallbackPrefer,
      });
      if (!softOk) {
        decision = {
          writeBack: false,
          seed: null,
          skipReason:
            "FAIL_SOFT_NO_DOMAIN — soft writeBack needs prefer/phrase/alias (not throw/BadRequest/Create alone)",
          candidatesTop3: decision.candidatesTop3,
        };
        seed = null;
      }
    }

    if (decision.writeBack && seed && !intent.requiresBodyRule) {
      const softGate = uniqTokens([
        ...matchingProjectAliasTokens(moduleText, opts?.projectAliases),
        ...extractMatchTokens(tc.module || "", opts?.projectAliases),
        ...fallbackPrefer,
      ]);
      if (softCrossCuttingDenied(seed.pathRel, softGate)) {
        decision = {
          writeBack: false,
          seed: null,
          skipReason:
            "FAIL_SOFT_CROSS_CUTTING — refused Auth/Mail/Notification/signed-URL primary (infra soft lock)",
          candidatesTop3: decision.candidatesTop3,
        };
        seed = null;
      }
    }

    const bodyRuleLog = formatBodyRuleLog(decision, {
      intentClass: intent.primaryClass,
      matchedIntentIds: applied.matchedIds,
      softSignalOk:
        decision.writeBack && seed
          ? true
          : decision.skipReason?.includes("FAIL_SOFT_NO_DOMAIN") ||
              decision.skipReason?.includes("FAIL_SOFT_CROSS_CUTTING")
            ? false
            : null,
    });
    if (!decision.writeBack || !seed) {
      const skipReason =
        decision.skipReason ||
        explainEnrichSkip(tcForResolve, { hadIndex });
      return {
        testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
        enriched: false,
        skipReason,
        writeBack: false,
        candidatesTop3: decision.candidatesTop3,
        bodyRuleLog,
      };
    }
    let relatedPaths = relatedPathsForSeed(
      seed.pathRel,
      index,
      opts?.codeIndex,
      [...preferTokens, ...(seed.ruleHits || [])],
      preferDtoValidatorForIntent(intent, tcForResolve.testData)
    );
    relatedPaths = filterCandidatesByDomainGuards(
      relatedPaths.map((pathRel) => ({ pathRel })),
      moduleText,
      profile?.domainGuards
    ).map((c) => c.pathRel);
    const promoted = promoteSeedForLayerHint(
      seed,
      relatedPaths,
      tcForResolve.testData,
      index,
      opts?.codeIndex,
      [...preferTokens, ...(seed.ruleHits || [])],
      (pathRel) =>
        source === "index.db" && opts?.codeIndex
          ? preferredSymbolFromCodeIndex(opts.codeIndex, pathRel, [
              ...preferTokens,
              ...(seed.ruleHits || []),
            ])
          : null
    );
    relatedPaths = filterCandidatesByDomainGuards(
      promoted.relatedPaths.map((pathRel) => ({ pathRel })),
      moduleText,
      profile?.domainGuards
    ).map((c) => c.pathRel);
    const hit = enrichTestDataWithUnitMarkers(
      tcForResolve.testData,
      {
        pathRel: promoted.seed.pathRel,
        score: promoted.seed.score,
        reason: promoted.seed.reason || "seed",
        ruleHits: promoted.seed.ruleHits,
      },
      source === "index.db" ? "index.db" : "ProjectFileIndex",
      opts?.projectRoot,
      promoted.symbol,
      relatedPaths
    );
    return {
      ...hit,
      ruleHits: "ruleHits" in promoted.seed ? promoted.seed.ruleHits : [],
      relatedPaths: hit.relatedPaths,
      candidatesTop3: decision.candidatesTop3,
      writeBack: true,
      bodyRuleLog,
    };
  }

  // No excerpt reader: cannot verify body-rule intents
  if (intent.requiresBodyRule) {
    const skipReason =
      "body-rule required — need SUT excerpt (Approve via Desktop/Tauri body-rule pass)";
    return {
      testData: withSutResolveSkipNote(tcForResolve.testData, skipReason),
      enriched: false,
      skipReason,
      writeBack: false,
    };
  }

  return enrichTcTestDataFromIndex(tc, index, { ...opts, unitScope });
}

export async function loadProjectCodeAliases(
  projectRoot: string
): Promise<CodeAliasMap | null> {
  try {
    const raw = await readTextFile(projectRoot, ".ai-test/code-aliases.json");
    const parsed = JSON.parse(raw) as CodeAliasMap;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* optional */
  }
  return null;
}

export async function loadProjectCodeIndex(
  projectRoot: string
): Promise<CodeIndexSnapshot | null> {
  if (!isTauri()) return null;
  try {
    return await loadIndexSnapshot(projectRoot, createTauriCodeIndexIo());
  } catch {
    return null;
  }
}

export async function listUnitIndexSourcePaths(
  projectRoot: string
): Promise<string[]> {
  if (!isTauri()) return [];
  const exts = sourceExtensionsForLanguage("");
  const raw = await listSourceFiles(projectRoot, exts);
  return raw.map((p) => toRepoRelativePath(p, projectRoot)).filter(Boolean);
}

export type EnrichApprovedCasesOpts = {
  projectId: string;
  projectRoot: string;
  cases: TestCase[];
  requirementTitle?: string | null;
  requirementTitleByCaseKey?: Record<string, string> | null;
  codeAliases?: CodeAliasMap | null;
  allSourcePaths?: string[] | null;
};

export type EnrichApprovedCasesResult = {
  cases: TestCase[];
  enrichedCount: number;
  skippedAmbiguous: number;
  /** TCs that gained path:/code: on sequential retry after batch wave */
  retryEnrichedCount?: number;
  indexFileCount: number;
  usedCodeIndex: boolean;
  /** Optional body-rule logs (one line per TC that ran body scoring). */
  bodyRuleLogs?: string[];
};

function resolveReqTitle(tc: TestCase, opts: EnrichApprovedCasesOpts): string {
  const map = opts.requirementTitleByCaseKey || {};
  return (
    (map[tc.testCaseId] || map[tc.id] || (tc.sourceId ? map[tc.sourceId] : "") || "").trim() ||
    (opts.requirementTitle || "").trim() ||
    ""
  );
}

function makePickFromShortlist(
  projectId: string,
  pickTimeoutMs?: number
): PickFromShortlistFn {
  return (input) =>
    llmPickUnitPrimary({
      ...input,
      projectId,
      pickTimeoutMs,
    });
}

type EnrichOneHit = {
  idx: number;
  tc: TestCase;
  enriched: boolean;
  bodyRuleLog?: string;
};

async function enrichOneApprovedUnitCase(
  tc: TestCase,
  idx: number,
  ctx: {
    pathIndex: ProjectFileIndex;
    opts: EnrichApprovedCasesOpts;
    aliases: CodeAliasMap | null | undefined;
    enrichProfile: UnitEnrichProfileKnobs;
    codeIndex: CodeIndexSnapshot | null;
    readExcerpt: ReadSourceExcerpt | null;
    pickFromShortlist: PickFromShortlistFn | null;
  }
): Promise<EnrichOneHit> {
  if (!shouldEnrichUnitTc(tc)) {
    return { idx, tc, enriched: false };
  }
  const hit = await enrichTcTestDataFromIndexAsync(tc, ctx.pathIndex, {
    projectAliases: ctx.aliases,
    requirementTitle: resolveReqTitle(tc, ctx.opts),
    limit: 8,
    projectRoot: ctx.opts.projectRoot,
    projectId: ctx.opts.projectId,
    codeIndex: ctx.codeIndex,
    readExcerpt: ctx.readExcerpt,
    enrichProfile: ctx.enrichProfile,
    unitScope: ctx.enrichProfile.scope,
    pickFromShortlist: ctx.pickFromShortlist,
  });
  if (!hit.enriched) {
    return {
      idx,
      tc: { ...tc, testData: hit.testData || tc.testData },
      enriched: false,
      bodyRuleLog: hit.bodyRuleLog,
    };
  }
  return {
    idx,
    tc: { ...tc, testData: hit.testData },
    enriched: true,
    bodyRuleLog: hit.bodyRuleLog,
  };
}

/**
 * Clone Approved TCs with Test Data enriched from index.db / path index when confident.
 */
export async function enrichApprovedCasesWithUnitMarkers(
  opts: EnrichApprovedCasesOpts
): Promise<EnrichApprovedCasesResult> {
  const codeIndex = await loadProjectCodeIndex(opts.projectRoot);
  const usedCodeIndex = Boolean(codeIndex && Object.keys(codeIndex.files).length);

  // Prefer paths from index.db — skip full repo listSourceFiles when index present
  const paths =
    usedCodeIndex && codeIndex
      ? Object.keys(codeIndex.files)
      : opts.allSourcePaths?.length
        ? opts.allSourcePaths
            .map((p) => toRepoRelativePath(p, opts.projectRoot))
            .filter(Boolean)
        : await listUnitIndexSourcePaths(opts.projectRoot);

  const indexPaths = paths;
  if (!indexPaths.length) {
    return {
      cases: opts.cases,
      enrichedCount: 0,
      skippedAmbiguous: 0,
      retryEnrichedCount: 0,
      indexFileCount: 0,
      usedCodeIndex: false,
    };
  }

  const aliases =
    opts.codeAliases || (await loadProjectCodeAliases(opts.projectRoot));
  const enrichProfile = await loadUnitEnrichProfileKnobs(opts.projectRoot);
  const pathIndex = buildProjectIndexCached(
    opts.projectId || "local",
    indexPaths
  );

  const readExcerpt: ReadSourceExcerpt | null = isTauri()
    ? async (pathRel) => {
        try {
          return await readTextFile(opts.projectRoot, pathRel.replace(/\\/g, "/"));
        } catch {
          return null;
        }
      }
    : null;

  const pickFromShortlist: PickFromShortlistFn | null = opts.projectId
    ? makePickFromShortlist(opts.projectId)
    : null;

  const enrichCtx = {
    pathIndex,
    opts,
    aliases,
    enrichProfile,
    codeIndex,
    readExcerpt,
    pickFromShortlist,
  };

  const CONCURRENCY = 6;
  const work = opts.cases.map((tc, idx) => ({ tc, idx }));
  const results: EnrichOneHit[] = [];

  for (let i = 0; i < work.length; i += CONCURRENCY) {
    const chunk = work.slice(i, i + CONCURRENCY);
    const chunkHits = await Promise.all(
      chunk.map(({ tc, idx }) => enrichOneApprovedUnitCase(tc, idx, enrichCtx))
    );
    results.push(...chunkHits);
  }

  // Sequential retry — bulk Approve often misses path:/code: when LLM picks time out under load.
  let retryEnrichedCount = 0;
  const retryPick = opts.projectId
    ? makePickFromShortlist(opts.projectId, LLM_PICK_RETRY_TIMEOUT_MS)
    : null;
  const retryCtx = { ...enrichCtx, pickFromShortlist: retryPick };

  for (const r of results) {
    const original = opts.cases[r.idx];
    if (!shouldEnrichUnitTc(original)) continue;
    if (r.enriched && hasUnitPathCodeMarkers(r.tc.testData)) continue;
    const retry = await enrichOneApprovedUnitCase(r.tc, r.idx, retryCtx);
    if (retry.enriched && hasUnitPathCodeMarkers(retry.tc.testData)) {
      r.tc = retry.tc;
      r.enriched = true;
      r.bodyRuleLog = retry.bodyRuleLog;
      retryEnrichedCount += 1;
    } else if (!hasUnitPathCodeMarkers(r.tc.testData) && retry.tc.testData) {
      r.tc = retry.tc;
      r.bodyRuleLog = retry.bodyRuleLog || r.bodyRuleLog;
    }
  }

  results.sort((a, b) => a.idx - b.idx);
  let enrichedCount = 0;
  let skippedAmbiguous = 0;
  const bodyRuleLogs: string[] = [];
  const cases: TestCase[] = [];
  for (const r of results) {
    cases.push(r.tc);
    const original = opts.cases[r.idx];
    if (!shouldEnrichUnitTc(original)) continue;
    if (r.bodyRuleLog) bodyRuleLogs.push(`${r.tc.testCaseId}: ${r.bodyRuleLog}`);
    if (r.enriched) enrichedCount += 1;
    else skippedAmbiguous += 1;
  }

  return {
    cases,
    enrichedCount,
    skippedAmbiguous,
    retryEnrichedCount,
    indexFileCount: usedCodeIndex
      ? Object.keys(codeIndex!.files).length
      : pathIndex.files.length,
    usedCodeIndex,
    bodyRuleLogs,
  };
}
