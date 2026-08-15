/**
 * Phase 3 — body-rule scoring for Approve Unit marker write-back.
 * Pure (excerpt in → hits/score out). Desktop reads files via Tauri.
 */
import { UNIT_GEN_LIMITS } from "./unitConventions.js";
import { infraPathDemoteScore, isSignedUrlOrTokenGeneratePath } from "./unitFeatureFolderDiscover.js";
import type { UnitIntent } from "./unitIntentAliases.js";
import {
  isAnemicEntityLikePath,
  isWeakUnitClientPath,
} from "./unitLogicLayerFilter.js";
import {
  isInterfaceLikePrimaryPath,
  preferImplementationOverInterface,
} from "./unitPrimaryPrefer.js";
import {
  filterStrongBodyRulePatterns,
  isWeakBodyRulePattern,
} from "./unitProjectIntentRules.js";

export const UNIT_BODY_RULE = {
  /** Cap excerpt chars when scoring (aligned with Gen budget). */
  maxExcerptChars: UNIT_GEN_LIMITS.maxExcerptChars,
  /** How many top path candidates to open for body scoring. */
  topN: 5,
  /** First rule-hit boost. */
  hitBoost: 28,
  /** Extra boost per additional distinct pattern hit. */
  multiHitBoost: 12,
  /** Soft demote when validation intent but path still FE-shaped (defense in depth). */
  feValidationPenalty: 40,
} as const;

export type BodyRuleCandidateIn = {
  pathRel: string;
  score: number;
  reason?: string;
  hits?: string[];
};

export type BodyRuleScoredCandidate = BodyRuleCandidateIn & {
  baseScore: number;
  ruleHits: string[];
  score: number;
};

export type BodyRuleWriteDecision = {
  writeBack: boolean;
  seed: BodyRuleScoredCandidate | null;
  skipReason?: string;
  candidatesTop3: Array<{
    pathRel: string;
    score: number;
    baseScore: number;
    ruleHits: string[];
  }>;
};

function uniq(xs: string[]): string[] {
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

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").toLowerCase();
}

function isQueryLikePath(pathRel: string): boolean {
  const p = normPath(pathRel);
  const base = p.split("/").pop() || p;
  // *Query.cs / *QueryHandler.cs / /Queries/ — not *CommandHandler
  return /\/queries?\//i.test(p) || /query(handler)?\.(cs|ts|tsx|js)$/i.test(base);
}

function isServiceOrHandlerPath(pathRel: string): boolean {
  return /(Service|Handler|UseCase|Manager)\.(cs|ts|tsx|js)$/i.test(pathRel || "");
}

/**
 * Order candidates for body-rule excerpt opens.
 * Body-rule / validate_reject: prefer *Handler/*Service over *Query so
 * bool-check queries do not consume topN while CommandHandlers with
 * throw/BadRequest never get scored.
 */
export function orderCandidatesForBodyRuleOpen<T extends { pathRel: string; score: number }>(
  candidates: T[],
  intent?: Pick<UnitIntent, "requiresBodyRule" | "primaryClass" | "classes"> | null,
  topN = UNIT_BODY_RULE.topN
): T[] {
  if (!candidates.length) return [];
  const searchOpen =
    intent?.primaryClass === "search_lookup" ||
    (intent?.classes || []).includes("search_lookup");
  const preferLogic =
    Boolean(intent?.requiresBodyRule) ||
    intent?.primaryClass === "validate_reject" ||
    intent?.primaryClass === "auto_generate_code" ||
    intent?.primaryClass === "state_enable" ||
    searchOpen ||
    (intent?.classes || []).includes("validate_reject") ||
    (intent?.classes || []).includes("auto_generate_code") ||
    (intent?.classes || []).includes("state_enable");
  if (!preferLogic) return candidates.slice(0, topN);

  // Search/lookup: open *Query*Handler first so Assign*CommandHandlers do not starve GetAll.
  if (searchOpen) {
    const queries: T[] = [];
    const other: T[] = [];
    for (const c of candidates) {
      if (isQueryLikePath(c.pathRel)) queries.push(c);
      else other.push(c);
    }
    queries.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
    other.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
    const openLimit = intent?.requiresBodyRule
      ? Math.max(topN, Math.min(candidates.length, topN * 2))
      : topN;
    return [...queries, ...other].slice(0, openLimit);
  }

  const handlers: T[] = [];
  const other: T[] = [];
  for (const c of candidates) {
    if (isServiceOrHandlerPath(c.pathRel) && !isQueryLikePath(c.pathRel)) {
      handlers.push(c);
    } else {
      other.push(c);
    }
  }
  // Keep relative score order within each bucket
  handlers.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
  other.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));
  // Cap opens: body-rule intents get up to 2×topN; soft callers that still open stay at topN
  const openLimit = intent?.requiresBodyRule
    ? Math.max(topN, Math.min(candidates.length, topN * 2))
    : topN;
  return [...handlers, ...other].slice(0, openLimit);
}

function isBareCommandMessagePath(pathRel: string): boolean {
  const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || "";
  return /Command\.(cs|ts|tsx|js)$/i.test(base) && !/Handler/i.test(base);
}

/**
 * Portable feature-family key from filename:
 * DigitalFileCreateCommandHandler / DigitalFileCreateCommand / DigitalFileDeleteCommand
 * → "digitalfile"
 */
export function unitFeatureFamilyKey(pathRel: string): string {
  const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || pathRel;
  const stem = base.replace(/\.[^.]+$/, "");
  return stem
    .replace(
      /(CommandHandler|QueryHandler|Handler|Command|Query|Service|Controller|Manager)$/i,
      ""
    )
    .replace(
      /(Create|Update|Delete|Get|List|Assign|Add|Remove|Upsert|Search|Filter)$/i,
      ""
    )
    .toLowerCase();
}

/** Prefer Handler/Service; demote bare Command message + Delete* within a family. */
export function unitPrimaryShapeRank(pathRel: string): number {
  const base = (pathRel || "").replace(/\\/g, "/").split("/").pop() || "";
  if (/(Handler|Service)\.(cs|ts|tsx|js)$/i.test(base)) return 100;
  if (/Delete/i.test(base)) return 15;
  if (isBareCommandMessagePath(pathRel)) return 40;
  if (/Query/i.test(base)) return 30;
  return 50;
}

/**
 * Collapse IFoo↔Foo ties and drop *Query when a *Service scores as high —
 * those are not real SUT ambiguity for Unit Gen write-back.
 * Also collapse same feature-family ties (CreateCommand vs CreateCommandHandler vs Delete).
 */
