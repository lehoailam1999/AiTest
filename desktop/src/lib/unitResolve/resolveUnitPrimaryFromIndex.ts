/**
 * Approve primary resolve pipeline:
 * Query → retrieveUnitSources → rank → symbol → expand → read/body-rule → path/code.
 * Shared retrieval brain with Gen; portable shape/body-rule from ide-protocol.
 */
import {
  applyBodyRuleToCandidate,
  clipBodyExcerpt,
  collapseBodyRuleContenders,
  countPreferTokenHits,
  decideBodyRuleWriteBack,
  discoverFeatureFoldersFromIndex,
  expandUnitRelatedPaths,
  featureFolderSegmentFromPath,
  filterCandidatesByFeatureFolders,
  filterUnitLogicLayerCandidates,
  filterUnitLogicLayerPaths,
  hasStrongWriteBackSignal,
  isAnemicEntityLikePath,
  isSignedUrlOrTokenGeneratePath,
  matchingProjectAliasTokens,
  orderCandidatesForBodyRuleOpen,
  pathHitsToken,
  preferDtoValidatorForHints,
  applyLayerHintPrimaryPromotion,
  softCrossCuttingDenied,
  tcImpliesBehaviorPrimary,
  UNIT_BODY_RULE,
  uploadIntentPathShapeAdjust,
  queryImpliesUploadIntent,
  extractOpPreferTokens,
  functionOpPathShapeAdjust,
  pathContradictsOpPreferTokens,
  queryImpliesAssignFilterIntent,
  validateRejectPathShapeAdjust,
  type BodyRuleScoredCandidate,
  type UnitIntent,
} from "@aitest/ide-protocol";
import { resolveImportSpecifier } from "../codeIndex/buildDependencyGraph";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import {
  extractTechIdentifierStems,
  preferredSymbolFromCodeIndex,
} from "../approvedTcSync/progressiveSeedFromCodeIndex";
import {
  extractMatchTokens,
} from "../projectIntelligence/tcSeedResolver";
import type { ResolvedSeed, SeedCandidate } from "../projectIntelligence/types";
import { isExcludedFromUnitRetrieve, isUnsuitableUnitPrimary, unitPathBonus } from "../retrieval/rankScore";
import { retrieveUnitSources } from "../retrieval/unitRetriever";
import type { RankedFileHit } from "../retrieval/types";
import type { UnitApproveQuery } from "./buildUnitApproveQuery";
import type {
  LlmPickUnitPrimaryInput,
  LlmPickUnitPrimaryResult,
  PickFromShortlistFn,
} from "./llmPickUnitPrimary";
import { acceptShortlistPick } from "./llmPickUnitPrimary";

export type ReadExcerptFn = (pathRel: string) => Promise<string>;

export type ResolveUnitPrimaryResult = {
  writeBack: boolean;
  seed: (SeedCandidate & { baseScore?: number; ruleHits?: string[] }) | null;
  symbol: string | null;
  relatedPaths: string[];
  candidatesTop3: Array<{
    pathRel: string;
    score: number;
    baseScore?: number;
    ruleHits: string[];
  }>;
  skipReason?: string;
  bodyRuleLog?: string;
  notes: string[];
  source: "index.db" | "path-index" | "llm-shortlist";
};

export type ResolveUnitPrimaryOpts = {
  codeIndex: CodeIndexSnapshot;
  query: UnitApproveQuery;
  readExcerpt?: ReadExcerptFn | null;
  topK?: number;
  /** Extra path pool when retrieve shortlist is thin */
  fallbackPaths?: string[];
  /**
   * When deterministic ungated/ambiguous — AI picks path ∈ shortlist only.
   * Inject mock in tests; Desktop wires llmPickUnitPrimary.
   */
  pickFromShortlist?: PickFromShortlistFn | null;
  /** TC text fields for LLM prompt (optional). */
  llmPromptFields?: {
    projectId?: string | null;
    steps?: string | null;
    expectedResult?: string | null;
  } | null;
};

const MIN_SCORE = 56;
const MIN_MARGIN = 20;
const MIN_RATIO = 1.45;
const SOFT_MARGIN = 8;
const SOFT_RATIO = 1.15;

