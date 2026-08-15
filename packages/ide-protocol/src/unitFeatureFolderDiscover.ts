/**
 * Discover feature-folder tokens from index bridge hits (portable).
 *
 * Flow: title/intent → IT bridge needles (CheckCode, Assign, InitUpload…)
 *     → paths/symbols on *this* index → CQRS folder segment under Commands/X/
 *
 * No product folder nouns (Evidence, Order, CasePerson…). Folder names come
 * only from paths that already exist on the SUT index.
 */
import type { UnitIntent } from "./unitIntentAliases.js";
import {
  filterStrongRankTokens,
  isWeakUnitRankToken,
  UNIT_WEAK_RANK_TOKENS,
} from "./unitSutGate.js";

/** Minimal index shape — Desktop CodeIndexSnapshot is compatible. */
export type FeatureFolderIndexLike = {
  files?: Record<string, unknown>;
  symbolsByFile?: Record<string, Array<{ name?: string }>>;
  symbolIndex?: Record<string, string[]>;
};

/**
 * Cross-cutting infra path segments — demote on domain behavior intents.
 * Auth/Mail/Notification only (IT shape).
 */
export const UNIT_INFRA_PATH_TOKENS = [
  "Authentication",
  "AuthService",
  "Mail",
  "MailService",
  "ImageProcessing",
  "Notification",
  "WebNotification",
] as const;

/** Infra Auth/Mail/Notification or signed-URL generator — soft writeBack caution. */
export function isCrossCuttingSoftPrimaryPath(pathRel: string): boolean {
  return isInfraCrossCuttingPath(pathRel);
}

/**
 * Soft writeBack: refuse Auth/Mail/Notification/signed-URL primary unless
 * module/prefer tokens hit the same infra stem on the path.
 */
export function softCrossCuttingDenied(
  pathRel: string,
  gateOrPreferTokens: string[] | null | undefined
): boolean {
  if (!isCrossCuttingSoftPrimaryPath(pathRel)) return false;
  const toks = (gateOrPreferTokens || [])
    .map((t) =>
      String(t || "")
        .toLowerCase()
        .replace(/[^a-z0-9]/g, "")
    )
    .filter((t) => t.length >= 4);
  if (!toks.length) return true;
  const p = normPath(pathRel).toLowerCase().replace(/[^a-z0-9/]/g, "");
  if (isSignedUrlOrTokenGeneratePath(pathRel)) {
    return !toks.some((t) => /url|token|presign|signed|link/i.test(t));
  }
  const pathInfra = UNIT_INFRA_PATH_TOKENS.map((t) =>
    t.toLowerCase().replace(/[^a-z0-9]/g, "")
  ).filter((s) => s.length >= 4 && p.includes(s));
  if (!pathInfra.length) return true;
  return !toks.some((t) =>
    pathInfra.some((s) => t.includes(s) || s.includes(t))
  );
}

/**
 * Signed/presigned URL or access-token generators — not domain create/validate.
 */
export function isSignedUrlOrTokenGeneratePath(pathRel: string): boolean {
  const base =
    (pathRel || "").replace(/\\/g, "/").split("/").pop() || String(pathRel || "");
  if (!base) return false;
  if (/(Presigned|PreSigned|SignedUrl|SignedLink)/i.test(base)) return true;
  if (
    /^(Generate|Create|Request)[A-Za-z0-9]*(Url|Link|Token)(Command)?Handler\b/i.test(
      base
    )
  ) {
    return true;
  }
  return false;
}

const WEAK_FOLDER_SEGMENTS = new Set([
  ...UNIT_WEAK_RANK_TOKENS,
  "src",
  "app",
  "application",
  "domain",
  "infrastructure",
  "commands",
  "queries",
  "queryhandlers",
  "handlers",
  "services",
  "controllers",
  "dtos",
  "dto",
  "entities",
  "entity",
  "interfaces",
  "abstractions",
  "mapping",
  "models",
  "common",
  "shared",
  "core",
  "api",
  "web",
  "clientapp",
  "admin",
  "client",
  "component",
  "components",
  "pages",
  "hooks",
  "utils",
  "helpers",
  "basic",
  "test",
  "tests",
  "unit",
]);

