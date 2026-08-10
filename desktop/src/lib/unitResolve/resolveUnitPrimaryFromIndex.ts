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
  filterCandidatesByFeatureFolders,
  filterUnitLogicLayerCandidates,
  filterUnitLogicLayerPaths,
  hasStrongWriteBackSignal,
  isAnemicEntityLikePath,
  isSignedUrlOrTokenGeneratePath,
  orderCandidatesForBodyRuleOpen,
  softCrossCuttingDenied,
  tcImpliesBehaviorPrimary,
  UNIT_BODY_RULE,
  uploadIntentPathShapeAdjust,
  queryImpliesUploadIntent,
  validateRejectPathShapeAdjust,
  type BodyRuleScoredCandidate,
  type UnitIntent,
} from "@aitest/ide-protocol";
import { resolveImportSpecifier } from "../codeIndex/buildDependencyGraph";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import {
  extractTechIdentifierStems,
  pathHitsToken,
  preferredSymbolFromCodeIndex,
} from "../approvedTcSync/progressiveSeedFromCodeIndex";
import {
  extractMatchTokens,
} from "../projectIntelligence/tcSeedResolver";
import { matchingProjectAliasTokens } from "../projectIntelligence/viCodeAliases";
import type { SeedCandidate } from "../projectIntelligence/types";
import { isExcludedFromUnitRetrieve, isUnsuitableUnitPrimary, unitPathBonus } from "../retrieval/rankScore";
import { retrieveUnitSources } from "../retrieval/unitRetriever";
import type { RankedFileHit } from "../retrieval/types";
import type { UnitApproveQuery } from "./buildUnitApproveQuery";

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
  source: "index.db" | "path-index";
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
  return [query.module, query.title, query.tcBlob].filter(Boolean).join("\n");
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
  snap: CodeIndexSnapshot
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
  for (const t of moduleGateTokens(query).slice(0, 10)) {
    if (pathHitsDomainToken(p, t)) {
      score += 44;
      hits.push(`moduleDoc:${t}`);
    }
  }
  // Function tokens — file rank inside Module family
  for (const t of extractMatchTokens(query.module || "", query.projectAliases).slice(
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
  // Prefer/module tokens early — shortlist before body-rule topN open
  for (const t of query.preferTokens.slice(0, 12)) {
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
      score += 36;
      hits.push(`prefer:${tok}`);
    }
  }
  if (!moduleImpliesPersonDomain(query) && isPersonFamilyPath(p)) {
    score -= 55;
    hits.push("shape:demotePersonFamily");
  }
  const modGate = moduleGateTokens(query);
  const funcGate = functionGateTokens(query);
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
  score += validateRejectPathShapeAdjust(p, query.intent, shapeBlob);
  score += unitPathBonus(p);
  const uploadish = queryImpliesUploadIntent(query.intent, shapeBlob);
  const blob = String(shapeBlob || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (
    !uploadish &&
    /tao\s*moi|\bcreate\b|them\s*moi/.test(blob) &&
    /Create(Command)?Handler/i.test(p)
  ) {
    score += 16;
    hits.push("shape:CreatePrimary");
  }
  if (
    !uploadish &&
    /tao\s*moi|\bcreate\b|them\s*moi/.test(blob) &&
    /(Update|Delete)(Command)?Handler/i.test(p) &&
    !/Create/i.test(p)
  ) {
    score -= 24;
    hits.push("shape:demoteUpdateDelete");
  }
  if (
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
function moduleGateTokens(query: UnitApproveQuery): string[] {
  const weak =
    /^(Create|Update|Delete|Reject|Deny|CheckCode|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Save|Get|List|Query|Command|Handler|Service|Assert|Error|Code|RejectDenyCreate|CreateDenyReject|Assign|Filter|Permission|Authorization|Role|User|Account)$/i;
  // Joined IT verb compounds (CreateAddNew) never hit Latin paths — pollute gate.
  const joinedIt =
    /^(?:Create|Update|Delete|Add|New|Save|Get|List|Query|Check|Reject|Deny|Edit|Assign|Filter){2,}$/i;
  const fromModuleDoc = extractMatchTokens(
    query.requirementTitle || "",
    query.projectAliases
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
function functionGateTokens(query: UnitApproveQuery): string[] {
  const weak =
    /^(Create|Update|Delete|Reject|Deny|CheckCode|Check|Exists|Unique|Duplicate|Search|VALIDATION|trace|input|Mock|Add|New|Save|Get|List|Query|Command|Handler|Service|Assert|Error|Code|RejectDenyCreate|CreateDenyReject|Assign|Filter|Permission|Authorization|Role|User|Account|Upload|Download)$/i;
  const joinedIt =
    /^(?:Create|Update|Delete|Add|New|Save|Get|List|Query|Check|Reject|Deny|Edit|Assign|Filter|Upload|Download){2,}$/i;
  const fromFunction = extractMatchTokens(query.module || "", query.projectAliases);
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
function titleTokensForDiscover(query: UnitApproveQuery): string[] {
  return uniq([
    ...extractMatchTokens(query.module || "", query.projectAliases),
    ...extractMatchTokens(query.title || "", query.projectAliases),
    ...extractMatchTokens(query.requirementTitle || "", query.projectAliases),
    ...extractTechIdentifierStems(query.tcBlob),
    ...(query.preferTokens || []),
  ]).slice(0, 24);
}

/** Person/auth IT stems — demote when Module text is not about users. */
function moduleImpliesPersonDomain(query: UnitApproveQuery): boolean {
  const blob = [query.requirementTitle, query.module]
    .filter(Boolean)
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return /nguoi\s*dung|user|account|login|auth|phan\s*quyen|permission|role/.test(
    blob
  );
}

function isPersonFamilyPath(pathRel: string): boolean {
  return /\/(User|Account|Auth|Authentication|Permission|Role)s?\//i.test(
    pathRel.replace(/\\/g, "/")
  ) || /(?:^|\/)(User|Account)[A-Z][A-Za-z]*(Command|Query)?Handler/i.test(
    pathRel.replace(/\\/g, "/")
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
  notes: string[]
): {
  candidates: T[];
  familyTokens: string[];
  gated: boolean;
  skipReason?: string;
} {
  const discovered = discoverFeatureFoldersFromIndex(codeIndex, pathPool, {
    intent: query.intent,
    titleTokens: titleTokensForDiscover(query),
  });
  let featureTokens = [...discovered.featureTokens];
  // Widen with folders that host CheckCode* — uniqueness/create-code and soft create
  // on VI modules (no Latin gate) lock the same family as EvidenceCheckCode* etc.
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
  maxRelated = 4
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
  if (fromGraph.length) {
    return uniq(fromGraph).slice(0, maxRelated);
  }
  return expandUnitRelatedPaths({
    entryPathRel: primary,
    allPaths: Object.keys(snap.files || {}),
    featureTokens: preferTokens,
    maxRelated,
  });
}

export type ResolveUnitPrimaryOpts = {
  codeIndex: CodeIndexSnapshot;
  query: UnitApproveQuery;
  readExcerpt?: ReadExcerptFn | null;
  topK?: number;
  /** Extra path pool when retrieve shortlist is thin */
  fallbackPaths?: string[];
};

/**
 * Full Approve resolve: retrieve → rank → (body-rule read) → symbol → related.
 */
export async function resolveUnitPrimaryFromIndex(
  opts: ResolveUnitPrimaryOpts
): Promise<ResolveUnitPrimaryResult> {
  const { codeIndex, query, readExcerpt } = opts;
  const notes: string[] = [];
  const topK = opts.topK ?? (query.requiresBodyRule ? 24 : 16);
  // Always scan CheckCode* folders for VI-module family lock; pathPool widen stays opt-in.
  const checkCodeFolders = discoverCheckCodeFolders(codeIndex);

  const retrieved = retrieveUnitSources(codeIndex, query.plan, { topK });
  notes.push(...retrieved.notes);

  let pathPool = retrieved.files.map((f) => f.pathRel);
  if (query.codeFieldCreate && checkCodeFolders.size) {
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
    const seed = rankHitToSeed(hit, query, checkCodeFolders, codeIndex);
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
  let functionGated = false;
  let familyGateTokens = moduleGateTokens(query);
  const indexPaths = Object.keys(codeIndex.files || {});
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
      // Alias/Latin tokens present but shortlist miss — try discover before skip
      const locked = applyFeatureFolderDiscover(
        candidates,
        codeIndex,
        pathPool,
        query,
        checkCodeFolders,
        notes
      );
      if (locked.skipReason) {
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
          skipReason: `moduleGate miss — no path hit for «${hittingGate.slice(0, 4).join(",")}»`,
          notes,
          source: "index.db",
        };
      }
    }
  } else {
    // VI Module (no hitting gate) — lock family via Function/Title discover
    const locked = applyFeatureFolderDiscover(
      candidates,
      codeIndex,
      pathPool,
      query,
      checkCodeFolders,
      notes
    );
    if (locked.skipReason) {
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
    } else if (familyGateTokens.length && !hittingGate.length) {
      // Had VI/module tokens but none hit index and discover empty — fail-closed
      // (avoid AccountCreate latch on soft Create).
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
        skipReason: `moduleGate miss — no path hit for «${familyGateTokens.slice(0, 4).join(",")}»`,
        notes,
        source: "index.db",
      };
    }
  }

  // Function gate — soft narrow when Function/alias tokens hit paths (Module ∩ Function).
  const funcGateRaw = functionGateTokens(query);
  const funcHitting = gateTokensHittingPaths(funcGateRaw, [
    ...pathPool,
    ...indexPaths,
  ]);
  if (funcHitting.length && candidates.length) {
    const funcGated = applyModulePreferGate(candidates, funcHitting);
    if (!funcGated.miss && funcGated.candidates.length) {
      candidates = funcGated.candidates;
      functionGated = funcGated.gated;
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

  if (readExcerpt && (intent.requiresBodyRule || intent.codePatterns.length > 0)) {
    const open = orderCandidatesForBodyRuleOpen(
      candidates,
      intent,
      UNIT_BODY_RULE.topN
    );
    const rescored: BodyRuleScoredCandidate[] = [];
    for (const c of open) {
      let excerpt = "";
      try {
        excerpt = clipBodyExcerpt(await readExcerpt(c.pathRel));
      } catch {
        excerpt = "";
      }
      const scored = applyBodyRuleToCandidate(c, excerpt, intent, query.tcBlob, {
        preferTokens: query.preferTokens,
      });
      const preferHits = countPreferTokenHits(scored.pathRel, query.preferTokens);
      if (preferHits > 0) {
        scored.score += preferHits * 40;
        scored.hits = uniq([
          ...(scored.hits || []),
          ...query.preferTokens
            .filter((t) => pathHitsDomainToken(scored.pathRel, t))
            .slice(0, 3)
            .map((t) => `prefer:${t}`),
        ]);
      }
      rescored.push(scored);
    }
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
      preferTokens: query.preferTokens,
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
      isAnemicEntityLikePath(seed.pathRel)
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
          if (
            moduleGated ||
            hasStrongWriteBackSignal({
              pathRel: best.pathRel,
              ruleHits: best.ruleHits,
              hits: best.hits,
              preferTokens: query.preferTokens,
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

    // P0.1 — soft (!requiresBodyRule) writeBack needs domain/prefer/phrase signal
    // moduleGated (alias/VI discover family lock) counts as domain signal.
    if (decision.writeBack && seed && !intent.requiresBodyRule) {
      if (
        !moduleGated &&
        !hasStrongWriteBackSignal({
          pathRel: seed.pathRel,
          ruleHits: seed.ruleHits,
          hits: seed.hits,
          preferTokens: query.preferTokens,
        })
      ) {
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

    // Soft deny Account/Auth/Jwt/Mail/Permission unless module/family hits same stem
    if (decision.writeBack && seed && !intent.requiresBodyRule) {
      const softGate = uniq([
        ...familyGateTokens,
        ...moduleGateTokens(query),
        ...aliasDomain,
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
      return {
        writeBack: false,
        seed: null,
        symbol: null,
        relatedPaths: [],
        candidatesTop3: decision.candidatesTop3,
        skipReason: decision.skipReason || "body-rule / margin fail-closed",
        bodyRuleLog: `writeBack=no skip=${decision.skipReason || "-"}${signalsNote} intent=${intent.primaryClass || "-"}`,
        notes,
        source: "index.db",
      };
    }

    const symbol = preferredSymbolFromCodeIndex(
      codeIndex,
      seed.pathRel,
      [...query.preferTokens, ...(seed.ruleHits || [])]
    );
    const relatedPaths = relatedFromDeps(
      codeIndex,
      seed.pathRel,
      query.preferTokens
    );
    return {
      writeBack: true,
      seed,
      symbol,
      relatedPaths,
      candidatesTop3: decision.candidatesTop3,
      bodyRuleLog: `writeBack=yes score=${seed.score} ruleHits=${(seed.ruleHits || []).join(",")} intent=${intent.primaryClass || "-"}${signalsNote}`,
      notes,
      source: "index.db",
    };
  }

  // No excerpt reader: soft pick from ranked seeds
  const best = candidates[0];
  const second = candidates[1];
  if (!best || best.score < MIN_SCORE) {
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
      skipReason: "score below min without body excerpt",
      notes,
      source: "index.db",
    };
  }
  if (intent.requiresBodyRule) {
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
      skipReason: "body-rule required but no readExcerpt",
      notes,
      source: "index.db",
    };
  }
  if (second) {
    const margin = best.score - second.score;
    if (margin < SOFT_MARGIN && best.score < second.score * SOFT_RATIO) {
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
        skipReason: "ambiguous margin without body-rule",
        notes,
        source: "index.db",
      };
    }
  }
  if (
    !hasStrongWriteBackSignal({
      pathRel: best.pathRel,
      ruleHits: [],
      hits: best.hits,
      preferTokens: query.preferTokens,
    })
  ) {
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
      skipReason:
        "FAIL_SOFT_NO_DOMAIN — soft writeBack needs prefer/phrase/alias on path",
      notes,
      source: "index.db",
    };
  }
  const softGate = uniq([
    ...familyGateTokens,
    ...moduleGateTokens(query),
    ...aliasDomain,
  ]);
  if (softCrossCuttingDenied(best.pathRel, softGate)) {
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
      skipReason:
        "FAIL_SOFT_CROSS_CUTTING — refused Auth/Mail/Notification/signed-URL primary (infra soft lock)",
      notes,
      source: "index.db",
    };
  }
  const symbol = preferredSymbolFromCodeIndex(
    codeIndex,
    best.pathRel,
    query.preferTokens
  );
  const relatedPaths = relatedFromDeps(
    codeIndex,
    best.pathRel,
    query.preferTokens
  );
  return {
    writeBack: true,
    seed: best,
    symbol,
    relatedPaths,
    candidatesTop3: candidates.slice(0, 3).map((c) => ({
      pathRel: c.pathRel,
      score: c.score,
      ruleHits: [],
    })),
    notes,
    source: "index.db",
  };
}