function uniq(xs: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const x of xs) {
    const k = x.toLowerCase();
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function pathHitsDomainToken(pathRel: string, token: string): boolean {
  return pathHitsToken(pathRel, token);
}

/** Folders that contain CheckCode* — portable code-field feature widen. */
function discoverCheckCodeFolders(snap: CodeIndexSnapshot): Set<string> {
  const folders = new Set<string>();
  const paths = Object.keys(snap.files || {});
  for (const p of paths) {
    if (!/CheckCode/i.test(p)) continue;
    const parts = p.replace(/\\/g, "/").split("/").filter(Boolean);
    for (const seg of parts.slice(0, -1)) {
      if (seg.length < 4) continue;
      if (
        /^(src|app|application|commands|queries|handlers|services|domain|infrastructure)$/i.test(
          seg
        )
      ) {
        continue;
      }
      folders.add(seg);
    }
  }
  return folders;
}

function shapeBlobForRanking(query: UnitApproveQuery): string {
  // Module/Function/Title only — Steps/TestData must not drive path shape
  return [query.requirementTitle, query.module, query.title]
    .filter(Boolean)
    .join("\n");
}

/** Function + Title only — Module «tạo mới» must not force Create shape on child TCs. */
function functionTitleBlob(query: UnitApproveQuery): string {
  return [query.module, query.title]
    .filter(Boolean)
    .join("\n")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/** Create shape boosts only when Function/Title (or create intent class) imply create — not assign/filter. */
function queryImpliesCreateShape(query: UnitApproveQuery): boolean {
  const shapeBlob = shapeBlobForRanking(query);
  if (queryImpliesAssignFilterIntent(query.intent, shapeBlob)) return false;
  if (queryImpliesUploadIntent(query.intent, shapeBlob)) return false;
  const pc = query.intent.primaryClass;
  const classes = query.intent.classes || [];
  if (
    pc === "persist_create" ||
    pc === "auto_generate_code" ||
    pc === "validate_reject" ||
    classes.includes("persist_create") ||
    classes.includes("auto_generate_code")
  ) {
    return true;
  }
  return /tao\s*moi|\bcreate\b|them\s*moi|\badd\s*new\b/.test(
    functionTitleBlob(query)
  );
}

/** PascalCase stems from TC text that exist in index symbolIndex (never invent). */
function indexBackedTechStems(
  snap: CodeIndexSnapshot,
  tcBlob: string
): string[] {
  const stems = extractTechIdentifierStems(tcBlob);
  if (!stems.length) return [];
  const names = new Set<string>();
  for (const syms of Object.values(snap.symbolsByFile || {})) {
    for (const s of syms) {
      if (s?.name) names.add(s.name);
    }
  }
  if (!names.size) return [];
  return stems.filter((stem) => {
    const sl = stem.toLowerCase();
    if (sl.length < 4) return false;
    for (const name of names) {
      const nl = name.toLowerCase();
      if (nl === sl || nl.includes(sl)) return true;
    }
    return false;
  });
}

function rankHitToSeed(
  hit: RankedFileHit,
  query: UnitApproveQuery,
  checkCodeFolders: Set<string>,
  snap: CodeIndexSnapshot,
  indexPaths: string[]
): SeedCandidate {
  let score = hit.rankScore;
  const hits = [...(hit.reasons || [])];
  const p = hit.pathRel;
  const aliasDomain = matchingProjectAliasTokens(
    [query.requirementTitle, query.module, query.plan.module].filter(Boolean).join(" "),
    query.projectAliases
  );
  for (const t of aliasDomain.slice(0, 8)) {
    if (pathHitsDomainToken(p, t)) {
      score += 48;
      hits.push(`alias:${t}`);
    }
  }
  // Module (Studio) domain tokens — stronger than Function/title prefer
  for (const t of moduleGateTokens(query, indexPaths).slice(0, 10)) {
    if (pathHitsDomainToken(p, t)) {
      score += 56;
      hits.push(`moduleDoc:${t}`);
    }
  }
  // Function tokens — file rank inside Module family
  for (const t of extractMatchTokens(
    query.module || "",
    query.projectAliases,
    indexPaths
  ).slice(
    0,
    10
  )) {
    const tok = String(t || "").trim();
    if (tok.length < 4) continue;
    if (
      /^(Create|Update|Delete|Reject|Deny|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Code)$/i.test(
        tok
      )
    ) {
      continue;
    }
    if (pathHitsDomainToken(p, tok)) {
      score += 30;
      hits.push(`function:${tok}`);
    }
  }
  // Prefer strong tokens (Module/Title/alias) — not TestData noise
  const strongPrefer = query.preferTokensStrong?.length
    ? query.preferTokensStrong
    : query.preferTokens;
  for (const t of strongPrefer.slice(0, 12)) {
    const tok = String(t || "").trim();
    if (tok.length < 4) continue;
    if (
      /^(Create|Update|Delete|Reject|Deny|CheckCode|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Code)$/i.test(
        tok
      )
    ) {
      continue;
    }
    if (pathHitsDomainToken(p, tok)) {
      score += 40;
      hits.push(`prefer:${tok}`);
    }
  }
  if (!moduleImpliesPersonDomain(query) && isPersonFamilyPath(p)) {
    score -= 55;
    hits.push("shape:demotePersonFamily");
  }
  const modGate = moduleGateTokens(query, indexPaths);
  const funcGate = functionGateTokens(query, indexPaths);
  const modHit = modGate.some((t) => pathHitsDomainToken(p, t));
  const funcHit = funcGate.some((t) => pathHitsDomainToken(p, t));
  if (modHit && funcHit) {
    score += 54;
    hits.push("shape:moduleFunctionIntersect");
  }
  const tech = indexBackedTechStems(snap, query.tcBlob);
  for (const t of tech.slice(0, 10)) {
    if (pathHitsDomainToken(p, t)) {
      score += 34;
      hits.push(`tech:${t}`);
    }
  }
  const shapeBlob = shapeBlobForRanking(query);
  score += uploadIntentPathShapeAdjust(p, query.intent, shapeBlob);
  score += functionOpPathShapeAdjust(p, query.intent, shapeBlob);
  score += validateRejectPathShapeAdjust(p, query.intent, shapeBlob);
  // Op prefer tokens (storage/authz/…) — boost path hits; demote miss when op locked
  const opPrefer = extractOpPreferTokens(query.intent, shapeBlob);
  if (opPrefer.length) {
    const opHits = countPreferTokenHits(p, opPrefer);
    if (opHits > 0) {
      score += opHits * 36;
      hits.push(`opPrefer:${opPrefer.filter((t) => pathHitsDomainToken(p, t)).slice(0, 2).join(",")}`);
    } else if (pathContradictsOpPreferTokens(p, opPrefer)) {
      score -= 42;
      hits.push("opPrefer:miss");
    }
  }
  score += unitPathBonus(p);
  const uploadish = queryImpliesUploadIntent(query.intent, shapeBlob);
  const createShape = queryImpliesCreateShape(query);
  if (
    !uploadish &&
    createShape &&
    /Create(Command)?Handler/i.test(p)
  ) {
    score += 16;
    hits.push("shape:CreatePrimary");
  }
  if (
    !uploadish &&
    createShape &&
    /(Update|Delete)(Command)?Handler/i.test(p) &&
    !/Create/i.test(p)
  ) {
    score -= 24;
    hits.push("shape:demoteUpdateDelete");
  }
  if (
    createShape &&
    /Create(Command)?Handler/i.test(p) &&
    checkCodeFolders.size > 0 &&
    [...checkCodeFolders].some((seg) => pathHitsToken(p, seg))
  ) {
    score += 42;
    hits.push("shape:CheckCodeFolderCreate");
  }
  if (query.codeFieldCreate && isSignedUrlOrTokenGeneratePath(p)) {
    score -= 30;
    hits.push("shape:demoteUrlToken");
  }
  return {
    pathRel: p,
    score,
    hits: uniq(hits),
    reason: hits.slice(0, 6).join(", ") || "retrieve",
  };
}

/**
 * Module gate tokens — Studio Module (`requirementTitle`) locks source-module family.
 * Function (`query.module`) is not the hard gate (used for file rank / discover).
 * Portable: exclude IT verb noise (Check⊂CheckCode).
 */
function moduleGateTokens(
  query: UnitApproveQuery,
  indexPaths?: string[]
): string[] {
  const weak =
    /^(Create|Update|Delete|Reject|Deny|CheckCode|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Save|Get|List|Query|Command|Handler|Service|Assert|Error|Code|RejectDenyCreate|CreateDenyReject|Assign|Filter|Permission|Authorization|Role|User|Account)$/i;
  // Joined IT verb compounds (CreateAddNew) never hit Latin paths — pollute gate.
  const joinedIt =
    /^(?:Create|Update|Delete|Add|New|Save|Get|List|Query|Check|Reject|Deny|Edit|Assign|Filter){2,}$/i;
  const fromModuleDoc = extractMatchTokens(
    query.requirementTitle || "",
    query.projectAliases,
    indexPaths
  );
  const aliasDomain = matchingProjectAliasTokens(
    query.requirementTitle || "",
    query.projectAliases
  );
  // Gate on Module (Studio) + its project aliases only — Function/Title rank later
  return uniq(
    [...aliasDomain, ...fromModuleDoc]
      .map((t) => String(t || "").trim())
      .filter((t) => t.length >= 4 && !weak.test(t) && !joinedIt.test(t))
  ).slice(0, 16);
}

/**
 * Function gate tokens — TC Function (`query.module`) narrows inside Module family.
 * Portable: exclude IT verb noise; include project alias hits on Function text only.
 */
function functionGateTokens(
  query: UnitApproveQuery,
  indexPaths?: string[]
): string[] {
  const weak =
    /^(Create|Update|Delete|Reject|Deny|CheckCode|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Save|Get|List|Query|Command|Handler|Service|Assert|Error|Code|RejectDenyCreate|CreateDenyReject|Assign|Filter|Permission|Authorization|Role|User|Account|Upload|Download)$/i;
  const joinedIt =
    /^(?:Create|Update|Delete|Add|New|Save|Get|List|Query|Check|Reject|Deny|Edit|Assign|Filter|Upload|Download){2,}$/i;
  const fromFunction = extractMatchTokens(
    query.module || "",
    query.projectAliases,
    indexPaths
  );
  const aliasFromFunction = matchingProjectAliasTokens(
    query.module || "",
    query.projectAliases
  );
  const intentFeats = (query.intent.classFeatureTokens || []).filter(
    (t) => t.length >= 4
  );
  return uniq(
    [...aliasFromFunction, ...fromFunction, ...intentFeats]
      .map((t) => String(t || "").trim())
      .filter((t) => t.length >= 4 && !weak.test(t) && !joinedIt.test(t))
  ).slice(0, 16);
}

/** Function + Title tokens for feature-folder / file discover inside Module scope. */
function titleTokensForDiscover(
  query: UnitApproveQuery,
  indexPaths?: string[]
): string[] {
  // Do not pass indexPaths into extractMatchTokens here — index stem expand
  // pulls CasePersonHandlersTest / PersonHandlersTest and false-fires Person cues.
  void indexPaths;
  return uniq(
    [
      query.module || "",
      query.title || "",
      query.requirementTitle || "",
      ...extractMatchTokens(query.module || "", query.projectAliases),
      ...extractMatchTokens(query.title || "", query.projectAliases),
      ...extractMatchTokens(query.requirementTitle || "", query.projectAliases),
      ...extractTechIdentifierStems(query.tcBlob),
      ...(query.preferTokens || []),
    ].filter((t) => !/Test$/i.test(t) && !/HandlersTest/i.test(t))
  ).slice(0, 32);
}

/** Person/auth IT stems — demote when Module text is not about users/parties. */
function moduleImpliesPersonDomain(query: UnitApproveQuery): boolean {
  const blob = [query.requirementTitle, query.module]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /nguoi\s*(dung|so\s*huu|su\s*dung|lien\s*quan)|user|account|login|auth|phan\s*quyen|permission|role|\bowner\b|\bperson\b/.test(
    blob
  );
}

function isPersonFamilyPath(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/");
  return (
    /\/(User|Account|Auth|Authentication|Permission|Role)s?\//i.test(p) ||
    /\/[^/]*Person[^/]*\//i.test(p) ||
    /(?:^|\/)(User|Account)[A-Z][A-Za-z]*(Command|Query)?Handler/i.test(p) ||
    /(?:^|\/)\w*Person\w*(Command|Query)?Handler/i.test(p)
  );
}

/** Keep only gate tokens that hit ≥1 path in the index (drop VI stems with no Latin hit). */
function gateTokensHittingPaths(
  gateTokens: string[],
  paths: string[]
): string[] {
  if (!gateTokens.length || !paths.length) return [];
  return gateTokens.filter((t) =>
    paths.some((p) => pathHitsDomainToken(p, t))
  );
}

/**
 * Module/alias gate — prefer hit tokens; miss is handled by caller (discover fallthrough).
 */
function applyModulePreferGate<T extends { pathRel: string; score: number }>(
  candidates: T[],
  gateTokens: string[]
): { candidates: T[]; gated: boolean; miss: boolean } {
  if (!candidates.length || !gateTokens.length) {
    return { candidates, gated: false, miss: false };
  }
  const hit = candidates.filter((c) =>
    gateTokens.some((t) => pathHitsDomainToken(c.pathRel, t))
  );
  if (!hit.length) return { candidates: [], gated: false, miss: true };
  return { candidates: hit, gated: true, miss: false };
}

/**
 * Lock candidates to feature folders discovered from title/intent bridges
 * (and optional CheckCode folders for code-field create).
 */
function applyFeatureFolderDiscover<T extends { pathRel: string; score: number }>(
  candidates: T[],
  codeIndex: CodeIndexSnapshot,
  pathPool: string[],
  query: UnitApproveQuery,
  checkCodeFolders: Set<string>,
  notes: string[],
  indexPaths: string[]
): {
  candidates: T[];
  familyTokens: string[];
  gated: boolean;
  skipReason?: string;
} {
  const discovered = discoverFeatureFoldersFromIndex(codeIndex, pathPool, {
    intent: query.intent,
    titleTokens: titleTokensForDiscover(query, indexPaths),
  });
  let featureTokens = [...discovered.featureTokens];
  // Widen with folders that host CheckCode* — uniqueness/create-code and soft create
  // on VI modules (no Latin gate) lock the same family as *CheckCode* handlers.
  const blob = query.tcBlob || "";
  const widenCheckCode =
    query.codeFieldCreate ||
    query.intent.primaryClass === "persist_create" ||
    (query.intent.classes || []).includes("persist_create") ||
    /checkcode|duplicate|alreadyexist|trung|validator|maxlength|kiem\s*tra\s*ma|tu\s*choi/i.test(
      blob
    );
  if (widenCheckCode) {
    for (const seg of checkCodeFolders) {
      if (seg && !featureTokens.some((t) => t.toLowerCase() === seg.toLowerCase())) {
        featureTokens.push(seg);
      }
    }
  }
  // Multiple CheckCode folders: prefer *Create*Handler hosts; demote *Record$ twins
  // when title is not a case-dossier flow (portable — no product folder nouns).
  const discoverBlob = titleTokensForDiscover(query, indexPaths)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const caseDossierCue =
    /ho\s*so|vu\s*an|dossier|case\s*record|case\s*file/.test(discoverBlob);
  if (!caseDossierCue && featureTokens.length > 1) {
    const pool = [...pathPool, ...indexPaths];
    const withCreate = featureTokens.filter((t) =>
      pool.some(
        (p) =>
          pathHitsDomainToken(p, t) && /Create(Command)?Handler/i.test(p)
      )
    );
    let next = withCreate.length ? withCreate : featureTokens;
    const nonRecord = next.filter((t) => !/Record$/i.test(t));
    if (nonRecord.length && nonRecord.length < next.length) {
      next = nonRecord;
      notes.push("demoteRecordFolderVsCreate");
    }
    featureTokens = next;
  }
  // Drop *.Application host segments mistaken as feature folders from CheckCode widen
  featureTokens = featureTokens.filter((t) => !/\.Application$/i.test(t));
  if (!featureTokens.length) {
    return { candidates, familyTokens: [], gated: false };
  }
  const foldered = filterCandidatesByFeatureFolders(candidates, featureTokens);
  if (foldered.filtered && !foldered.candidates.length) {
    return {
      candidates,
      familyTokens: featureTokens,
      gated: false,
      skipReason: `featureFolder miss — folders «${featureTokens.slice(0, 4).join(",")}»`,
    };
  }
  if (foldered.filtered && foldered.candidates.length) {
    notes.push(`featureFolders=${featureTokens.slice(0, 6).join(",")}`);
    return {
      candidates: foldered.candidates,
      familyTokens: featureTokens,
      gated: true,
    };
  }
  return { candidates, familyTokens: featureTokens, gated: false };
}

function relatedFromDeps(
  snap: CodeIndexSnapshot,
  primary: string,
  preferTokens: string[],
  maxRelated = 4,
  preferDtoValidator = false
): string[] {
  const graph = snap.dependencyGraph || {};
  const deps = graph[primary] || [];
  const known = new Set(Object.keys(snap.files || {}));
  const fromGraph: string[] = [];
  for (const spec of deps) {
    const cand = String(spec || "").replace(/\\/g, "/");
    if (known.has(cand) && cand !== primary) {
      fromGraph.push(cand);
      continue;
    }
    const resolved = resolveImportSpecifier(primary, cand, known, {
      symbolIndex: snap.symbolIndex,
    });
    if (resolved && known.has(resolved) && resolved !== primary) {
      fromGraph.push(resolved);
    }
  }
  const expanded = expandUnitRelatedPaths({
    entryPathRel: primary,
    allPaths: Object.keys(snap.files || {}),
    featureTokens: preferTokens,
    maxRelated,
    preferDtoValidator,
  });
  if (fromGraph.length) {
    return uniq([...expanded, ...fromGraph]).slice(0, maxRelated);
  }
  return expanded;
}

/** VALIDATION / AUTH / layerHint dto|validator|authz → DTO/Validator siblings. */
function preferDtoValidatorForIntent(
  intent: UnitIntent,
  testData?: string | null
): boolean {
  return preferDtoValidatorForHints(intent, testData);
}

function applyLayerHintToWriteBack(
  codeIndex: CodeIndexSnapshot,
  query: UnitApproveQuery,
  seed: SeedCandidate,
  relatedPaths: string[],
  symbol: string | null,
  notes: string[]
): { seed: SeedCandidate; relatedPaths: string[]; symbol: string | null } {
  const applied = applyLayerHintPrimaryPromotion({
    testData: query.testData || null,
    primaryPath: seed.pathRel,
    relatedPaths,
    allPaths: Object.keys(codeIndex.files || {}),
    featureTokens: query.preferTokensStrong,
  });
  if (!applied.promoted) {
    return { seed, relatedPaths, symbol };
  }
  notes.push(`layerHintPromote=${applied.primaryPath.split("/").pop()}`);
  const nextSym =
    preferredSymbolFromCodeIndex(
      codeIndex,
      applied.primaryPath,
      query.preferTokensStrong
    ) ||
    applied.primaryPath.split("/").pop()?.replace(/\.[^.]+$/, "") ||
    symbol;
  return {
    seed: {
      ...seed,
      pathRel: applied.primaryPath,
      reason: `${seed.reason || "seed"}+layerHint`,
      hits: [...(seed.hits || []), "layerHint-promote"],
    },
    relatedPaths: applied.relatedPaths,
    symbol: nextSym,
  };
}

async function tryLlmShortlistPick(
  opts: ResolveUnitPrimaryOpts,
  candidates: SeedCandidate[],
  notes: string[],
  skipReason: string,
  softGateTokens?: string[] | null
): Promise<ResolveUnitPrimaryResult | null> {
  const pickFn = opts.pickFromShortlist;
  if (!pickFn || !candidates.length) return null;
  // Skip network when deterministic refuse cannot be saved by shortlist pick
  const skipLower = skipReason.toLowerCase();
  if (
    skipLower.includes("no candidates") ||
    skipLower.startsWith("fail_soft_no_domain")
  ) {
    notes.push(`llmPick=skip prior=${skipReason.slice(0, 80)}`);
    return null;
  }
  const shortlist = candidates.slice(0, 8).map((c) => ({
    pathRel: c.pathRel,
    code:
      preferredSymbolFromCodeIndex(opts.codeIndex, c.pathRel, opts.query.preferTokensStrong) ||
      undefined,
    score: c.score,
  }));
  const input: LlmPickUnitPrimaryInput = {
    projectId: opts.llmPromptFields?.projectId,
    requirementTitle: opts.query.requirementTitle,
    module: opts.query.module,
    title: opts.query.title,
    steps: opts.llmPromptFields?.steps,
    expectedResult: opts.llmPromptFields?.expectedResult,
    shortlist,
  };
  let picked: LlmPickUnitPrimaryResult | null = null;
  try {
    picked = await pickFn(input);
  } catch {
    picked = null;
  }
  if (!picked) {
    notes.push(`llmPick=refuse prior=${skipReason.slice(0, 80)}`);
    return null;
  }
  const accepted = acceptShortlistPick(
    {
      path: picked.pathRel,
      code: picked.code,
      confidence: picked.confidence,
    },
    shortlist
  );
  if (!accepted) {
    notes.push("llmPick=rejected-not-in-shortlist");
    return null;
  }
  // Same soft infra refuse as deterministic writeBack (Auth/Mail/URL…)
  const softGate = uniq([
    ...(softGateTokens || []),
    ...(opts.query.preferTokensStrong || []),
    ...matchingProjectAliasTokens(
      [opts.query.requirementTitle, opts.query.module].filter(Boolean).join(" "),
      opts.query.projectAliases
    ),
  ]);
  if (softCrossCuttingDenied(accepted.pathRel, softGate)) {
    notes.push(
      `llmPick=FAIL_SOFT_CROSS_CUTTING ${accepted.pathRel.split("/").pop()}`
    );
    return null;
  }
  const seed: SeedCandidate = {
    pathRel: accepted.pathRel,
    score: Math.max(80, candidates[0]?.score || 80),
    hits: [`llm:${accepted.confidence}`],
    reason: `llm-shortlist conf=${accepted.confidence}`,
  };
  notes.push(`llmPick=${accepted.pathRel.split("/").pop()}`);
  const symbol =
    accepted.code ||
    preferredSymbolFromCodeIndex(
      opts.codeIndex,
      accepted.pathRel,
      opts.query.preferTokensStrong
    );
  const relatedPaths = relatedFromDeps(
    opts.codeIndex,
    accepted.pathRel,
    opts.query.preferTokensStrong,
    4,
    preferDtoValidatorForIntent(opts.query.intent, opts.query.testData)
  );
  const finalized = applyLayerHintToWriteBack(
    opts.codeIndex,
    opts.query,
    seed,
    relatedPaths,
    symbol,
    notes
  );
  return {
    writeBack: true,
    seed: finalized.seed,
    symbol: finalized.symbol,
    relatedPaths: finalized.relatedPaths,
    candidatesTop3: candidates.slice(0, 3).map((c) => ({
      pathRel: c.pathRel,
      score: c.score,
      ruleHits: [],
    })),
    bodyRuleLog: `writeBack=yes source=llm-shortlist conf=${accepted.confidence}`,
    notes,
    source: "llm-shortlist",
  };
}

/**
 * Full Approve resolve: retrieve → rank → (body-rule read) → symbol → related.
 * Ungated/ambiguous → optional grounded LLM pick among Top-K index paths.
 */
export async function resolveUnitPrimaryFromIndex(
  opts: ResolveUnitPrimaryOpts
): Promise<ResolveUnitPrimaryResult> {
  const { codeIndex, query, readExcerpt } = opts;
  const notes: string[] = [];
  const topK = opts.topK ?? (query.requiresBodyRule ? 24 : 16);
  const strongPrefer = query.preferTokensStrong?.length
    ? query.preferTokensStrong
    : query.preferTokens;
  // Always scan CheckCode* folders for VI-module family lock; pathPool widen stays opt-in.
  const checkCodeFolders = discoverCheckCodeFolders(codeIndex);
  const allIndexPaths = Object.keys(codeIndex.files || {});

  const retrieved = retrieveUnitSources(codeIndex, query.plan, { topK });
  notes.push(...retrieved.notes);

  let pathPool = retrieved.files.map((f) => f.pathRel);
  const persistCreate =
    query.codeFieldCreate ||
    query.intent.primaryClass === "persist_create" ||
    (query.intent.classes || []).includes("persist_create");
  if (persistCreate && checkCodeFolders.size) {
    const all = Object.keys(codeIndex.files || {}).filter(
      (p) => !isExcludedFromUnitRetrieve(p)
    );
    const widened = all.filter((p) =>
      [...checkCodeFolders].some((seg) => pathHitsToken(p, seg))
    );
    pathPool = uniq([...pathPool, ...widened]);
    notes.push(`checkCodeFolders=${[...checkCodeFolders].slice(0, 6).join(",")}`);
  }
  if (opts.fallbackPaths?.length) {
    pathPool = uniq([...pathPool, ...opts.fallbackPaths]);
  }

  pathPool = filterUnitLogicLayerPaths(pathPool);
  const byPath = new Map(retrieved.files.map((f) => [f.pathRel, f]));
  const seeds: SeedCandidate[] = [];
  for (const p of pathPool) {
    const hit =
      byPath.get(p) ||
      ({
        pathRel: p,
        rankScore: unitPathBonus(p) + 10,
        reasons: ["widen"],
      } satisfies RankedFileHit);
    const seed = rankHitToSeed(hit, query, checkCodeFolders, codeIndex, allIndexPaths);
    if (seed.score < 8) continue;
    if (isUnsuitableUnitPrimary(seed.pathRel)) continue;
    seeds.push(seed);
  }

  let candidates = filterUnitLogicLayerCandidates(seeds, {
    tcText: query.tcBlob,
  }).sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));

  // Alias hard filter when project aliases present
  const aliasDomain = matchingProjectAliasTokens(
    [query.requirementTitle, query.module].filter(Boolean).join(" "),
    query.projectAliases
  );
  if (aliasDomain.length) {
    const hit = candidates.filter((c) =>
      aliasDomain.some((t) => pathHitsDomainToken(c.pathRel, t))
    );
    if (hit.length) candidates = hit;
  }

  const intent: UnitIntent = query.intent;

  // Progressive Module gate, then Function narrows inside that family.
  let moduleGated = false;
  let familyGateTokens = moduleGateTokens(query, allIndexPaths);
  const llmSoftGate = () =>
    uniq([
      ...familyGateTokens,
      ...moduleGateTokens(query, allIndexPaths),
      ...aliasDomain,
      ...strongPrefer,
    ]);
  const indexPaths = allIndexPaths;
  const hittingGate = gateTokensHittingPaths(familyGateTokens, [
    ...pathPool,
    ...indexPaths,
  ]);

  if (hittingGate.length) {
    const gated = applyModulePreferGate(candidates, hittingGate);
    if (!gated.miss) {
      candidates = gated.candidates;
      moduleGated = gated.gated;
      familyGateTokens = hittingGate;
      if (gated.gated) {
        notes.push(`moduleGate=${hittingGate.slice(0, 4).join(",")}`);
      }
    } else {
      const locked = applyFeatureFolderDiscover(
        candidates,
        codeIndex,
        pathPool,
        query,
        checkCodeFolders,
        notes,
        allIndexPaths
      );
      if (locked.skipReason) {
        const llm = await tryLlmShortlistPick(
          opts,
          candidates,
          notes,
          locked.skipReason,
          llmSoftGate()
        );
        if (llm) return llm;
        return {
          writeBack: false,
          seed: null,
          symbol: null,
          relatedPaths: [],
          candidatesTop3: candidates.slice(0, 3).map((c) => ({
            pathRel: c.pathRel,
            score: c.score,
            ruleHits: [],
          })),
          skipReason: locked.skipReason,
          notes,
          source: "index.db",
        };
      }
      if (locked.gated) {
        candidates = locked.candidates;
        moduleGated = true;
        familyGateTokens = locked.familyTokens;
      } else {
        const skip = `moduleGate miss — no path hit for «${hittingGate.slice(0, 4).join(",")}»`;
        const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
        if (llm) return llm;
        return {
          writeBack: false,
          seed: null,
          symbol: null,
          relatedPaths: [],
          candidatesTop3: candidates.slice(0, 3).map((c) => ({
            pathRel: c.pathRel,
            score: c.score,
            ruleHits: [],
          })),
          skipReason: skip,
          notes,
          source: "index.db",
        };
      }
    }
  } else {
    const locked = applyFeatureFolderDiscover(
      candidates,
      codeIndex,
      pathPool,
      query,
      checkCodeFolders,
      notes,
      allIndexPaths
    );
    if (locked.skipReason) {
      const llm = await tryLlmShortlistPick(
        opts,
        candidates,
        notes,
        locked.skipReason,
        llmSoftGate()
      );
      if (llm) return llm;
      return {
        writeBack: false,
        seed: null,
        symbol: null,
        relatedPaths: [],
        candidatesTop3: candidates.slice(0, 3).map((c) => ({
          pathRel: c.pathRel,
          score: c.score,
          ruleHits: [],
        })),
        skipReason: locked.skipReason,
        notes,
        source: "index.db",
      };
    }
    if (locked.gated) {
      candidates = locked.candidates;
      moduleGated = true;
      familyGateTokens = locked.familyTokens;
    } else {
      // VI Module with no Latin gate and no feature-folder lock — fail-closed
      // (do not soft-latch Create* / User* / CasePerson*). LLM may still pick.
      const skip =
        familyGateTokens.length
          ? `moduleGate miss — no path hit for «${familyGateTokens.slice(0, 4).join(",")}»`
          : "FAIL_UNGATED — Module family not locked (no alias/Latin gate / feature-folder)";
      const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
      if (llm) return llm;
      return {
        writeBack: false,
        seed: null,
        symbol: null,
        relatedPaths: [],
        candidatesTop3: candidates.slice(0, 3).map((c) => ({
          pathRel: c.pathRel,
          score: c.score,
          ruleHits: [],
        })),
        skipReason: skip,
        notes,
        source: "index.db",
      };
    }
  }

  // Function gate — soft narrow when Function/alias tokens hit paths (Module ∩ Function).
  const funcGateRaw = functionGateTokens(query, allIndexPaths);
  const funcHitting = gateTokensHittingPaths(funcGateRaw, [
    ...pathPool,
    ...indexPaths,
  ]);
  if (funcHitting.length && candidates.length) {
    const funcGated = applyModulePreferGate(candidates, funcHitting);
    if (!funcGated.miss && funcGated.candidates.length) {
      candidates = funcGated.candidates;
      if (funcGated.gated) {
        notes.push(`functionGate=${funcHitting.slice(0, 4).join(",")}`);
      }
    }
  }

  if (!candidates.length) {
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: [],
      skipReason: "no candidates after retrieve + logic-layer filter",
      notes,
      source: "index.db",
    };
  }

  // Module not about users → drop User/Account Create latch from permission/userId cues
  if (!moduleImpliesPersonDomain(query)) {
    const nonPerson = candidates.filter((c) => !isPersonFamilyPath(c.pathRel));
    if (nonPerson.length) {
      candidates = nonPerson;
      notes.push("demotePersonFamily");
    }
  }
  candidates = candidates
    .slice()
    .sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));

  // Prefer *CommandHandler over anemic *Command DTOs inside locked family
  if (moduleGated) {
    candidates = candidates
      .map((c) => {
        let score = c.score;
        if (/CommandHandler\.(cs|ts|js)$/i.test(c.pathRel)) score += 36;
        else if (
          /Command\.(cs|ts|js)$/i.test(c.pathRel) &&
          !/Handler/i.test(c.pathRel)
        ) {
          score -= 20;
        }
        if (
          /Unassign|SoftDelete|DeleteCommand/i.test(c.pathRel) &&
          !/huy|xoa|unassign|delete|remove/i.test(
            [query.title, query.module].join("\n")
          )
        ) {
          score -= 25;
        }
        return score === c.score ? c : { ...c, score, hits: [...(c.hits || []), "shape:handlerPrefer"] };
      })
      .sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
  }

  // Skip body-rule I/O when family locked + clear CreateHandler margin (persist soft create)
  const skipBodyRule =
    moduleGated &&
    !intent.requiresBodyRule &&
    !query.codeFieldCreate &&
    queryImpliesCreateShape(query) &&
    (() => {
      const best = candidates[0];
      const second = candidates[1];
      if (!best || !/Create(Command)?Handler/i.test(best.pathRel)) return false;
      if (!second) return true;
      return (
        best.score - second.score >= SOFT_MARGIN ||
        best.score >= second.score * SOFT_RATIO
      );
    })();
  if (skipBodyRule) {
    notes.push("skipBodyRule=lockedCreateMargin");
  }

  if (
    readExcerpt &&
    !skipBodyRule &&
    (intent.requiresBodyRule || intent.codePatterns.length > 0)
  ) {
    const open = orderCandidatesForBodyRuleOpen(
      candidates,
      intent,
      UNIT_BODY_RULE.topN
    );
    // Parallel excerpt reads
    const excerpts = await Promise.all(
      open.map(async (c) => {
        try {
          return clipBodyExcerpt(await readExcerpt(c.pathRel));
        } catch {
          return "";
        }
      })
    );
    const rescored: BodyRuleScoredCandidate[] = open.map((c, i) => {
      const scored = applyBodyRuleToCandidate(
        c,
        excerpts[i] || "",
        intent,
        query.tcBlob,
        { preferTokens: strongPrefer }
      );
      // Demote ultra-generic ruleHits when they are the only hits (cross-domain latch)
      const onlyGeneric =
        scored.ruleHits.length > 0 &&
        scored.ruleHits.every((h) =>
          /isnullorwhitespace|isnullorempty|isempty|throw|badrequest|validate|exists/i.test(
            h
          )
        );
      if (onlyGeneric && moduleGated) {
        // Keep mild boost inside locked family only
        scored.score = Math.max(
          scored.baseScore,
          scored.baseScore + Math.min(12, scored.ruleHits.length * 4)
        );
      } else if (onlyGeneric && !moduleGated) {
        scored.score = scored.baseScore;
        scored.ruleHits = [];
      }
      const preferHits = countPreferTokenHits(scored.pathRel, strongPrefer);
      if (preferHits > 0) {
        scored.score += preferHits * 40;
        scored.hits = uniq([
          ...(scored.hits || []),
          ...strongPrefer
            .filter((t) => pathHitsDomainToken(scored.pathRel, t))
            .slice(0, 3)
            .map((t) => `prefer:${t}`),
        ]);
      }
      return scored;
    });
    rescored.sort(
      (a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel)
    );

    const marginOpts = intent.requiresBodyRule
      ? { minScore: MIN_SCORE, minMargin: MIN_MARGIN, minRatio: MIN_RATIO }
      : {
          minScore: MIN_SCORE,
          minMargin: SOFT_MARGIN,
          minRatio: SOFT_RATIO,
        };
    let decision = decideBodyRuleWriteBack(rescored, intent, {
      ...marginOpts,
      preferTokens: strongPrefer,
    });
    let seed = decision.seed;

    const signalBits = uniq([
      ...(moduleGated ? ["moduleGate"] : []),
      ...(aliasDomain.length ? ["alias"] : []),
      ...(seed?.hits || [])
        .map((h) => String(h).split(":")[0] || "")
        .filter((s) => /^(prefer|phrase|tech|alias|techStem)$/i.test(s)),
    ]);
    const signalsNote =
      signalBits.length > 0 ? ` signals=${signalBits.join("|")}` : "";

    if (
      seed &&
      tcImpliesBehaviorPrimary(query.tcBlob) &&
      isAnemicEntityLikePath(seed.pathRel) &&
      // layerHint dto|validator — DTO/Validator IS the enforce site
      !preferDtoValidatorForHints(intent, query.testData)
    ) {
      const next = collapseBodyRuleContenders(rescored).find(
        (c) =>
          c.ruleHits.length >= 1 &&
          !isAnemicEntityLikePath(c.pathRel) &&
          !isUnsuitableUnitPrimary(c.pathRel)
      );
      if (next && next.score >= MIN_SCORE) {
        seed = next;
        decision = {
          writeBack: true,
          seed: next,
          candidatesTop3: decision.candidatesTop3,
        };
      } else {
        seed = null;
        decision = {
          writeBack: false,
          seed: null,
          skipReason: `behavior TC — refusing entity/POCO primary`,
          candidatesTop3: decision.candidatesTop3,
        };
      }
    }

    if ((!decision.writeBack || !seed) && !intent.requiresBodyRule) {
      const collapsed = collapseBodyRuleContenders(rescored);
      const best = collapsed[0];
      const second = collapsed[1];
      if (best && best.score >= MIN_SCORE) {
        const margin = second ? best.score - second.score : MIN_MARGIN;
        const ratioOk = second
          ? best.score >= second.score * SOFT_RATIO
          : true;
        if (!second || margin >= SOFT_MARGIN || ratioOk) {
          // Soft writeBack: Module-gated AND domain/prefer signal (no ungated Create latch)
          if (!moduleGated) {
            decision = {
              writeBack: false,
              seed: null,
              skipReason:
                "FAIL_UNGATED — soft writeBack needs Module/feature-folder lock",
              candidatesTop3: decision.candidatesTop3,
            };
            seed = null;
          } else if (
            hasStrongWriteBackSignal({
              pathRel: best.pathRel,
              ruleHits: best.ruleHits,
              hits: best.hits,
              preferTokens: strongPrefer,
            })
          ) {
            seed = best;
            decision = {
              writeBack: true,
              seed: best,
              candidatesTop3: decision.candidatesTop3,
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

    // Body-rule miss but progressive Module→Function→Title already locked a Handler:
    // same-family CreateHandler + preferTokens (Image/…) → soft writeBack (portable).
    if (
      (!decision.writeBack || !seed) &&
      intent.requiresBodyRule &&
      moduleGated &&
      /no pattern hits/i.test(decision.skipReason || "")
    ) {
      const collapsed = collapseBodyRuleContenders(rescored).filter(
        (c) =>
          !isAnemicEntityLikePath(c.pathRel) &&
          !isUnsuitableUnitPrimary(c.pathRel)
      );
      const best = collapsed[0];
      const second = collapsed[1];
      if (best && best.score >= MIN_SCORE && /Handler/i.test(best.pathRel)) {
        const famBest = featureFolderSegmentFromPath(best.pathRel);
        const famSecond = second
          ? featureFolderSegmentFromPath(second.pathRel)
          : null;
        const sameFamily =
          Boolean(famBest) &&
          (!second ||
            (Boolean(famSecond) &&
              famBest!.toLowerCase() === famSecond!.toLowerCase()));
        const preferOk = hasStrongWriteBackSignal({
          pathRel: best.pathRel,
          ruleHits: best.ruleHits,
          hits: best.hits,
          preferTokens: strongPrefer,
        });
        const preferDiff =
          countPreferTokenHits(best.pathRel, strongPrefer) -
          (second
            ? countPreferTokenHits(second.pathRel, strongPrefer)
            : 0);
        if (
          preferOk &&
          (sameFamily || preferDiff > 0) &&
          !pathContradictsOpPreferTokens(
            best.pathRel,
            extractOpPreferTokens(intent, shapeBlobForRanking(query))
          )
        ) {
          seed = best;
          decision = {
            writeBack: true,
            seed: best,
            candidatesTop3: decision.candidatesTop3,
          };
          notes.push("bodyRuleMissSameFamilyPrefer");
        } else if (
          pathContradictsOpPreferTokens(
            best.pathRel,
            extractOpPreferTokens(intent, shapeBlobForRanking(query))
          )
        ) {
          notes.push("bodyRuleMissOpContradict");
        }
      }
    }

    // Op-token latch: Title/Function storage|authz must hit path — refuse AssignCase on storage TCs
    if (decision.writeBack && seed) {
      const opPrefer = extractOpPreferTokens(
        intent,
        shapeBlobForRanking(query)
      );
      if (pathContradictsOpPreferTokens(seed.pathRel, opPrefer)) {
        const alt = collapseBodyRuleContenders(rescored).find(
          (c) =>
            c.score >= MIN_SCORE &&
            !pathContradictsOpPreferTokens(c.pathRel, opPrefer) &&
            !isAnemicEntityLikePath(c.pathRel) &&
            !isUnsuitableUnitPrimary(c.pathRel)
        );
        if (alt) {
          seed = alt;
          decision = {
            writeBack: true,
            seed: alt,
            candidatesTop3: decision.candidatesTop3,
          };
          notes.push("opPreferRerankBody");
        } else {
          decision = {
            writeBack: false,
            seed: null,
            skipReason: `FAIL_OP_CONTRADICT — path misses op tokens «${opPrefer.slice(0, 4).join(",")}»`,
            candidatesTop3: decision.candidatesTop3,
          };
          seed = null;
          notes.push("opPreferContradict");
        }
      }
    }

    // Soft writeBack must stay Module-gated (alias/VI discover family lock)
    if (decision.writeBack && seed && !intent.requiresBodyRule && !moduleGated) {
      decision = {
        writeBack: false,
        seed: null,
        skipReason:
          "FAIL_UNGATED — soft writeBack needs Module/feature-folder lock",
        candidatesTop3: decision.candidatesTop3,
      };
      seed = null;
    }

    if (decision.writeBack && seed && !intent.requiresBodyRule) {
      const softGate = uniq([
        ...familyGateTokens,
        ...moduleGateTokens(query, allIndexPaths),
        ...aliasDomain,
        ...strongPrefer,
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

    if (!decision.writeBack || !seed) {
      const skip = decision.skipReason || "body-rule / margin fail-closed";
      const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
      if (llm) return llm;
      return {
        writeBack: false,
        seed: null,
        symbol: null,
        relatedPaths: [],
        candidatesTop3: decision.candidatesTop3,
        skipReason: skip,
        bodyRuleLog: `writeBack=no skip=${skip}${signalsNote} intent=${intent.primaryClass || "-"}`,
        notes,
        source: "index.db",
      };
    }

    const symbol = preferredSymbolFromCodeIndex(
      codeIndex,
      seed.pathRel,
      [...strongPrefer, ...(seed.ruleHits || [])]
    );
    const relatedPaths = relatedFromDeps(
      codeIndex,
      seed.pathRel,
      strongPrefer,
      4,
      preferDtoValidatorForIntent(intent, query.testData)
    );
    const finalized = applyLayerHintToWriteBack(
      codeIndex,
      query,
      seed as SeedCandidate,
      relatedPaths,
      symbol,
      notes
    );
    return {
      writeBack: true,
      seed: finalized.seed as ResolvedSeed,
      symbol: finalized.symbol,
      relatedPaths: finalized.relatedPaths,
      candidatesTop3: decision.candidatesTop3,
      bodyRuleLog: `writeBack=yes score=${finalized.seed.score} ruleHits=${(seed.ruleHits || []).join(",")} intent=${intent.primaryClass || "-"}${signalsNote}`,
      notes,
      source: "index.db",
    };
  }

  // No excerpt reader (or skipped body-rule): soft pick from ranked seeds — Module-gated only
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.score < MIN_SCORE) {
    const skip = "score below min without body excerpt";
    const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
    if (llm) return llm;
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        ruleHits: [],
      })),
      skipReason: skip,
      notes,
      source: "index.db",
    };
  }
  if (intent.requiresBodyRule && !skipBodyRule) {
    const skip = "body-rule required but no readExcerpt";
    const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
    if (llm) return llm;
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        ruleHits: [],
      })),
      skipReason: skip,
      notes,
      source: "index.db",
    };
  }
  if (second) {
    const margin = best.score - second.score;
    if (margin < SOFT_MARGIN && best.score < second.score * SOFT_RATIO) {
      const famBest = featureFolderSegmentFromPath(best.pathRel);
      const famSecond = featureFolderSegmentFromPath(second.pathRel);
      const sameFamily =
        moduleGated &&
        Boolean(famBest) &&
        Boolean(famSecond) &&
        famBest!.toLowerCase() === famSecond!.toLowerCase();
      if (sameFamily) {
        notes.push(`sameFamilyTie=${famBest}`);
      } else {
        const skip = "ambiguous margin without body-rule";
        const llm = await tryLlmShortlistPick(
          opts,
          candidates,
          notes,
          skip,
          llmSoftGate()
        );
        if (llm) return llm;
        return {
          writeBack: false,
          seed: null,
          symbol: null,
          relatedPaths: [],
          candidatesTop3: candidates.slice(0, 3).map((c) => ({
            pathRel: c.pathRel,
            score: c.score,
            ruleHits: [],
          })),
          skipReason: skip,
          notes,
          source: "index.db",
        };
      }
    }
  }
  if (!moduleGated) {
    const skip =
      "FAIL_UNGATED — soft writeBack needs Module/feature-folder lock";
    const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
    if (llm) return llm;
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        ruleHits: [],
      })),
      skipReason: skip,
      notes,
      source: "index.db",
    };
  }
  const softGate = uniq([
    ...familyGateTokens,
    ...moduleGateTokens(query, allIndexPaths),
    ...aliasDomain,
    ...strongPrefer,
  ]);
  if (softCrossCuttingDenied(best.pathRel, softGate)) {
    const skip =
      "FAIL_SOFT_CROSS_CUTTING — refused Auth/Mail/Notification/signed-URL primary (infra soft lock)";
    const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
    if (llm) return llm;
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        ruleHits: [],
      })),
      skipReason: skip,
      notes,
      source: "index.db",
    };
  }
  const opPreferNoBody = extractOpPreferTokens(
    intent,
    shapeBlobForRanking(query)
  );
  if (pathContradictsOpPreferTokens(best.pathRel, opPreferNoBody)) {
    // Prefer next candidate that hits op tokens inside family
    const opHit = candidates.find(
      (c) =>
        c.score >= MIN_SCORE &&
        !pathContradictsOpPreferTokens(c.pathRel, opPreferNoBody) &&
        !isUnsuitableUnitPrimary(c.pathRel)
    );
    if (opHit) {
      notes.push("opPreferRerank");
      const symbolOp = preferredSymbolFromCodeIndex(
        codeIndex,
        opHit.pathRel,
        [...strongPrefer, ...opPreferNoBody]
      );
      const relatedOp = relatedFromDeps(
        codeIndex,
        opHit.pathRel,
        strongPrefer,
        4,
        preferDtoValidatorForIntent(intent, query.testData)
      );
      const finalizedOp = applyLayerHintToWriteBack(
        codeIndex,
        query,
        opHit as SeedCandidate,
        relatedOp,
        symbolOp,
        notes
      );
      return {
        writeBack: true,
        seed: finalizedOp.seed as ResolvedSeed,
        symbol: finalizedOp.symbol,
        relatedPaths: finalizedOp.relatedPaths,
        candidatesTop3: candidates.slice(0, 3).map((c) => ({
          pathRel: c.pathRel,
          score: c.score,
          ruleHits: [],
        })),
        bodyRuleLog: `writeBack=yes opPreferRerank intent=${intent.primaryClass || "-"}`,
        notes,
        source: "index.db",
      };
    }
    const skip = `FAIL_OP_CONTRADICT — path misses op tokens «${opPreferNoBody.slice(0, 4).join(",")}»`;
    const llm = await tryLlmShortlistPick(opts, candidates, notes, skip, llmSoftGate());
    if (llm) return llm;
    return {
      writeBack: false,
      seed: null,
      symbol: null,
      relatedPaths: [],
      candidatesTop3: candidates.slice(0, 3).map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        ruleHits: [],
      })),
      skipReason: skip,
      notes,
      source: "index.db",
    };
  }
  const symbol = preferredSymbolFromCodeIndex(
    codeIndex,
    best.pathRel,
    strongPrefer
  );
  const relatedPaths = relatedFromDeps(
    codeIndex,
    best.pathRel,
    strongPrefer,
    4,
    preferDtoValidatorForIntent(intent, query.testData)
  );
  const finalized = applyLayerHintToWriteBack(
    codeIndex,
    query,
    best,
    relatedPaths,
    symbol,
    notes
  );
  return {
    writeBack: true,
    seed: finalized.seed,
    symbol: finalized.symbol,
    relatedPaths: finalized.relatedPaths,
    candidatesTop3: candidates.slice(0, 3).map((c) => ({
      pathRel: c.pathRel,
      score: c.score,
      ruleHits: [],
    })),
    notes,
    source: "index.db",
  };
}