export function collapseBodyRuleContenders(
  usable: BodyRuleScoredCandidate[]
): BodyRuleScoredCandidate[] {
  if (usable.length <= 1) return usable;
  const byNorm = new Map(
    usable.map((c) => [normPath(c.pathRel), c] as const)
  );
  const preferredOrder = preferImplementationOverInterface(
    usable.map((c) => c.pathRel)
  );
  let collapsed = preferredOrder
    .map((p) => byNorm.get(normPath(p)))
    .filter((c): c is BodyRuleScoredCandidate => Boolean(c));

  const services = collapsed.filter((c) => isServiceOrHandlerPath(c.pathRel));
  if (services.length) {
    const bestSvcScore = Math.max(...services.map((s) => s.score));
    collapsed = collapsed.filter((c) => {
      if (isQueryLikePath(c.pathRel)) {
        // Query must clearly beat the best service to stay in the race
        return c.score > bestSvcScore + 5;
      }
      if (isAnemicEntityLikePath(c.pathRel)) {
        // DTO/entity never vetoes a competitive Handler/Service primary
        return c.score > bestSvcScore + 10;
      }
      return true;
    });
  }

  // Same feature family (DigitalFile*): keep best-shaped primary, drop siblings
  const byFamily = new Map<string, BodyRuleScoredCandidate[]>();
  for (const c of collapsed) {
    const key = unitFeatureFamilyKey(c.pathRel);
    if (!key || key.length < 4) continue;
    const list = byFamily.get(key) || [];
    list.push(c);
    byFamily.set(key, list);
  }
  const drop = new Set<string>();
  for (const [, members] of byFamily) {
    if (members.length < 2) continue;
    const ranked = [...members].sort(
      (a, b) =>
        unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
        b.score - a.score ||
        a.pathRel.localeCompare(b.pathRel)
    );
    const winner = ranked[0]!;
    for (const m of ranked.slice(1)) {
      // Drop bare Command / Delete when a Handler/Service sibling exists
      if (
        isServiceOrHandlerPath(winner.pathRel) &&
        (isBareCommandMessagePath(m.pathRel) || /Delete/i.test(m.pathRel))
      ) {
        drop.add(normPath(m.pathRel));
        continue;
      }
      // Near-tie siblings of weaker shape
      if (
        unitPrimaryShapeRank(winner.pathRel) >
          unitPrimaryShapeRank(m.pathRel) + 20 &&
        Math.abs(winner.score - m.score) <= 8
      ) {
        drop.add(normPath(m.pathRel));
      }
    }
  }
  if (drop.size) {
    collapsed = collapsed.filter((c) => !drop.has(normPath(c.pathRel)));
  }

  collapsed.sort(
    (a, b) =>
      unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
      b.score - a.score ||
      a.pathRel.localeCompare(b.pathRel)
  );
  return collapsed.length ? collapsed : usable;
}

/** Clip excerpt for scoring. */
export function clipBodyExcerpt(
  text: string | null | undefined,
  maxChars = UNIT_BODY_RULE.maxExcerptChars
): string {
  const raw = text || "";
  if (raw.length <= maxChars) return raw;
  return raw.slice(0, maxChars);
}

/**
 * Which intent codePatterns appear in the SUT excerpt (case-insensitive).
 * Supports plain tokens and light regex (`(?i)A|B`, `EntityCode`).
 */
export function findBodyRuleHits(
  excerpt: string,
  codePatterns: string[] | null | undefined
): string[] {
  const text = excerpt || "";
  if (!text || !codePatterns?.length) return [];
  const hits: string[] = [];
  for (const pat of codePatterns) {
    const p = String(pat || "").trim();
    if (p.length < 3) continue;
    if (isWeakBodyRulePattern(p)) continue;
    try {
      const asRe = /^\(\?i\)/.test(p) || /[|\\[\]()+*?{}]/.test(p);
      if (asRe) {
        const src = p.replace(/^\(\?i\)/, "");
        if (new RegExp(src, "i").test(text)) hits.push(p);
      } else {
        const escaped = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        // Strong IT types may be prefixes (BadRequestAlertException).
        // Short verbs keep identifier boundary (avoid Generate⊂GeneratePresigned).
        const allowPascalPrefix =
          p.length >= 8 ||
          /^(BadRequest|CheckCode|ArgumentException|AlreadyExists|MaxFileSize|SearchTerm)/i.test(
            p
          );
        const re = allowPascalPrefix
          ? new RegExp(`(?<![A-Za-z0-9_])${escaped}`, "i")
          : new RegExp(
              `(?<![A-Za-z0-9_])${escaped}(?![A-Za-z0-9_])`,
              "i"
            );
        if (re.test(text)) hits.push(p);
      }
    } catch {
      if (text.toLowerCase().includes(p.toLowerCase())) hits.push(p);
    }
  }
  return uniq(hits);
}

export function bodyRuleScoreBoost(hitCount: number): number {
  if (hitCount <= 0) return 0;
  return (
    UNIT_BODY_RULE.hitBoost + (hitCount - 1) * UNIT_BODY_RULE.multiHitBoost
  );
}

function looksLikeFeShell(pathRel: string): boolean {
  const p = (pathRel || "").replace(/\\/g, "/").toLowerCase();
  return (
    isWeakUnitClientPath(pathRel) ||
    /\.component\.(ts|tsx|js)$/.test(p)
  );
}

/**
 * True when TC Function/title/steps imply file/image upload (not bare Module «tạo mới»).
 */
export function queryImpliesUploadIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  const uploadClasses = new Set([
    "upload",
    "upload_resource",
    "upload_size_limit",
  ]);
  const blob = String(shapeBlob || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const explicitUpload =
    /tai\s*len|\bupload\b|hinh\s*anh|\bimage\b|\bmedia\b|\bphoto\b|\bmagic\s*bytes\b|\bantivirus\b|\bscanner\b/.test(
      blob
    );
  const hasUploadClass =
    (intent.primaryClass && uploadClasses.has(intent.primaryClass)) ||
    (intent.classes || []).some((c) => uploadClasses.has(c));
  // `digital` may bootstrap upload_resource, but a classification/read TC must
  // not be forced onto Upload* paths without an explicit upload cue.
  return (
    explicitUpload ||
    (hasUploadClass &&
      (!String(shapeBlob || "").trim() ||
        intent.primaryClass === "upload_size_limit"))
  );
}

/** Delete / unassign / remove — never primary for upload/reject-format TCs. */
export function pathIsDeleteLikeUnitPrimary(pathRel: string): boolean {
  const p = (pathRel || "").replace(/\\/g, "/");
  return /(Delete|Unassign|SoftDelete|Remove)(Command)?(Handler)?/i.test(p);
}

/**
 * Upload / image-file TCs — boost portable Upload|Image|Media|InitUpload paths;
 * demote Delete* and generic DocumentCreate. Product stems stay in SUT aliases.
 */
export function uploadIntentPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): number {
  if (!queryImpliesUploadIntent(intent, shapeBlob)) return 0;
  const blob = String(shapeBlob || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;
  // Hard demote Delete* — body-rule throw must not rescue them for upload TCs
  if (pathIsDeleteLikeUnitPrimary(p)) {
    adj -= 90;
    return adj;
  }
  if (
    /(Upload|InitUpload|FileSignature|Antivirus|Scanner)/i.test(p) ||
    (/(Image|Media|Photo|Physical|Attachment)/i.test(p) &&
      /(Create|Upload|Handler|Service)/i.test(p))
  ) {
    adj += 38;
  }
  if (
    /Create(Command)?Handler/i.test(p) &&
    !/(Upload|Image|Physical|Media|Photo|File|Attachment)/i.test(p)
  ) {
    adj -= 30;
  }
  if (
    /DocumentCreate/i.test(p) &&
    /hinh\s*anh|\bimage\b|\bphoto\b|\bmedia\b|\bscanner\b|\bmagic\s*bytes\b/.test(
      blob
    ) &&
    !/(document|tep\s*tin|file\s*ky|attachment)/.test(blob)
  ) {
    adj -= 44;
  }
  return adj;
}

/**
 * Title/steps search/lookup (tim kiem / theo ma / SearchTerm) — stronger than
 * Function-only Assign when both cue. Portable VI/IT only.
 */
export function queryImpliesSearchLookupIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (
    intent.primaryClass === "search_lookup" ||
    (intent.classes || []).includes("search_lookup")
  ) {
    return true;
  }
  const blob = shapeBlobNorm(shapeBlob);
  // Strong title/steps cues only — do not use featureTokens (filter_list adds Query)
  return /tim\s*kiem|tim\s*theo|\bsearch\b|theo\s*ma|search\s*term|searchterm|tra\s*ve\s+.*\bkhop\b|\blookup\b|autocomplete|typeahead|fuzzy/.test(
    blob
  );
}