/** IT bridges that may appear literally in title / tech stems. */
const TITLE_BRIDGE_STEMS = [
  "CheckCode",
  "IsOccupied",
  "MaxFileSize",
  "FileSize",
  "InitUpload",
  "Duplicate",
  "AlreadyExists",
  "Assign",
] as const;

/** IT needles — never promoted to feature-folder votes. */
const IT_NEEDLE_SET = new Set(
  [
    ...TITLE_BRIDGE_STEMS,
    "Person",
    "Device",
    "Image",
    "Upload",
  ].map((s) => s.toLowerCase())
);

function normTitleBlob(titleTokens: string[]): { blob: string; compact: string } {
  const blob = titleTokens
    .join(" ")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase();
  return { blob, compact: blob.replace(/\s+/g, "") };
}

/**
 * VI/EN → portable IT bridge stems only.
 * Folder nouns are never returned — only CheckCode / Assign / InitUpload / …
 */
export function titleCueBridgeStems(titleTokens: string[]): string[] {
  const { blob, compact } = normTitleBlob(titleTokens);
  const out: string[] = [];

  if (
    /checkcode|kiemtra|validator|maxlength|alreadyexist|duplicate|trungma|unique/.test(
      compact
    ) ||
    /\b(kiem\s*tra|validator|maxlength|trung|duplicate|unique|mo\s*ta|description)\b/.test(
      blob
    )
  ) {
    out.push("CheckCode", "Duplicate", "AlreadyExists");
  }

  if (
    /isoccupied|compartment|vitriluutru|luutru/.test(compact) ||
    /\b(isoccupied|compartment|vi\s*tri|luu\s*tru)\b/.test(blob)
  ) {
    out.push("IsOccupied");
  }

  if (
    /assign|attach|link|gan\b|gắn|gán/.test(blob.replace(/\s+/g, " ")) ||
    /\b(assign|attach|gan)\b/.test(blob)
  ) {
    out.push("Assign");
  }

  // Role / asset IT stems (EN) — hit *Person* / *Device* folders on index if present
  if (/\bnguoi\s*(so\s*huu|su\s*dung|lien\s*quan)\b/.test(blob)) {
    out.push("Person");
  }
  if (
    !/khong\s*phai\s*ky\s*thuat/.test(blob) &&
    (/\b(thiet\s*bi|imei|device)\b/.test(blob) || /thietbi|\bimei\b/.test(compact))
  ) {
    out.push("Device");
  }

  if (
    /hinhanh|tailen|initupload/.test(compact) ||
    /\b(hinh\s*anh|tai\s*len|upload|image)\b/.test(blob)
  ) {
    out.push("InitUpload", "Image");
  }

  const hasFamily = out.some((s) =>
    /^(Assign|Person|Device|InitUpload|Image|IsOccupied)$/i.test(s)
  );
  if (
    (/taomoi|themmoi|\bcreate\b/.test(compact) ||
      /\b(tao\s*moi|them\s*moi|create)\b/.test(blob)) &&
    !hasFamily &&
    !out.includes("CheckCode")
  ) {
    out.push("CheckCode");
  }

  return out;
}

/** @deprecated use titleCueBridgeStems; kept for callers that imported kinds. */
export type TitleDiscoverKinds = {
  dossier: boolean;
  person: boolean;
  device: boolean;
  upload: boolean;
  storage: boolean;
  create: boolean;
  describe: boolean;
};

/** @deprecated thin adapter — prefer titleCueBridgeStems. */
export function titleDiscoverKinds(titleTokens: string[]): TitleDiscoverKinds {
  const stems = new Set(titleCueBridgeStems(titleTokens).map((s) => s.toLowerCase()));
  const { blob, compact } = normTitleBlob(titleTokens);
  return {
    dossier: /\b(ho\s*so|vu\s*an|dossier)\b/.test(blob),
    person: stems.has("person"),
    device: stems.has("device"),
    upload: stems.has("initupload") || stems.has("image"),
    storage: stems.has("isoccupied"),
    create:
      /taomoi|themmoi|\bcreate\b/.test(compact) ||
      /\b(tao\s*moi|them\s*moi|create)\b/.test(blob),
    describe: /\b(mo\s*ta|description)\b/.test(blob),
  };
}