/**
 * Search/lookup TCs — boost *Query* / GetAll / Search; demote Assign*Command.
 */
export function searchIntentPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): number {
  if (!queryImpliesSearchLookupIntent(intent, shapeBlob)) return 0;
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;
  if (
    isQueryLikePath(p) ||
    /(GetAll|Search|ListAvailable|FindBy|Lookup)(Query)?(Handler)?/i.test(p)
  ) {
    adj += 52;
  }
  if (
    /(Assign|Attach|Link)/i.test(p) &&
    !isQueryLikePath(p) &&
    !/(GetAll|Search|List|Filter)/i.test(p)
  ) {
    adj -= 58;
  }
  if (pathIsDeleteLikeUnitPrimary(p)) adj -= 40;
  return adj;
}

/**
 * Soft writeBack refuse: upload intent must not latch Delete* even when path
 * shares Digital / Image tokens or body-rule throw+BadRequest.
 */
export function pathContradictsUploadVerb(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (!queryImpliesUploadIntent(intent, shapeBlob)) return false;
  return pathIsDeleteLikeUnitPrimary(pathRel);
}

/**
 * Soft writeBack refuse: search/lookup title must not latch Assign*Command
 * when a Query/GetAll-shaped alternative is expected.
 */
export function pathContradictsSearchVerb(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (!queryImpliesSearchLookupIntent(intent, shapeBlob)) return false;
  const p = (pathRel || "").replace(/\\/g, "/");
  if (isQueryLikePath(p) || /(GetAll|Search|ListAvailable|FindBy)/i.test(p)) {
    return false;
  }
  return /(Assign|Attach|Link)/i.test(p);
}

/**
 * True when Function/title/steps imply load/display/get-detail (read), not create.
 * Portable VI/IT only — stronger than bare Module «Update …» / Function «chỉnh sửa».
 */
export function queryImpliesReadGetDetailIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (
    intent.primaryClass === "persist_read" ||
    (intent.classes || []).includes("persist_read")
  ) {
    return true;
  }
  const blob = shapeBlobNorm(shapeBlob);
  // Strong read/load/get-by-id — not list-search (search_lookup) or create
  return /hien\s*thi|tai\s*(du\s*lieu|chi\s*tiet)|lay\s*(chi\s*tiet|theo\s*(id|dinh\s*danh))|chi\s*tiet\s*(da\s*luu|ban\s*ghi)|tra\s*ve\s*(day\s*du|dung(\s*cac)?)|quan\s*sat[:\s]*read|\bget\s*(by\s*)?(id|detail)\b|\bgetquery\b|\bload\s*(detail|entity|record|data)\b|display\s*(detail|full|info)|\bread\b.*\b(detail|entity|record)\b/.test(
    blob
  );
}

/** Create*CommandHandler — wrong primary for read/get-detail TCs. */
export function pathIsCreateLikeUnitPrimary(pathRel: string): boolean {
  const p = (pathRel || "").replace(/\\/g, "/");
  if (isQueryLikePath(p) || /(Get(Query|ById|Detail)|FindById)/i.test(p)) {
    return false;
  }
  return /Create(Command)?Handler/i.test(p) || /\/Create[A-Z]\w*\./i.test(p);
}

/** Update / Edit / Patch primary shapes — portable across stacks (path segment / type name). */
export function pathIsUpdateLikeUnitPrimary(pathRel: string): boolean {
  const p = (pathRel || "").replace(/\\/g, "/");
  if (pathIsCreateLikeUnitPrimary(p) || pathIsDeleteLikeUnitPrimary(p)) return false;
  if (isQueryLikePath(p) || /(Get(Query|ById|Detail)|FindById)/i.test(p)) return false;
  return (
    /Update(Command)?Handler/i.test(p) ||
    /Edit(Command)?Handler/i.test(p) ||
    /Patch(Command)?Handler/i.test(p) ||
    /\/(Update|Edit|Patch)[A-Z]\w*\./i.test(p)
  );
}

/**
 * CRUD verb from TC text + intent — portable VI/IT only (no product nouns).
 * Order: read > delete > update > create. `validate_reject` / trùng mã alone ≠ create.
 */
export type UnitCrudVerb = "create" | "read" | "update" | "delete";

export function detectUnitCrudVerb(
  intent: UnitIntent,
  shapeBlob?: string | null
): UnitCrudVerb | null {
  const blob = shapeBlobNorm(shapeBlob);
  const classes = intent.classes || [];
  const pc = intent.primaryClass;

  // IR observable markers (Unit gen Approve-ready)
  if (/quan\s*sat[:\s]*read\b|\bobservable[:\s\"']*read\b/.test(blob)) return "read";
  if (/quan\s*sat[:\s]*update\b|\bobservable[:\s\"']*update\b/.test(blob)) {
    return "update";
  }
  if (/quan\s*sat[:\s]*create\b|\bobservable[:\s\"']*create\b/.test(blob)) {
    return "create";
  }
  if (/quan\s*sat[:\s]*delete\b|\bobservable[:\s\"']*delete\b/.test(blob)) {
    return "delete";
  }

  // Strong read/load/get-detail (before Module «Update …» false latch)
  if (
    pc === "persist_read" ||
    classes.includes("persist_read") ||
    queryImpliesReadGetDetailIntent(intent, shapeBlob)
  ) {
    return "read";
  }

  // Search / upload are not CRUD create|update|delete (Module «Create …» must not force Create)
  if (queryImpliesSearchLookupIntent(intent, shapeBlob)) return null;
  if (queryImpliesUploadIntent(intent, shapeBlob)) return null;

  const deleteCue =
    /\bxoa\b|\bdelete\b|\bremove\b|soft\s*delete|xoa\s*(ban\s*ghi|dulieu|du\s*lieu|file|item)/.test(
      blob
    );
  const updateCue =
    pc === "persist_update" ||
    classes.includes("persist_update") ||
    /cap\s*nhat|\bupdate\b|\bedit\b|\bpatch\b|sua\s*(doi|ma|ten|thong\s*tin)?/.test(
      blob
    );
  const createCue =
    pc === "persist_create" ||
    classes.includes("persist_create") ||
    classes.includes("auto_generate_code") ||
    pc === "auto_generate_code" ||
    /tao\s*moi|\bcreate\b|them\s*moi|\badd\s*new\b|\binsert\b/.test(blob);

  // Function/Title verb denser than Module alone when both create+update cue
  if (updateCue && createCue) {
    if (
      /cap\s*nhat|\bupdate\b|\bedit\b/.test(blob) &&
      !/tao\s*moi|\bcreate\b|\badd\s*new\b/.test(blob)
    ) {
      return "update";
    }
    if (
      /tao\s*moi|\bcreate\b|\badd\s*new\b/.test(blob) &&
      !/cap\s*nhat|\bupdate\b/.test(blob)
    ) {
      return "create";
    }
    if (/tao\s*moi|\bcreate\b|\badd\s*new\b/.test(blob)) return "create";
    if (/cap\s*nhat|\bupdate\b/.test(blob)) return "update";
  }
  if (deleteCue && !createCue && !updateCue) return "delete";
  if (updateCue) return "update";
  if (createCue) return "create";
  if (deleteCue) return "delete";
  // validate_reject / duplicate / từ chối alone → null (do NOT imply create)
  return null;
}

/** Path looks like a CRUD command/query primary (not DTO/entity). */
export function pathLooksLikeCrudPrimary(pathRel: string): boolean {
  const p = (pathRel || "").replace(/\\/g, "/");
  return (
    pathIsCreateLikeUnitPrimary(p) ||
    pathIsUpdateLikeUnitPrimary(p) ||
    pathIsDeleteLikeUnitPrimary(p) ||
    isQueryLikePath(p) ||
    /(Get(Query|ById|Detail)|FindById|Load(Detail|ById)?)/i.test(p) ||
    /(Create|Update|Delete|Edit|Patch)(Command)?(Handler|Service|Controller|UseCase)?/i.test(
      p
    )
  );
}

export function pathMatchesCrudVerb(
  pathRel: string,
  verb: UnitCrudVerb
): boolean {
  const p = (pathRel || "").replace(/\\/g, "/");
  switch (verb) {
    case "create":
      return pathIsCreateLikeUnitPrimary(p) ||
        (/\bCreate\b|\bInsert\b|AddNew/i.test(p) &&
          !pathIsUpdateLikeUnitPrimary(p) &&
          !pathIsDeleteLikeUnitPrimary(p) &&
          !isQueryLikePath(p));
    case "update":
      return pathIsUpdateLikeUnitPrimary(p) ||
        (/\bUpdate\b|\bEdit\b|\bPatch\b/i.test(p) &&
          !pathIsCreateLikeUnitPrimary(p) &&
          !pathIsDeleteLikeUnitPrimary(p) &&
          !isQueryLikePath(p));
    case "delete":
      return pathIsDeleteLikeUnitPrimary(p);
    case "read":
      return (
        isQueryLikePath(p) ||
        /(Get(Query|ById|Detail|Handler)?|FindById|Load(Detail|ById)?)(Query)?(Handler)?/i.test(
          p
        )
      );
    default:
      return false;
  }
}

/**
 * Boost path matching detected CRUD verb; demote other CRUD primaries.
 * Stack-agnostic: matches Create|Update|Delete|Get in path/type names.
 */
export function crudVerbPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): number {
  const verb = detectUnitCrudVerb(intent, shapeBlob);
  // read shape stays in readGetIntentPathShapeAdjust (avoid double-count)
  if (!verb || verb === "read") return 0;
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;
  if (pathMatchesCrudVerb(p, verb)) {
    adj += 52;
  } else if (pathLooksLikeCrudPrimary(p)) {
    // Wrong CRUD sibling in same family (Create vs Update vs Delete)
    adj -= 64;
    if (verb === "update" && pathIsCreateLikeUnitPrimary(p)) adj -= 12;
    if (verb === "create" && pathIsUpdateLikeUnitPrimary(p)) adj -= 12;
    if (
      verb === "delete" &&
      (pathIsCreateLikeUnitPrimary(p) || pathIsUpdateLikeUnitPrimary(p))
    ) {
      adj -= 8;
    }
  }
  return adj;
}

/**
 * Soft writeBack refuse: detected CRUD verb must not latch a different CRUD primary.
 * validate_reject alone does not fire (verb null). read → pathContradictsReadGetVerb.
 */
export function pathContradictsCrudVerb(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  const verb = detectUnitCrudVerb(intent, shapeBlob);
  if (!verb || verb === "read") return false;
  if (pathMatchesCrudVerb(pathRel, verb)) return false;
  if (!pathLooksLikeCrudPrimary(pathRel)) return false;
  return true;
}

/**
 * Read/get-detail TCs — boost Get* Query* Queries folder; demote Create*CommandHandler.
 */
export function readGetIntentPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): number {
  if (!queryImpliesReadGetDetailIntent(intent, shapeBlob)) return 0;
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;
  if (
    isQueryLikePath(p) ||
    /(Get(Query|ById|Detail|Handler)?|FindById|Load(Detail|ById)?)(Query)?(Handler)?/i.test(
      p
    )
  ) {
    adj += 56;
  }
  // Update handler is secondary for pure load/display; demote vs Get*
  // (Module «Update …» often false-latches Update*CommandHandler).
  if (
    /Update(Command)?Handler/i.test(p) &&
    !/Get|Query|Detail/i.test(p) &&
    /tai\s*(du\s*lieu|chi\s*tiet)|lay\s*chi\s*tiet|quan\s*sat[:\s]*read|\bget\s*(by\s*)?(id|detail)\b|\bload\s*(detail|data)\b|tra\s*ve\s*(day\s*du|dung)/.test(
      shapeBlobNorm(shapeBlob)
    )
  ) {
    adj -= 55;
  }
  if (pathIsCreateLikeUnitPrimary(p)) {
    adj -= 72;
  }
  if (
    /(Assign|Attach|Link)(Case|To)?/i.test(p) &&
    !isQueryLikePath(p) &&
    /tai\s*(du\s*lieu|chi\s*tiet)|lay\s*chi\s*tiet|quan\s*sat[:\s]*read|\bget\s*(by\s*)?(id|detail)\b|\bload\s*(detail|data)\b|tra\s*ve\s*(day\s*du|dung)/.test(
      shapeBlobNorm(shapeBlob)
    )
  ) {
    adj -= 60;
  }
  if (pathIsDeleteLikeUnitPrimary(p)) adj -= 40;
  return adj;
}

/**
 * Soft writeBack refuse: read/get-detail must not latch Create* (or Update*
 * when title/steps are pure load/display/get-by-id).
 */
export function pathContradictsReadGetVerb(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (!queryImpliesReadGetDetailIntent(intent, shapeBlob)) return false;
  if (pathIsCreateLikeUnitPrimary(pathRel)) return true;
  const blob = shapeBlobNorm(shapeBlob);
  const loadAction =
    /tai\s*(du\s*lieu|chi\s*tiet)|lay\s*(chi\s*tiet|theo\s*(id|dinh\s*danh))|tra\s*ve\s*(day\s*du|dung(\s*cac)?)|quan\s*sat[:\s]*read|\bget\s*(by\s*)?(id|detail)\b|\bgetquery\b|\bload\s*(detail|entity|record|data)\b|display\s*(detail|full|info)/.test(
      blob
    );
  if (!loadAction) return false;
  const p = (pathRel || "").replace(/\\/g, "/");
  if (
    isQueryLikePath(p) ||
    /(Get(Query|ById|Detail)|FindById)/i.test(p)
  ) {
    return false;
  }
  // Module named «Update …» / Assign* must not override Title «Tải dữ liệu / Get by id»
  return (
    /Update(Command)?Handler/i.test(p) ||
    (/(Assign|Attach|Link)(Case|To)?/i.test(p) && !isQueryLikePath(p))
  );
}

/** Strip diacritics for portable VI/IT cue matching. */
function shapeBlobNorm(shapeBlob?: string | null): string {
  return String(shapeBlob || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
}

/**
 * Storage / compartment / occupied state — stronger than assign/filter when both cue.
 * Portable IT: Compartment|Storage|Slot|IsOccupied (no product nouns).
 */
export function queryImpliesStorageStateIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (
    intent.primaryClass === "state_enable" ||
    (intent.classes || []).includes("state_enable")
  ) {
    return true;
  }
  const blob = shapeBlobNorm(shapeBlob);
  return (
    /\bcompartment\b|\boccupied\b|\bisoccupied\b|\bstorage\b|\bslot\b/.test(
      blob
    ) ||
    /ngan(\s+(luu|trong|da|chua|slot))?|luu\s*tru|vi\s*tri\s*(luu|storage)|chon\s*vi\s*tri/.test(
      blob
    )
  );
}

/**
 * Authz / permission / CanWrite — Function/Title cues (not bare Module create).
 */
export function queryImpliesAuthzIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  const forbidden = (intent.forbiddenOpTokens || []).map((t) =>
    String(t || "").toLowerCase()
  );
  if (
    forbidden.some((t) =>
      /canwrite|permission|authorization|authorize|authz|deny|forbid/.test(t)
    )
  ) {
    return false;
  }
  const blob = shapeBlobNorm(shapeBlob);
  return (
    /phan\s*quyen|khong\s*quyen|quyen\s*ghi|\bpermission\b|\bauthorize\b|\bauthorization\b|\bcanwrite\b|\bforbidden\b|\bdenied\b|khong\s*(duoc\s*)?(ghi|sua|tao)/.test(
      blob
    ) ||
    (intent.featureTokens || []).some((t) =>
      /CanWrite|Permission|Authorization|Authorize/i.test(t)
    )
  );
}

/**
 * True when Function/Title/steps imply assign / filter / list (not bare Module create).
 * Portable VI/IT cues — score only; not a hard moduleGate.
 * Does not fire when storage/compartment state is the stronger op.
 */
export function queryImpliesAssignFilterIntent(
  intent: UnitIntent,
  shapeBlob?: string | null
): boolean {
  if (queryImpliesStorageStateIntent(intent, shapeBlob)) return false;
  if (
    intent.primaryClass === "filter_list" ||
    (intent.classes || []).includes("filter_list")
  ) {
    return true;
  }
  const blob = shapeBlobNorm(shapeBlob);
  // \bgan\b = gán (assign); do not match ngăn (ngan) — storage handled above
  return /(?:^|[^a-z])gan(?:[^a-z]|$)|assign|attach|\blink\b|loc\s+|bo\s*loc|\bfilter\b|list\s*available|danh\s*sach/.test(
    blob
  );
}

/**
 * Op tokens from Function/Title that must hit path/symbol for soft writeBack.
 * Portable IT stems only.
 */
export function extractOpPreferTokens(
  intent: UnitIntent,
  shapeBlob?: string | null
): string[] {
  const out: string[] = [];
  const searchish = queryImpliesSearchLookupIntent(intent, shapeBlob);
  if (queryImpliesStorageStateIntent(intent, shapeBlob)) {
    out.push(
      "Storage",
      "Compartment",
      "Slot",
      "Occupied",
      "IsOccupied",
      "Location"
    );
  }
  if (queryImpliesAuthzIntent(intent, shapeBlob)) {
    out.push("CanWrite", "Permission", "Authorization", "Authorize", "Deny");
  }
  if (searchish) {
    out.push("Search", "SearchTerm", "GetAll", "Query", "Contains");
  } else if (queryImpliesAssignFilterIntent(intent, shapeBlob)) {
    // Assign only when search/lookup is not the stronger title verb
    out.push("Assign", "Attach", "Link", "Filter");
  }
  if (queryImpliesUploadIntent(intent, shapeBlob)) {
    out.push("Upload", "Image", "Physical", "Media", "Attachment");
  }
  for (const t of intent.classFeatureTokens || []) {
    if (/Upload|Image|Physical|Media|Attachment/i.test(t)) {
      if (queryImpliesUploadIntent(intent, shapeBlob)) out.push(t);
      continue;
    }
    if (/CanWrite|Permission|Authorization|Authorize/i.test(t)) {
      if (queryImpliesAuthzIntent(intent, shapeBlob)) out.push(t);
      continue;
    }
    if (
      /IsOccupied|Occupied|Assign|Filter|Compartment|Storage|SearchTerm|GetAll/i.test(
        t
      )
    ) {
      out.push(t);
    }
  }
  const forbidden = (intent.forbiddenOpTokens || [])
    .map((t) => String(t || "").trim().toLowerCase())
    .filter(Boolean);
  if (!forbidden.length) return uniq(out);
  return uniq(out).filter((token) => {
    const low = token.toLowerCase();
    return !forbidden.some(
      (deny) => low === deny || low.includes(deny) || deny.includes(low)
    );
  });
}

/**
 * Soft writeBack refuse when op tokens from Title/Function miss the candidate path
 * (e.g. storage/compartment TC latching AssignCase with no Storage/Compartment hit).
 */
export function pathContradictsOpPreferTokens(
  pathRel: string,
  opTokens: string[] | null | undefined
): boolean {
  const ops = (opTokens || []).filter((t) => String(t || "").trim().length >= 4);
  if (!ops.length) return false;
  const p = (pathRel || "").replace(/\\/g, "/");
  const hit = ops.some((t) => {
    const tl = t.toLowerCase();
    return p.toLowerCase().includes(tl);
  });
  return !hit;
}

/**
 * Assign / Filter / List / Storage / Authz op shape adjust.
 * Boost matching Handler shapes; demote conflicting Create/Assign in same family.
 * No product nouns.
 */
export function functionOpPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  shapeBlob?: string | null
): number {
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;

  // Title search/lookup beats Function-only Assign latch
  const searchAdj = searchIntentPathShapeAdjust(pathRel, intent, shapeBlob);
  if (searchAdj !== 0) adj += searchAdj;

  // Read/get-detail beats Create latch (even when Function also says «chỉnh sửa»)
  const readAdj = readGetIntentPathShapeAdjust(pathRel, intent, shapeBlob);
  if (readAdj !== 0) adj += readAdj;

  // CRUD verb (create|update|delete) — portable path IT stems; not validate_reject alone
  const crudAdj = crudVerbPathShapeAdjust(pathRel, intent, shapeBlob);
  if (crudAdj !== 0) adj += crudAdj;

  if (queryImpliesStorageStateIntent(intent, shapeBlob)) {
    if (
      /(Storage|Compartment|Slot|Occupied|IsOccupied|Location)/i.test(p)
    ) {
      adj += 48;
    }
    // AssignCase without storage/compartment stem — common wrong latch
    if (
      /(Assign|Attach|Link)(Case|To)?/i.test(p) &&
      !/(Storage|Compartment|Slot|Occupied|Location)/i.test(p)
    ) {
      adj -= 50;
    }
    if (
      /Create(Command)?Handler/i.test(p) &&
      !/(Storage|Compartment|Slot|Occupied|Location)/i.test(p)
    ) {
      adj -= 40;
    }
    return adj;
  }

  if (queryImpliesAuthzIntent(intent, shapeBlob)) {
    if (
      /(CanWrite|Permission|Authorize|Authorization|Authz|AccessControl|Deny|Forbid)/i.test(
        p
      )
    ) {
      adj += 44;
    }
    // Prefer handlers that often embed authz checks (Assign*) over bare Create
    if (/Assign/i.test(p) && /Handler/i.test(p)) adj += 18;
    if (
      /Create(Command)?Handler/i.test(p) &&
      !/(CanWrite|Permission|Authorize|Auth)/i.test(p)
    ) {
      adj -= 28;
    }
    return adj;
  }

  // Search / read-get already applied; skip Assign boost when those dominate
  if (
    queryImpliesSearchLookupIntent(intent, shapeBlob) ||
    queryImpliesReadGetDetailIntent(intent, shapeBlob)
  ) {
    return adj;
  }

  if (!queryImpliesAssignFilterIntent(intent, shapeBlob)) return adj;
  if (
    /(Assign|Attach|Link|Filter|ListAvailable|List\w*QueryHandler)/i.test(p)
  ) {
    adj += 42;
  }
  if (
    /Create(Command)?Handler/i.test(p) &&
    !/(Assign|Attach|Link|Filter|List)/i.test(p)
  ) {
    adj -= 36;
  }
  return adj;
}

/**
 * Portable shape adjust for validate_reject / auto_generate_code + create cues.
 * Boost Create*Handler; demote signed-URL generators and compound *DocumentCreate*.
 * No product nouns.
 */
export function validateRejectPathShapeAdjust(
  pathRel: string,
  intent: UnitIntent,
  tcBlob?: string | null
): number {
  const uploadAdj = uploadIntentPathShapeAdjust(pathRel, intent, tcBlob);
  if (queryImpliesUploadIntent(intent, tcBlob)) {
    return uploadAdj;
  }
  // Assign/filter adjust is applied via functionOpPathShapeAdjust in rankHitToSeed
  if (queryImpliesAssignFilterIntent(intent, tcBlob)) {
    return 0;
  }
  const isReject =
    intent.primaryClass === "validate_reject" ||
    (intent.classes || []).includes("validate_reject");
  const isAutoCode =
    intent.primaryClass === "auto_generate_code" ||
    (intent.classes || []).includes("auto_generate_code");
  if (!isReject && !isAutoCode) return 0;
  const blob = String(tcBlob || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  if (!blob) return 0;
  const createCue = /tao\s*moi|\bcreate\b|them\s*moi|\badd\b/.test(blob);
  const dupCue =
    /trung\s*(ma|code)|duplicate|ton\s*tai|already\s*exists|ma\s*(da\s*)?(ton\s*tai|trung)|code\s*exists/.test(
      blob
    );
  const p = (pathRel || "").replace(/\\/g, "/");
  let adj = 0;
  if (createCue && /Create(Command)?Handler/i.test(p)) adj += 24;
  // create / duplicate-reject — demote Update/Delete as primary
  if (
    createCue &&
    /(Update|Delete)(Command)?Handler/i.test(p) &&
    !/Create/i.test(p)
  ) {
    adj -= 28;
  }
  // Plain entity create — demote compound *Document/File/Attachment*Create*
  if (
    createCue &&
    !/(document|attachment|tep\s*(tin|ky)|digital\s*file|file\s*ky|\bimage\b|\bmedia\b)/i.test(
      blob
    ) &&
    /(Document|File|Attachment|Image|Media|Photo|Blob)Create(Command)?Handler/i.test(p)
  ) {
    adj -= 20;
  }
  if ((dupCue || isAutoCode) && isSignedUrlOrTokenGeneratePath(p)) adj -= 36;
  if (dupCue && /CheckCode/i.test(p) && /Query/i.test(p) && !/Create/i.test(p)) {
    adj -= 10;
  }
  if (isAutoCode && /CheckCode/i.test(p) && /Query/i.test(p)) {
    adj -= 12;
  }
  return adj;
}

/**
 * Re-score one path candidate with body-rule hits from its excerpt.
 */
/** Patterns used for body-rule hit detection (never bare Upload/Create/Add). */
export function bodyRulePatternsForIntent(intent: UnitIntent): string[] {
  const raw =
    intent.rulePatterns?.length
      ? intent.rulePatterns
      : intent.requiresBodyRule
        ? (intent.codePatterns || []).filter(
            (p) => !/^(upload|initupload|download)$/i.test(p)
          )
        : intent.codePatterns || [];
  return filterStrongBodyRulePatterns(raw);
}

/** Portable stopwords — not product nouns. */
const TC_AFFINITY_STOP = new Set([
  "the",
  "and",
  "for",
  "with",
  "when",
  "from",
  "that",
  "this",
  "into",
  "then",
  "than",
  "have",
  "has",
  "was",
  "are",
  "were",
  "been",
  "will",
  "can",
  "not",
  "but",
  "all",
  "any",
  "via",
  "per",
  "trace",
  "input",
  "output",
  "mock",
  "assert",
  "step",
  "steps",
  "test",
  "data",
  "type",
  "unit",
  "true",
  "false",
  "null",
  "void",
  "async",
  "await",
  "return",
  "throw",
  "class",
  "public",
  "private",
  "string",
  "system",
  "he",
  "thong",
  "toan",
  "va",
  "cua",
  "cac",
  "la",
  "duoc",
  "khi",
  "cho",
  "voi",
  "trong",
  "tren",
  "mot",
  "nay",
  "kia",
  "theo",
  "de",
  "da",
  "se",
  "dang",
  "rat",
  "nhu",
  "lai",
  "ve",
  "tai",
  "sau",
  "truoc",
  "nhung",
  "hoac",
  "neu",
  "hay",
  "len",
  "xuong",
  "goi",
  "kiem",
  "tra",
  "bo",
  "phan",
  "ket",
  "qua",
  "loi",
  "ngoai",
  "le",
]);

function stripAffinityText(s: string): string {
  return String(s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D")
    .toLowerCase();
}

/**
 * Phrases from TC title/module/expected for excerpt affinity.
 * Portable: any language tokens present in both TC and SUT strings/comments.
 */
export function extractTcAffinityPhrases(tcBlob: string | null | undefined): string[] {
  const ascii = stripAffinityText(tcBlob || "");
  if (!ascii) return [];
  const words = ascii
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !TC_AFFINITY_STOP.has(w));
  const out: string[] = [];
  for (let i = 0; i < words.length; i++) {
    const w = words[i]!;
    if (w.length >= 5) out.push(w);
    if (i + 1 < words.length) {
      const bi = `${w} ${words[i + 1]}`;
      if (bi.replace(/\s/g, "").length >= 6) out.push(bi);
    }
    if (i + 2 < words.length) {
      const tri = `${w} ${words[i + 1]} ${words[i + 2]}`;
      if (tri.replace(/\s/g, "").length >= 9) out.push(tri);
    }
  }
  return uniq(out).slice(0, 48);
}

/**
 * Boost when SUT excerpt/path shares phrases, preferTokens, or tech stems with the TC.
 * Breaks cross-family CreateHandler ties without product aliases.
 */
export function extractExcerptTechStems(
  excerpt: string | null | undefined
): string[] {
  const text = excerpt || "";
  if (!text) return [];
  const out: string[] = [];
  for (const m of text.matchAll(
    /\b([A-Z][A-Za-z0-9]{2,}(?:Code|Exists|Duplicate|Unique|Handler|Service)?)\b/g
  )) {
    const s = m[1] || "";
    if (s.length >= 4) out.push(s);
  }
  for (const m of text.matchAll(
    /\b([a-z][a-zA-Z0-9]{4,}(?:Code|Exists|Duplicate))\b/g
  )) {
    const s = m[1] || "";
    if (s.length >= 5) out.push(s);
  }
  return uniq(out).slice(0, 32);
}

export function tcExcerptAffinityBoost(
  excerpt: string | null | undefined,
  tcBlob: string | null | undefined,
  opts?: {
    preferTokens?: string[] | null;
    pathRel?: string | null;
  }
): { boost: number; hits: string[] } {
  const phrases = extractTcAffinityPhrases(tcBlob);
  const ex = stripAffinityText(excerpt || "");
  const pathLow = stripAffinityText(opts?.pathRel || "").replace(
    /[^a-z0-9/]/g,
    ""
  );
  const tcLow = stripAffinityText(tcBlob || "");
  const hits: string[] = [];
  let boost = 0;

  if (phrases.length && ex) {
    const phraseHits: string[] = [];
    for (const p of phrases) {
      if (ex.includes(p)) phraseHits.push(p);
    }
    phraseHits.sort(
      (a, b) =>
        b.split(/\s+/).length - a.split(/\s+/).length || b.length - a.length
    );
    for (const h of phraseHits.slice(0, 8)) {
      hits.push(h);
      const n = h.split(/\s+/).length;
      if (n >= 3) boost += 24;
      else if (n === 2) boost += 20;
      else if (h.length >= 8) boost += 10;
      else boost += 6;
    }
  }

  // preferTokens ↔ path / excerpt (portable domain nudge)
  for (const raw of (opts?.preferTokens || []).slice(0, 12)) {
    const t = String(raw || "")
      .toLowerCase()
      .replace(/[^a-z0-9]/g, "");
    if (t.length < 4) continue;
    if (
      /^(create|update|delete|reject|deny|checkcode|validation|trace|input|mock)$/i.test(
        t
      )
    ) {
      continue;
    }
    if (pathLow.includes(t) || (ex && ex.replace(/[^a-z0-9]/g, "").includes(t))) {
      hits.push(`prefer:${raw}`);
      boost += 14;
    }
  }

  // Tech stems from excerpt that also appear in TC blob (errorKey / identifier)
  if (ex && tcLow) {
    const stems = extractExcerptTechStems(excerpt);
    const tcCompact = tcLow.replace(/[^a-z0-9]/g, "");
    for (const stem of stems.slice(0, 16)) {
      const s = stem.toLowerCase();
      if (s.length < 6) continue;
      if (tcCompact.includes(s) || tcLow.includes(s)) {
        hits.push(`techStem:${stem}`);
        boost += 12;
      }
    }
  }

  if (!hits.length) return { boost: 0, hits: [] };
  return { boost: Math.min(boost, 72), hits: uniq(hits).slice(0, 8) };
}

export type ApplyBodyRuleOpts = {
  preferTokens?: string[] | null;
};

export function applyBodyRuleToCandidate(
  cand: BodyRuleCandidateIn,
  excerpt: string,
  intent: UnitIntent,
  tcBlob?: string | null,
  opts?: ApplyBodyRuleOpts | null
): BodyRuleScoredCandidate {
  const ruleHits = findBodyRuleHits(excerpt, bodyRulePatternsForIntent(intent));
  let score = cand.score + bodyRuleScoreBoost(ruleHits.length);
  score -= infraPathDemoteScore(cand.pathRel, intent);
  score += validateRejectPathShapeAdjust(cand.pathRel, intent, tcBlob);
  const affinity = tcExcerptAffinityBoost(excerpt, tcBlob, {
    preferTokens: opts?.preferTokens,
    pathRel: cand.pathRel,
  });
  score += affinity.boost;
  if (
    intent.requiresBodyRule &&
    looksLikeFeShell(cand.pathRel) &&
    ruleHits.length === 0
  ) {
    score -= UNIT_BODY_RULE.feValidationPenalty;
  }
  const hitNote =
    ruleHits.length > 0 ? ` bodyRule:${ruleHits.slice(0, 4).join("+")}` : "";
  const affNote =
    affinity.hits.length > 0
      ? ` tcPhrase:${affinity.hits.slice(0, 3).join("+")}`
      : "";
  return {
    ...cand,
    baseScore: cand.score,
    score,
    ruleHits,
    reason: `${cand.reason || "seed"}${hitNote}${affNote}`.trim(),
    hits: uniq([
      ...(cand.hits || []),
      ...ruleHits.map((h) => `rule:${h}`),
      ...affinity.hits.map((h) =>
        h.startsWith("prefer:") || h.startsWith("techStem:")
          ? h
          : `phrase:${h}`
      ),
    ]),
  };
}

export type PickBodyRuleOpts = {
  minScore?: number;
  minMargin?: number;
  minRatio?: number;
  /**
   * Domain / tech tokens from Requirement→Module→Title (+ project aliases).
   * Break cross-family score ties without treating them as ambiguous margin.
   */
  preferTokens?: string[] | null;
  /** Full TC blob for verb contradiction (upload≠Delete, search≠Assign). */
  shapeBlob?: string | null;
};

/** Count how many prefer tokens hit the path (portable domain nudge). */
export function countPreferTokenHits(
  pathRel: string,
  preferTokens: string[] | null | undefined
): number {
  const tokens = (preferTokens || [])
    .map((t) =>
      String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
    )
    .filter((t) => t.length >= 3);
  if (!tokens.length) return 0;
  const p = normPath(pathRel).replace(/[^a-z0-9/]/g, "");
  let n = 0;
  for (const t of tokens) {
    if (p.includes(t)) n += 1;
  }
  return n;
}

function affinitySignalCount(c: BodyRuleScoredCandidate): number {
  return (c.hits || []).filter((h) =>
    /^(phrase:|prefer:|techStem:)/i.test(String(h || ""))
  ).length;
}

function crossFamilyDifferentialOk(
  best: BodyRuleScoredCandidate,
  second: BodyRuleScoredCandidate,
  preferTokens: string[] | null | undefined,
  margin: number,
  minMargin: number
): boolean {
  const preferDiff =
    countPreferTokenHits(best.pathRel, preferTokens) -
    countPreferTokenHits(second.pathRel, preferTokens);
  const affDiff = affinitySignalCount(best) - affinitySignalCount(second);
  const strongMargin = margin >= Math.max(minMargin * 1.5, 36);
  return preferDiff > 0 || affDiff > 0 || strongMargin;
}

/**
 * Fail-closed pick after body-rule rescoring.
 * When intent.requiresBodyRule → best must have ≥1 ruleHits.
 */
export function decideBodyRuleWriteBack(
  scored: BodyRuleScoredCandidate[],
  intent: UnitIntent,
  opts?: PickBodyRuleOpts
): BodyRuleWriteDecision {
  const minScore = opts?.minScore ?? 56;
  const minMargin = opts?.minMargin ?? 20;
  const minRatio = opts?.minRatio ?? 1.45;
  const prefer = opts?.preferTokens;
  const shapeBlob = opts?.shapeBlob ?? null;

  const sorted = [...scored].sort(
    (a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel)
  );
  const top3 = sorted.slice(0, 3).map((c) => ({
    pathRel: c.pathRel,
    score: c.score,
    baseScore: c.baseScore,
    ruleHits: c.ruleHits,
  }));

  const formatTop = () =>
    top3
      .map(
        (c) =>
          `${c.pathRel.split("/").pop()}(${c.score},hits=${c.ruleHits.join("|") || "0"})`
      )
      .join(", ");

  if (!sorted.length) {
    return {
      writeBack: false,
      seed: null,
      skipReason: "no candidates after logic-layer filter",
      candidatesTop3: [],
    };
  }

  let usable = sorted.filter(
    (c) =>
      !pathContradictsUploadVerb(c.pathRel, intent, shapeBlob) &&
      !pathContradictsSearchVerb(c.pathRel, intent, shapeBlob) &&
      !pathContradictsReadGetVerb(c.pathRel, intent, shapeBlob)
  );
  if (!usable.length) {
    return {
      writeBack: false,
      seed: null,
      skipReason: `verb contradict (upload≠Delete / search≠Assign / read≠Create); top3: ${formatTop()}`,
      candidatesTop3: top3,
    };
  }

  if (intent.requiresBodyRule) {
    usable = usable.filter((c) => c.ruleHits.length >= 1);
    // auto_generate_code: require empty-code assign shape (not random IsNullOr* alone)
    if (
      intent.primaryClass === "auto_generate_code" ||
      (intent.classes || []).includes("auto_generate_code")
    ) {
      const strong = usable.filter((c) =>
        c.ruleHits.some((h) =>
          /IsNullOrWhiteSpace|IsNullOrEmpty|Generate|Empty|Blank|userProvidedCode/i.test(
            h
          )
        )
      );
      if (strong.length) usable = strong;
    }
    if (!usable.length) {
      return {
        writeBack: false,
        seed: null,
        skipReason: `body-rule required but no pattern hits; top3: ${formatTop()}`,
        candidatesTop3: top3,
      };
    }
  }

  // IUploadService vs UploadService (same score) is not ambiguity — prefer impl;
  // GetUploadActivityQuery should not veto UploadService write-back.
  usable = collapseBodyRuleContenders(usable);
  usable = usable.filter(
    (c) =>
      !pathContradictsUploadVerb(c.pathRel, intent, shapeBlob) &&
      !pathContradictsSearchVerb(c.pathRel, intent, shapeBlob) &&
      !pathContradictsReadGetVerb(c.pathRel, intent, shapeBlob)
  );
  if (!usable.length) {
    return {
      writeBack: false,
      seed: null,
      skipReason: `verb contradict after collapse; top3: ${formatTop()}`,
      candidatesTop3: top3,
    };
  }

  const best = usable[0];
  if (!best || best.score < minScore) {
    return {
      writeBack: false,
      seed: null,
      skipReason: `body-rule score below min (${best?.score ?? 0}<${minScore}); top3: ${formatTop()}`,
      candidatesTop3: top3,
    };
  }

  const second = usable[1];
  if (second) {
    const margin = best.score - second.score;
    const ratioOk = best.score >= second.score * minRatio;
    const famBest = unitFeatureFamilyKey(best.pathRel);
    const famSecond = unitFeatureFamilyKey(second.pathRel);
    const sameFamily = Boolean(famBest && famBest === famSecond);
    const crossFamily = Boolean(famBest && famSecond && !sameFamily);

    const pickByPrefer = (): BodyRuleScoredCandidate | null => {
      if (!prefer?.length) return null;
      const ranked = [...usable].sort(
        (a, b) =>
          countPreferTokenHits(b.pathRel, prefer) -
            countPreferTokenHits(a.pathRel, prefer) ||
          affinitySignalCount(b) - affinitySignalCount(a) ||
          unitPrimaryShapeRank(b.pathRel) - unitPrimaryShapeRank(a.pathRel) ||
          b.score - a.score ||
          a.pathRel.localeCompare(b.pathRel)
      );
      const pick = ranked[0]!;
      const runner = ranked[1];
      const pickHits = countPreferTokenHits(pick.pathRel, prefer);
      const runnerHits = runner
        ? countPreferTokenHits(runner.pathRel, prefer)
        : 0;
      const affPick = affinitySignalCount(pick);
      const affRun = runner ? affinitySignalCount(runner) : 0;
      if (pickHits > 0 && pickHits > runnerHits) return pick;
      if (affPick > affRun) return pick;
      return null;
    };

    if (margin < minMargin && !ratioOk) {
      // Last resort: interface vs impl same family still in list
      if (
        isInterfaceLikePrimaryPath(best.pathRel) !==
          isInterfaceLikePrimaryPath(second.pathRel) &&
        margin === 0
      ) {
        const seed = isInterfaceLikePrimaryPath(best.pathRel) ? second : best;
        return {
          writeBack: true,
          seed,
          candidatesTop3: top3,
        };
      }
      // Same feature family after progressive Req (e.g. DigitalFile Create/Handler/Delete)
      // is not real ambiguity — pick best shape.
      if (sameFamily) {
        const pick =
          unitPrimaryShapeRank(best.pathRel) >=
          unitPrimaryShapeRank(second.pathRel)
            ? best
            : second;
        if (
          pathContradictsUploadVerb(pick.pathRel, intent, shapeBlob) ||
          pathContradictsSearchVerb(pick.pathRel, intent, shapeBlob) ||
          pathContradictsReadGetVerb(pick.pathRel, intent, shapeBlob)
        ) {
          const alt = usable.find(
            (c) =>
              !pathContradictsUploadVerb(c.pathRel, intent, shapeBlob) &&
              !pathContradictsSearchVerb(c.pathRel, intent, shapeBlob) &&
              !pathContradictsReadGetVerb(c.pathRel, intent, shapeBlob)
          );
          if (alt) {
            return { writeBack: true, seed: alt, candidatesTop3: top3 };
          }
          return {
            writeBack: false,
            seed: null,
            skipReason: `same-family verb contradict; top3: ${formatTop()}`,
            candidatesTop3: top3,
          };
        }
        return {
          writeBack: true,
          seed: pick,
          candidatesTop3: top3,
        };
      }
      // Soft: clear #1 with strictly more body-rule hits (e.g. Create vs DocumentCreate)
      if (margin >= 8 && best.ruleHits.length > second.ruleHits.length) {
        return {
          writeBack: true,
          seed: best,
          candidatesTop3: top3,
        };
      }
      const preferPick = pickByPrefer();
      if (preferPick) {
        return {
          writeBack: true,
          seed: preferPick,
          candidatesTop3: top3,
        };
      }
      return {
        writeBack: false,
        seed: null,
        skipReason: `body-rule ambiguous margin; top3: ${formatTop()}`,
        candidatesTop3: top3,
      };
    }

    // Margin OK but different families: require prefer/affinity differential or strong margin
    if (
      crossFamily &&
      !crossFamilyDifferentialOk(best, second, prefer, margin, minMargin)
    ) {
      const preferPick = pickByPrefer();
      if (preferPick) {
        return {
          writeBack: true,
          seed: preferPick,
          candidatesTop3: top3,
        };
      }
      return {
        writeBack: false,
        seed: null,
        skipReason: `body-rule cross-family weak differential; top3: ${formatTop()}`,
        candidatesTop3: top3,
      };
    }
  }

  return {
    writeBack: true,
    seed: best,
    candidatesTop3: top3,
  };
}

/** Compact log line for Activity / Grounding (P3.2). */
export function formatBodyRuleLog(
  decision: BodyRuleWriteDecision,
  extra?: {
    intentClass?: string | null;
    matchedIntentIds?: string[] | null;
    domainGuard?: string | null;
    softSignalOk?: boolean | null;
  }
): string {
  const top = decision.candidatesTop3
    .map(
      (c) =>
        `${c.pathRel}:${c.score}[${c.ruleHits.join("+") || "-"}]`
    )
    .join("; ");
  const seedHits = decision.seed?.hits || [];
  const signals = uniq(
    seedHits
      .map((h) => String(h).split(":")[0] || "")
      .filter((s) => /^(alias|prefer|phrase|tech|techStem|rule|sutMap)$/i.test(s))
  );
  const bits: string[] = [];
  if (extra?.intentClass?.trim()) bits.push(`intent=${extra.intentClass.trim()}`);
  if (extra?.matchedIntentIds?.length) {
    bits.push(`projectIntents=${extra.matchedIntentIds.join("|")}`);
  }
  if (extra?.domainGuard?.trim()) bits.push(`domainGuard=${extra.domainGuard.trim()}`);
  if (extra?.softSignalOk === false) bits.push("softSignal=no");
  if (extra?.softSignalOk === true) bits.push("softSignal=yes");
  if (signals.length) bits.push(`signals=${signals.join("|")}`);
  const extraNote = bits.length ? ` ${bits.join(" ")}` : "";
  return `candidatesTop3=${top || "-"} writeBack=${decision.writeBack ? "yes" : "no"}${
    decision.seed
      ? ` score=${decision.seed.score} ruleHits=${decision.seed.ruleHits.join(",") || "-"}${extraNote}`
      : decision.skipReason
        ? ` skip=${decision.skipReason}${extraNote}`
        : extraNote
  }`;
}