/**
 * CQRS/feature folder under Commands|Queries|… — preferred discover vote.
 */
export function featureFolderSegmentFromPath(pathRel: string): string | null {
  const p = normPath(pathRel);
  const m = p.match(
    /\/(?:Commands|Queries|QueryHandlers|CommandHandlers|Handlers|Features|Modules|UseCases)\/([^/]+)\//i
  );
  if (!m?.[1]) return null;
  const seg = m[1];
  if (seg.length < 3) return null;
  if (WEAK_FOLDER_SEGMENTS.has(seg.toLowerCase())) return null;
  return seg;
}

function isUbiquitousPathToken(tok: string, paths: string[]): boolean {
  const tl = tok.toLowerCase();
  if (tl.length < 4 || !paths.length) return false;
  const limit = Math.max(24, Math.floor(paths.length * 0.12));
  let hits = 0;
  for (const p of paths) {
    if (p.toLowerCase().includes(tl)) {
      hits++;
      if (hits > limit) return true;
    }
  }
  return false;
}

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
  return (p || "").replace(/\\/g, "/");
}

function isSpaOrComponentPath(pathRel: string): boolean {
  return /ClientApp|\.component\.[jt]sx?$|\/pages\/|\/hooks\//i.test(pathRel);
}

/** Split path into segment tokens (folder names + file stem). */
export function pathSegmentTokens(pathRel: string): string[] {
  const p = normPath(pathRel);
  const parts = p.split("/").filter(Boolean);
  const out: string[] = [];
  for (const part of parts) {
    const stem = part.replace(/\.[^.]+$/, "");
    const words = stem
      .replace(/([a-z])([A-Z])/g, "$1 $2")
      .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
      .split(/[^A-Za-z0-9]+/)
      .filter(Boolean);
    for (const w of words) {
      if (w.length >= 4 && !WEAK_FOLDER_SEGMENTS.has(w.toLowerCase())) {
        out.push(w);
      }
    }
    if (
      stem.length >= 4 &&
      !WEAK_FOLDER_SEGMENTS.has(stem.toLowerCase()) &&
      !/handler$/i.test(stem) &&
      !/query$/i.test(stem) &&
      !/command$/i.test(stem) &&
      !/service$/i.test(stem)
    ) {
      out.push(stem);
    }
  }
  return uniq(out);
}

function textHasBridge(hay: string, bridge: string): boolean {
  const h = hay.toLowerCase();
  const b = bridge.toLowerCase();
  if (b.length < 3) return false;
  return h.includes(b);
}

/** Collect bridge needles from intent rulePatterns + TC title bridges. */
export function bridgeNeedlesForDiscover(
  intent: Pick<
    UnitIntent,
    "rulePatterns" | "codePatterns" | "classFeatureTokens"
  > | null | undefined,
  titleTokens: string[] = []
): string[] {
  const fromIntent = [...(intent?.rulePatterns || [])]
    .map((p) => String(p || "").replace(/^\(\?i\)/, "").split(/[|\\]/)[0] || "")
    .map((p) => p.replace(/[^A-Za-z0-9_]/g, "").trim())
    .filter((p) => p.length >= 4 && !isWeakUnitRankToken(p))
    .filter(
      (p) =>
        !/^(throw|validate|exists|any|generate|exceed|badrequest|argumentexception)$/i.test(
          p
        )
    );

  const titleLow = titleTokens.map((t) => t.toLowerCase());
  const fromTitleBridges = TITLE_BRIDGE_STEMS.filter((s) => {
    const sl = s.toLowerCase();
    return titleLow.some(
      (t) => t === sl || (t.length >= sl.length && t.includes(sl))
    );
  });
  const fromTitleCues = titleCueBridgeStems(titleTokens);

  return filterStrongRankTokens(
    uniq([...fromIntent, ...fromTitleBridges, ...fromTitleCues])
  );
}

export type DiscoverFeatureFoldersOpts = {
  intent?: Pick<
    UnitIntent,
    | "rulePatterns"
    | "codePatterns"
    | "classFeatureTokens"
    | "requiresBodyRule"
    | "primaryClass"
    | "classes"
  > | null;
  titleTokens?: string[];
  bridgeNeedles?: string[];
  maxFolders?: number;
};

export type DiscoverFeatureFoldersResult = {
  featureTokens: string[];
  bridgePaths: string[];
  bridgeNeedles: string[];
};

/**
 * Narrow Assign bridges when title is case-dossier (hồ sơ / dossier):
 * keep Assign*Case* / Case*Assign* compounds only — portable IT shape.
 */
function narrowAssignBridgesForDossier(
  bridges: string[],
  titleTokens: string[]
): string[] {
  const { blob } = normTitleBlob(titleTokens);
  if (!/\b(ho\s*so|vu\s*an|dossier)\b/.test(blob)) return bridges;
  const dossier = bridges.filter((p) =>
    /Assign\w*Case|Case\w*Assign/i.test(p)
  );
  return dossier.length ? dossier : bridges;
}

/**
 * When a role/asset IT needle is active, keep bridges that actually hit it
 * (Person→*Person*, Device→*Device*, Image→*Image*|Upload*).
 */
function narrowBridgesByActiveNeedles(
  bridges: string[],
  needles: string[]
): string[] {
  const has = (n: string) => needles.some((x) => x.toLowerCase() === n);
  let out = bridges;
  if (has("person")) {
    const hit = out.filter(
      (p) => /Person/i.test(p) && !/PersonImage|ImagePerson/i.test(p)
    );
    if (hit.length) out = hit;
  }
  if (has("device")) {
    const hit = out.filter((p) => /Device/i.test(p));
    if (hit.length) out = hit;
  }
  if (has("isoccupied")) {
    const hit = out.filter(
      (p) =>
        /IsOccupied/i.test(p) ||
        /\/[^/]*(Storage|Compartment)[^/]*\//i.test(p)
    );
    if (hit.length) out = hit;
  }
  if (has("image") || has("initupload")) {
    const hit = out.filter(
      (p) =>
        /InitUpload/i.test(p) ||
        (/Image/i.test(p) && !/^Person/i.test(p.split("/").pop() || "")) ||
        (/Upload/i.test(p) && /Services|Upload/i.test(p))
    );
    if (hit.length) out = hit;
  }
  return out;
}

/**
 * From index: needles → bridge paths → CQRS feature folder tokens.
 */
export function discoverFeatureFoldersFromIndex(
  index: FeatureFolderIndexLike | null | undefined,
  allPaths?: string[] | null,
  opts?: DiscoverFeatureFoldersOpts
): DiscoverFeatureFoldersResult {
  const paths = uniq([
    ...(allPaths || []).map(normPath),
    ...Object.keys(index?.files || {}).map(normPath),
  ]);
  const titleTokens = opts?.titleTokens || [];
  const needles = uniq([
    ...(opts?.bridgeNeedles || []),
    ...bridgeNeedlesForDiscover(opts?.intent, titleTokens),
  ]);
  if (!paths.length || !needles.length) {
    return { featureTokens: [], bridgePaths: [], bridgeNeedles: needles };
  }

  const bridgePaths: string[] = [];
  const addBridge = (pathRel: string) => {
    const np = normPath(pathRel);
    if (!np || isSpaOrComponentPath(np) || bridgePaths.includes(np)) return;
    bridgePaths.push(np);
  };

  for (const pathRel of paths) {
    if (isSpaOrComponentPath(pathRel)) continue;
    const base = pathRel.split("/").pop() || pathRel;
    const syms = (index?.symbolsByFile?.[pathRel] || [])
      .map((s) => s.name || "")
      .join(" ");
    const hay = `${pathRel} ${base} ${syms}`;
    if (needles.some((n) => textHasBridge(hay, n))) addBridge(pathRel);
  }
  const symIndex = index?.symbolIndex || {};
  for (const n of needles) {
    const key = n.toLowerCase();
    for (const [sym, plist] of Object.entries(symIndex)) {
      if (!textHasBridge(sym, n) && sym !== key) continue;
      for (const p of plist || []) addBridge(p);
    }
  }

  let bridges = narrowAssignBridgesForDossier(bridgePaths, titleTokens);
  bridges = narrowBridgesByActiveNeedles(bridges, needles);

  const uploadActive = needles.some((n) =>
    /^(InitUpload|Image|MaxFileSize|FileSize)$/i.test(n)
  );
  const folderVotes = new Map<string, number>();
  const vote = (tok: string, weight: number) => {
    if (!tok || tok.length < 3) return;
    if (IT_NEEDLE_SET.has(tok.toLowerCase())) return;
    if (isWeakUnitRankToken(tok) && !(uploadActive && /^Upload$/i.test(tok))) {
      return;
    }
    if (WEAK_FOLDER_SEGMENTS.has(tok.toLowerCase())) return;
    if (
      /^(assign|unassign|case|dialog|controller|overview|report|home|record|digital|devices)$/i.test(
        tok
      )
    ) {
      return;
    }
    if (isUbiquitousPathToken(tok, paths)) return;
    if (/Test$/i.test(tok) || /HandlersTest/i.test(tok)) return;
    folderVotes.set(tok, (folderVotes.get(tok) || 0) + weight);
  };

  for (const p of bridges.slice(0, 64)) {
    const feat = featureFolderSegmentFromPath(p);
    if (feat) {
      vote(feat, 3);
      continue;
    }
    if (/\/Services\//i.test(p)) {
      for (const tok of pathSegmentTokens(p)) vote(tok, 1);
    }
  }

  const ranked = [...folderVotes.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([t]) => t);
  const maxFolders = opts?.maxFolders ?? 8;
  const strong = filterStrongRankTokens(ranked);
  if (
    uploadActive &&
    ranked.some((t) => /^Upload$/i.test(t)) &&
    !strong.some((t) => /^Upload$/i.test(t))
  ) {
    strong.unshift("Upload");
  }
  return {
    featureTokens: strong.slice(0, maxFolders),
    bridgePaths: bridges.slice(0, 24),
    bridgeNeedles: needles,
  };
}

export function isInfraCrossCuttingPath(pathRel: string): boolean {
  const p = normPath(pathRel);
  if (
    UNIT_INFRA_PATH_TOKENS.some((t) =>
      p.toLowerCase().includes(t.toLowerCase())
    )
  ) {
    return true;
  }
  return isSignedUrlOrTokenGeneratePath(p);
}

export function infraPathDemoteScore(
  pathRel: string,
  intent?: Pick<
    UnitIntent,
    "requiresBodyRule" | "primaryClass" | "classes"
  > | null
): number {
  const behavior =
    Boolean(intent?.requiresBodyRule) ||
    intent?.primaryClass === "validate_reject" ||
    intent?.primaryClass === "state_enable" ||
    (intent?.classes || []).some((c) =>
      [
        "validate_reject",
        "state_enable",
        "filter_list",
        "persist_create",
        "persist_update",
      ].includes(c)
    );
  if (!behavior || !isInfraCrossCuttingPath(pathRel)) return 0;
  return 40;
}

export function filterCandidatesByFeatureFolders<T extends { pathRel: string }>(
  candidates: T[],
  featureTokens: string[]
): { candidates: T[]; filtered: boolean } {
  const toks = filterStrongRankTokens(featureTokens);
  if (
    featureTokens.some((t) => /^Upload$/i.test(t)) &&
    !toks.some((t) => /^Upload$/i.test(t))
  ) {
    toks.push("Upload");
  }
  if (!toks.length || !candidates.length) {
    return { candidates, filtered: false };
  }
  const hit = candidates.filter((c) =>
    toks.some((t) =>
      normPath(c.pathRel).toLowerCase().includes(t.toLowerCase())
    )
  );
  if (!hit.length) return { candidates: [], filtered: true };
  return { candidates: hit, filtered: true };
}
