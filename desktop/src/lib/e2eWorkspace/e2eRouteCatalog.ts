/**
 * Batch route catalog — scan FE routing files once, match TC module → featurePath.
 * Cheap preflight for E2E batch (avoids per-TC full-tree walks).
 *
 * Portable: no product-specific VI/EN synonym tables. Match is module-first
 * (TC.module + requirementTitle + requirement:) against path segments from source
 * routing files. Title/steps are weak tie-breakers only — never pick a route from
 * verbs like "Upload" alone.
 *
 * Locale bridge: when the module is non-ASCII (no overlap with `/admin/evidence`),
 * fall back to labels harvested from that route's own feature templates
 * (`Thêm vật chứng` in evidence HTML → `/admin/evidence`). Fail closed unless the
 * label hit is strong, distinctive, and backed by ≥2 module tokens.
 *
 * Angular/JHipster: compose nested routes from file location
 * (.../admin/evidence/evidence.routes.ts → /admin/evidence).
 * path: 'new' loading a Modal is NOT a navigable AbsolutePath — UX opens
 * modal on the list URL, so catalog keeps the parent only.
 */
import type { TestCase } from "../../api/types";

const ROUTING_PATH_RE =
  /(?:routing|routes|router|app-routing|route\.config|route\.module)/i;

const ROUTE_PATH_RE =
  /path\s*:\s*['"`]([^'"`]+)['"`]/gi;
const ROUTER_LINK_RE =
  /routerLink\s*=\s*['"`]([^'"`]+)['"`]/gi;
const ABS_ROUTE_RE =
  /(?<![\w/])(\/(?:admin|app|portal|dashboard|console)\/[A-Za-z][\w\-./]{1,80})(?![\w/])/gi;

const AUTH_ROUTE_RE =
  /\/(login|signin|sign-in|signup|sign-up|register|auth)(\/|$)/i;

/** Orphan CRUD leaves — only keep when composed with a feature prefix. */
const ORPHAN_LEAF_RE = /^\/(new|edit|view|create|update|list|detail)$/i;

/**
 * Tokens that often appear in TC titles (verbs / severity) but are not domain path segments.
 * Full weight here caused `/upload-activity` to win over `/admin/evidence`.
 */
const WEAK_MATCH_TOKENS = new Set([
  "upload",
  "create",
  "update",
  "delete",
  "remove",
  "open",
  "click",
  "navigate",
  "goto",
  "file",
  "files",
  "size",
  "error",
  "errors",
  "fail",
  "failed",
  "test",
  "tests",
  "case",
  "cases",
  "step",
  "steps",
  "new",
  "edit",
  "view",
  "list",
  "form",
  "modal",
  "popup",
  "page",
  "screen",
  "admin",
  "e2e",
  "err",
  "error",
]);

const AREA_SEGMENTS = new Set([
  "admin",
  "app",
  "portal",
  "dashboard",
  "console",
  "entities",
  "entity",
]);

/** Require strong token/module overlap — weak hits must not beat FE path. */
export const MIN_MATCH_SCORE = 3;
const AMBIGUOUS_GAP = 0.75;

/**
 * When FE primary already resolved, catalog must clear this bar to replace nothing
 * (catalog only runs when featurePath empty — still skip weak matches).
 */
export const STRONG_CATALOG_SCORE = 4;

/**
 * Route → UI label tokens (term frequency) harvested from the route's own feature
 * folder. This is the portable bridge for non-ASCII TC modules: a Vietnamese
 * module ("Tạo mới vật chứng") cannot match ASCII segments (`/admin/evidence`),
 * but it does match the labels rendered by that feature's own templates.
 */
export type RouteLabelIndex = Record<string, Record<string, number>>;

export type E2eRouteCatalog = {
  routes: string[];
  sources: string[];
  labels?: RouteLabelIndex;
  /** route → feature template/component files (the code behind that screen). */
  featureSources?: Record<string, string[]>;
};

export type RouteMatchResult = {
  path?: string;
  score: number;
  candidates: Array<{ path: string; score: number }>;
  ambiguous: boolean;
  /** Which signal picked the route — path segments or harvested UI labels. */
  matchedBy?: "path" | "label";
  labelScore?: number;
};

/**
 * Pivoted length normalization — plain cosine over-rewards routes with few
 * labels, plain TF-IDF over-rewards label-rich routes. Calibrated on a real
 * Angular repo: true feature ≥ 0.89, wrong/absent feature ≤ 0.60.
 */
const LABEL_NORM_ALPHA = 0.75;
/** Title/steps/precondition tokens corroborate; module/requirement lead. */
const LABEL_SECONDARY_WEIGHT = 0.45;
/** Label-only pick must clear this absolute bar (see calibration above). */
export const LABEL_STRONG_SCORE = 0.8;
/** …and beat the runner-up by this ratio, else stay unresolved (fail closed). */
const LABEL_AMBIGUOUS_RATIO = 1.1;
/** …and be backed by ≥2 distinct module/requirement tokens, not one lucky word. */
const LABEL_MIN_MATCHED_TOKENS = 2;

function normSlash(pathRel: string): string {
  return (pathRel || "").replace(/\\/g, "/");
}

/** Skip build output, specs, resolve services — keep real router modules. */
export function isRoutingFilePath(pathRel: string): boolean {
  const p = normSlash(pathRel).toLowerCase();
  if (
    p.includes("/aitest/") ||
    p.includes("/node_modules/") ||
    p.includes("/dist/") ||
    p.includes("/build/") ||
    p.includes("/out/") ||
    p.includes("/wwwroot/") ||
    p.includes("/.angular/") ||
    p.includes("/coverage/")
  ) {
    return false;
  }
  if (/\.spec\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p)) return false;
  if (/routing-resolve\.service\.ts$/.test(p)) return false;
  return ROUTING_PATH_RE.test(p);
}

/** Prefer `…/src/…` over absolute / dist noise when capping maxFiles. */
export function rankRoutingFileForScan(pathRel: string): number {
  const p = normSlash(pathRel).toLowerCase();
  let score = 0;
  if (p.includes("/src/")) score += 100;
  if (p.includes("/app/")) score += 20;
  if (p.includes("/admin/")) score += 10;
  if (p.endsWith(".routes.ts") || p.endsWith(".route.ts")) score += 15;
  if (p.includes("app.routes.ts") || p.includes("admin.routes.ts")) score += 25;
  if (p.includes("/dist/")) score -= 200;
  return score;
}

function normalizePath(raw: string): string {
  let p = (raw || "").trim().replace(/\\/g, "/").replace(/^["'`]+|["'`]+$/g, "");
  if (!p) return "";
  if (p.startsWith("http://") || p.startsWith("https://")) {
    try {
      p = new URL(p).pathname || p;
    } catch {
      /* keep */
    }
  }
  if (!p.startsWith("/")) p = `/${p}`;
  p = p.replace(/\/{2,}/g, "/");
  if (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
  return p;
}

function isAuthRoute(path: string): boolean {
  return AUTH_ROUTE_RE.test(path);
}

/**
 * From `…/src/app/admin/evidence/evidence.routes.ts` → `/admin/evidence`
 * From `…/src/app/entities/upload-activity/upload-activity.routes.ts` → `/upload-activity`
 * From `…/src/app/admin/admin.routes.ts` → `/admin`
 */
export function deriveRoutePrefixFromFile(filePath: string): string {
  const p = normSlash(filePath);
  const lower = p.toLowerCase();
  const appIdx = lower.search(/\/(?:src\/)?app\//);
  if (appIdx < 0) return "";
  const afterApp = p.slice(appIdx).replace(/^.*?\/app\//i, "");
  const segs = afterApp.split("/").filter(Boolean);
  if (segs.length < 2) return ""; // need at least area|feature + file

  const dirs = segs
    .slice(0, -1)
    .filter((s) => !/^(route|routes)$/i.test(s));
  if (!dirs.length) return "";

  const out: string[] = [];
  let i = 0;
  while (i < dirs.length) {
    const seg = dirs[i];
    const low = seg.toLowerCase();
    i += 1;
    // JHipster entities/ is not a URL segment
    if (low === "entities" || low === "entity") continue;
    out.push(seg);
    if (AREA_SEGMENTS.has(low)) continue; // keep consuming feature under admin/app/…
    // feature folder taken
    if (out.length >= 2 && out[1]?.toLowerCase() === "reports" && i < dirs.length) {
      out.push(dirs[i]);
      break;
    }
    break;
  }

  if (!out.length) return "";
  return normalizePath(out.join("/"));
}

function joinPrefix(prefix: string, seg: string): string {
  const left = normalizePath(prefix || "");
  const right = (seg || "").replace(/^\/+/, "").replace(/\/+$/, "");
  if (!right || right === "**" || right.startsWith(":")) {
    return left && left !== "/" ? left : "";
  }
  if (right.includes(":")) {
    // drop param routes for Approve grounding (`:id/edit`)
    const cleaned = right
      .split("/")
      .filter((s) => s && !s.startsWith(":"))
      .join("/");
    if (!cleaned) return left && left !== "/" ? left : "";
    return normalizePath(`${left === "/" ? "" : left}/${cleaned}`);
  }
  if (!left || left === "/") return normalizePath(`/${right}`);
  return normalizePath(`${left}/${right}`);
}

/**
 * Angular/JHipster often registers `path: 'new'` → ModalComponent, but UX opens via
 * NgbModal on the list URL — AbsolutePath for E2E is the parent feature path, not `/…/new`.
 */
const MODAL_ROUTE_HINT_RE =
  /loadComponent\s*:\s*\(\)\s*=>\s*import\s*\(\s*['"`][^'"`]*(modal|dialog|popup)[^'"`]*['"`]|component\s*:\s*[A-Za-z0-9_]*(Modal|Dialog|Popup)/i;
const CREATE_LEAF_RE = /^(new|create)$/i;

function routeBlockLooksLikeModal(text: string, pathMatchIndex: number): boolean {
  const window = (text || "").slice(pathMatchIndex, pathMatchIndex + 600);
  return MODAL_ROUTE_HINT_RE.test(window);
}

function extractRoutesFromText(text: string, filePath: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const prefix = deriveRoutePrefixFromFile(filePath);

  const push = (raw: string) => {
    const n = normalizePath(raw);
    if (!n || n === "/" || isAuthRoute(n) || seen.has(n)) return;
    // bare `/new` `/edit` — useless for grounding without feature prefix
    if (ORPHAN_LEAF_RE.test(n) && n.split("/").filter(Boolean).length === 1) return;
    seen.add(n);
    out.push(n);
  };

  let m: RegExpExecArray | null;
  const pathRe = new RegExp(ROUTE_PATH_RE.source, "gi");
  while ((m = pathRe.exec(text || "")) !== null) {
    const seg = m[1].trim();
    if (!seg || seg === "**" || seg.startsWith(":")) continue;
    if (seg.startsWith("/")) {
      push(seg);
      continue;
    }
    // Relative Angular child — compose with file-derived prefix
    if (prefix) {
      // Modal create/edit: navigable entry = list/feature URL, not /…/new
      if (
        CREATE_LEAF_RE.test(seg) &&
        routeBlockLooksLikeModal(text, m.index)
      ) {
        push(prefix);
        continue;
      }
      const composed = joinPrefix(prefix, seg);
      if (composed) push(composed);
      if (prefix !== "/" && !seen.has(prefix)) push(prefix);
    } else {
      const bare = normalizePath(`/${seg}`);
      if (!ORPHAN_LEAF_RE.test(bare)) push(bare);
    }
  }

  const linkRe = new RegExp(ROUTER_LINK_RE.source, "gi");
  while ((m = linkRe.exec(text || "")) !== null) push(m[1]);
  const absRe = new RegExp(ABS_ROUTE_RE.source, "gi");
  while ((m = absRe.exec(text || "")) !== null) push(m[1]);

  // File itself implies feature list route when under admin/entities
  if (prefix && prefix !== "/" && !seen.has(prefix)) {
    push(prefix);
  }

  return out;
}

/* ── UI label harvest ─────────────────────────────────────────────────────── */

/** Function words / generic UI verbs — carry no feature identity in any locale. */
const LABEL_STOP_TOKENS = new Set([
  "cac",
  "cua",
  "cho",
  "voi",
  "tren",
  "duoi",
  "vao",
  "khi",
  "khong",
  "hoac",
  "duoc",
  "theo",
  "trong",
  "này",
  "nay",
  "tat",
  "chua",
  "dang",
  "san",
  "hay",
  "vui",
  "long",
  "thanh",
  "cong",
  "that",
  "bai",
  "loi",
  "canh",
  "bao",
  "xac",
  "nhan",
  "dong",
  "huy",
  "luu",
  "them",
  "sua",
  "xoa",
  "tim",
  "kiem",
  "chon",
  "nhap",
  "xem",
  "chi",
  "tiet",
  "danh",
  "sach",
  "trang",
  "bang",
  "cot",
  "ngay",
  "gio",
  "ten",
  "tong",
  "quay",
  "lai",
  "tiep",
  "truoc",
  "sau",
  "the",
  "and",
  "for",
  "with",
  "from",
  "all",
  "none",
  "yes",
  "not",
  "save",
  "cancel",
  "close",
  "search",
  "filter",
  "submit",
  "confirm",
  "success",
  "warning",
  "required",
  "loading",
  "name",
  "date",
  "time",
  "total",
  "action",
  "actions",
  "status",
]);

const HTML_TEXT_NODE_RE = />([^<>{}]{2,80})</g;
const HTML_LABEL_ATTR_RE =
  /\b(?:placeholder|title|label|aria-label|alt|header|heading|tooltip)\s*=\s*"([^"{}]{2,80})"/gi;
const TS_LABEL_KV_RE =
  /\b(?:title|label|header|heading|placeholder|message|name|text)\s*:\s*['"]([^'"{}]{2,80})['"]/gi;
const TS_TEMPLATE_RE = /template\s*:\s*`([\s\S]{0,20000}?)`/g;

/** Keep human sentences; drop code, i18n keys, interpolation, numbers-only. */
function isLikelyUiLabel(raw: string): boolean {
  const s = (raw || "").trim();
  if (s.length < 2 || s.length > 80) return false;
  if (/[{}<>$=|]/.test(s)) return false;
  if (!/[A-Za-zÀ-ỹ]/.test(s)) return false;
  // i18n key ("forensicApp.evidence.home.title") — the rendered text is captured separately
  if (/^[A-Za-z][\w.]*\.[\w.]+$/.test(s) && !/\s/.test(s)) return false;
  if (/^(?:https?:|\.\/|\/)/.test(s)) return false;
  return true;
}

export function extractUiLabelPhrases(text: string, filePathRel: string): string[] {
  const out: string[] = [];
  const push = (raw: string) => {
    const s = (raw || "").replace(/\s+/g, " ").trim();
    if (isLikelyUiLabel(s)) out.push(s);
  };

  const isHtml = /\.html?$/i.test(normSlash(filePathRel));
  const htmlChunks: string[] = [];
  if (isHtml) {
    htmlChunks.push(text || "");
  } else {
    let m: RegExpExecArray | null;
    const tplRe = new RegExp(TS_TEMPLATE_RE.source, "g");
    while ((m = tplRe.exec(text || "")) !== null) htmlChunks.push(m[1]);
    const kvRe = new RegExp(TS_LABEL_KV_RE.source, "gi");
    while ((m = kvRe.exec(text || "")) !== null) push(m[1]);
  }

  for (const chunk of htmlChunks) {
    let m: RegExpExecArray | null;
    const textRe = new RegExp(HTML_TEXT_NODE_RE.source, "g");
    while ((m = textRe.exec(chunk)) !== null) push(m[1]);
    const attrRe = new RegExp(HTML_LABEL_ATTR_RE.source, "gi");
    while ((m = attrRe.exec(chunk)) !== null) push(m[1]);
  }

  return out;
}

/** Phrases → token term-frequency, dropping locale-agnostic filler. */
export function labelTokenFrequency(phrases: string[]): Record<string, number> {
  const tf: Record<string, number> = {};
  for (const phrase of phrases) {
    for (const token of tokenize(phrase)) {
      if (WEAK_MATCH_TOKENS.has(token) || LABEL_STOP_TOKENS.has(token)) continue;
      tf[token] = (tf[token] || 0) + 1;
    }
  }
  return tf;
}

function dirOf(pathRel: string): string {
  const p = normSlash(pathRel);
  const idx = p.lastIndexOf("/");
  return idx <= 0 ? "" : p.slice(0, idx);
}

function tailSlug(dir: string): string {
  const segs = normSlash(dir).split("/").filter(Boolean);
  return (segs[segs.length - 1] || "").toLowerCase().replace(/[^a-z0-9]+/g, "");
}

const LABEL_FILE_RE = /\.(?:html?|ts|tsx|jsx?|vue)$/i;
const LABEL_FILE_SKIP_RE =
  /\.(?:spec|test|d)\.[tj]sx?$|\.(?:routes?|module|service|model|guard|resolver|pipe)\.[tj]s$|mock-data|environment/i;

/**
 * Feature folder files that render user-visible labels for a route.
 * Own folder + one nested level (list/create/update/detail) — never the whole area.
 */
export function pickLabelFilesForDir(
  dir: string,
  paths: string[],
  limit: number
): string[] {
  if (!dir) return [];
  const base = normSlash(dir);
  const baseDepth = base.split("/").filter(Boolean).length;
  const candidates = paths
    .map(normSlash)
    .filter((p) => p.startsWith(`${base}/`))
    .filter((p) => LABEL_FILE_RE.test(p) && !LABEL_FILE_SKIP_RE.test(p))
    .filter((p) => {
      const depth = p.split("/").filter(Boolean).length;
      return depth <= baseDepth + 2;
    });
  const rank = (p: string): number => {
    let s = 0;
    if (/\.html?$/i.test(p)) s += 50;
    if (/list|home|index/i.test(p)) s += 12;
    if (/create|new|add|update|edit|modal|dialog|detail/i.test(p)) s += 8;
    s -= p.split("/").length;
    return s;
  };
  return candidates
    .sort((a, b) => rank(b) - rank(a) || a.localeCompare(b))
    .slice(0, limit);
}

export async function buildE2eRouteCatalog(opts: {
  paths: string[];
  readFile: (pathRel: string) => Promise<string>;
  maxFiles?: number;
  /** Label files read per route (feature folder templates). 0 disables harvest. */
  maxLabelFilesPerRoute?: number;
  /** Global cap on label file reads across all routes. */
  maxLabelFilesTotal?: number;
}): Promise<E2eRouteCatalog> {
  const maxFiles = opts.maxFiles ?? 40;
  const routingPaths = opts.paths
    .filter(isRoutingFilePath)
    .sort(
      (a, b) =>
        rankRoutingFileForScan(b) - rankRoutingFileForScan(a) ||
        normSlash(a).localeCompare(normSlash(b))
    )
    .slice(0, maxFiles);
  const routes: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  /** route → most specific feature folder (dir tail must equal the route leaf). */
  const routeDir = new Map<string, string>();
  for (const pathRel of routingPaths) {
    try {
      const text = await opts.readFile(pathRel);
      sources.push(pathRel);
      const dir = dirOf(pathRel);
      for (const r of extractRoutesFromText(text, pathRel)) {
        if (!seen.has(r)) {
          seen.add(r);
          routes.push(r);
        }
        if (dir && tailSlug(dir) === featureSlug(r)) {
          const prev = routeDir.get(r);
          if (!prev || prev.split("/").length < dir.split("/").length) {
            routeDir.set(r, dir);
          }
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  routes.sort((a, b) => a.localeCompare(b));

  const perRoute = opts.maxLabelFilesPerRoute ?? 8;
  const totalCap = opts.maxLabelFilesTotal ?? 160;
  const labels: RouteLabelIndex = {};
  const featureSources: Record<string, string[]> = {};
  if (perRoute > 0) {
    let reads = 0;
    for (const route of routes) {
      const dir = routeDir.get(route);
      if (!dir || reads >= totalCap) continue;
      const files = pickLabelFilesForDir(
        dir,
        opts.paths,
        Math.min(perRoute, totalCap - reads)
      );
      const phrases: string[] = [];
      const readOk: string[] = [];
      for (const file of files) {
        try {
          const text = await opts.readFile(file);
          reads += 1;
          readOk.push(file);
          phrases.push(...extractUiLabelPhrases(text, file));
        } catch {
          /* skip unreadable */
        }
      }
      if (readOk.length) featureSources[route] = readOk;
      const tf = labelTokenFrequency(phrases);
      const top = Object.entries(tf)
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .slice(0, 60);
      if (top.length) labels[route] = Object.fromEntries(top);
    }
  }

  return {
    routes,
    sources,
    ...(Object.keys(labels).length ? { labels } : {}),
    ...(Object.keys(featureSources).length ? { featureSources } : {}),
  };
}

/** Feature code behind a route — Codegen reads these instead of guessing selectors. */
export function featureSourcesForPath(
  rawPath: string | null | undefined,
  catalog?: E2eRouteCatalog | null,
  limit = 3
): string[] {
  const p = normalizePath(rawPath || "");
  if (!p || !catalog?.featureSources) return [];
  const map = catalog.featureSources;
  const exact = map[p];
  if (exact?.length) return exact.slice(0, limit);
  const low = p.toLowerCase();
  const parent = Object.keys(map)
    .filter((route) => low === route.toLowerCase() || low.startsWith(`${route.toLowerCase()}/`))
    .sort((a, b) => b.length - a.length)[0];
  return parent ? (map[parent] || []).slice(0, limit) : [];
}

/**
 * Reality check for a path marker that came from TC text / LLM IR.
 * Accepts exact catalog routes and unlisted children of a known area
 * (`/admin/evidence/123/edit`), rejects paths whose first segment exists nowhere
 * in the source routes (e.g. `/BR-4` from a `trace:` line).
 * No catalog → cannot judge, so accept (caller stays fail-closed elsewhere).
 */
export function isPathPlausibleForCatalog(
  rawPath: string | null | undefined,
  catalog?: E2eRouteCatalog | null
): boolean {
  const p = normalizePath(rawPath || "");
  if (!p || p === "/") return false;
  if (!catalog?.routes?.length) return true;
  const low = p.toLowerCase();
  if (catalog.routes.some((r) => r.toLowerCase() === low)) return true;
  if (catalog.routes.some((r) => low.startsWith(`${r.toLowerCase()}/`))) return true;
  const head = low.split("/").filter(Boolean)[0] || "";
  if (!head) return false;
  return catalog.routes.some(
    (r) => (r.toLowerCase().split("/").filter(Boolean)[0] || "") === head
  );
}

export type LabelMatch = { score: number; matched: number };

/**
 * TF-IDF over harvested labels: tokens shared by every feature (Save/Search…)
 * lose weight automatically, so no per-product stopword table is needed.
 * `matched` counts distinct module/requirement tokens that actually hit.
 */
export function scoreRoutesByLabelIndex(
  primaryTokens: string[],
  secondaryTokens: string[],
  labels?: RouteLabelIndex | null
): Record<string, LabelMatch> {
  const out: Record<string, LabelMatch> = {};
  if (!labels) return out;
  const routes = Object.keys(labels);
  if (!routes.length) return out;

  const usable = (t: string) => t.length >= 3 && !LABEL_STOP_TOKENS.has(t);
  const weights = new Map<string, number>();
  for (const t of primaryTokens) if (usable(t)) weights.set(t, 1);
  for (const t of secondaryTokens) {
    if (usable(t) && !weights.has(t)) weights.set(t, LABEL_SECONDARY_WEIGHT);
  }
  if (!weights.size) return out;

  // Document frequency over every harvested token — the route norm needs it too.
  const df: Record<string, number> = {};
  for (const route of routes) {
    for (const token of Object.keys(labels[route] || {})) {
      df[token] = (df[token] || 0) + 1;
    }
  }
  const idfOf = (token: string) =>
    Math.log((routes.length + 1) / (1 + (df[token] || 0)));

  for (const route of routes) {
    const tf = labels[route] || {};
    let norm = 0;
    for (const [token, freq] of Object.entries(tf)) {
      const w = Math.log(1 + freq) * Math.max(0, idfOf(token));
      norm += w * w;
    }
    norm = Math.sqrt(norm) || 1;

    let dot = 0;
    let matched = 0;
    for (const [token, weight] of weights) {
      const freq = tf[token] || 0;
      const idf = idfOf(token);
      if (freq <= 0 || idf <= 0) continue;
      dot += Math.log(1 + freq) * idf * weight;
      if (weight === 1) matched += 1;
    }
    const score = dot / Math.pow(norm, LABEL_NORM_ALPHA);
    if (score > 0) out[route] = { score, matched };
  }
  return out;
}

function tokenize(blob: string): string[] {
  return blob
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function compactToken(value: string): string {
  return (value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "");
}

function identifierTokens(value: string): string[] {
  return tokenize(
    (value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_./\\-]+/g, " ")
  );
}

/**
 * Expand business labels through repository-learned aliases only when the label
 * actually appears in this TC. Example: `maVatChung → EvidenceCode` contributes
 * `evidence`, allowing a Vietnamese TC to match `/admin/evidence` without a
 * product-specific translation table.
 */
function semanticAliasTokens(
  blob: string,
  aliases?: Record<string, string | string[]> | null
): string[] {
  if (!aliases) return [];
  const compactBlob = compactToken(blob);
  const out = new Set<string>();
  for (const [label, rawValues] of Object.entries(aliases)) {
    const compactLabel = compactToken(label);
    if (!compactLabel || !compactBlob.includes(compactLabel)) continue;
    const values = Array.isArray(rawValues) ? rawValues : [rawValues];
    for (const value of values) {
      for (const token of identifierTokens(String(value || ""))) {
        if (!WEAK_MATCH_TOKENS.has(token)) out.add(token);
      }
    }
  }
  return [...out];
}

/** Domain tokens only — verbs/severity from titles must not pick the route. */
function strongTokens(blob: string): string[] {
  return tokenize(blob).filter((t) => !WEAK_MATCH_TOKENS.has(t));
}

function featureSlug(route: string): string {
  const segs = normalizePath(route)
    .toLowerCase()
    .split("/")
    .filter(Boolean);
  return (segs[segs.length - 1] || "").replace(/[^a-z0-9]+/g, "");
}

function scoreRoute(route: string, tokens: string[], module?: string): number {
  const low = route.toLowerCase();
  const segs = low.split("/").filter(Boolean);
  const leaf = featureSlug(route);
  let score = 0;
  for (const t of tokens) {
    const weak = WEAK_MATCH_TOKENS.has(t);  
    const hitWeight = weak ? 0.2 : 1;
    const segWeight = weak ? 0.1 : 0.5;
    if (low.includes(t)) score += hitWeight;
    for (const seg of segs) {
      const segSlug = seg.replace(/[^a-z0-9]+/g, "");
      if (segSlug && (segSlug.includes(t) || t.includes(segSlug))) {
        score += segWeight;
      }
      if (!weak && segSlug === t) score += 1.5;
    }
    // Module/requirement leaf hit is decisive (evidence → /admin/evidence)
    if (!weak && leaf && leaf === t) score += 2.5;
  }
  const mod = (module || "").trim().toLowerCase();
  if (mod.length >= 3 && low.includes(mod)) score += 2;
  if (mod) {
    const slug = mod
      .normalize("NFD")
      .replace(/\p{M}/gu, "")
      .replace(/[^a-z0-9]+/g, "");
    for (const seg of segs) {
      const segSlug = seg.replace(/[^a-z0-9]+/g, "");
      if (slug && segSlug && (slug.includes(segSlug) || segSlug.includes(slug))) {
        score += 2;
      }
    }
  }
  // Prefer area/feature list paths (…/admin/evidence) over flat entity dashboards
  if (segs.length >= 2) score += 0.75;
  if (segs[0] === "admin" || segs[0] === "app") score += 0.25;
  // Prefer shorter navigable entry when scores tie (list over deep child)
  score += Math.max(0, 0.4 - segs.length * 0.05);
  return score;
}

function requirementFromTestData(testData?: string | null): string {
  const m = /(?:^|\n)\s*requirement\s*[:=]\s*([^\n]+)/i.exec(testData || "");
  return (m?.[1] || "").trim();
}

/**
 * Module-first match against source route catalog.
 * Primary: TC.module + requirementTitle + requirement: in testData
 * Secondary (weak): title/steps — never enough alone to beat a module hit
 */
export function matchFeaturePathFromCatalog(
  tc: Pick<TestCase, "title" | "module" | "steps" | "testData" | "precondition">,
  catalog: E2eRouteCatalog,
  opts?: {
    minScore?: number;
    hasFePrimary?: boolean;
    /** Journey / Requirement Studio title (often Latin when module is VI) */
    requirementTitle?: string | null;
    /** Source-backed business label → code identifier aliases. */
    semanticAliases?: Record<string, string | string[]> | null;
  }
): RouteMatchResult {
  if (!catalog.routes.length) {
    return { score: 0, candidates: [], ambiguous: false };
  }

  const primaryBlob = [
    tc.module,
    opts?.requirementTitle,
    requirementFromTestData(tc.testData),
  ]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");
  const tcBlob = [
    primaryBlob,
    tc.title,
    tc.steps,
    tc.precondition,
    tc.testData,
  ]
    .filter(Boolean)
    .join("\n");
  const primaryTokens = [
    ...new Set([
      ...strongTokens(primaryBlob),
      ...semanticAliasTokens(tcBlob, opts?.semanticAliases),
    ]),
  ];
  const secondaryTokens = strongTokens(
    [tc.title, tc.steps, tc.precondition].filter(Boolean).join("\n")
  );

  // Fail closed: no domain tokens from module/requirement → do not invent from title verbs
  if (!primaryTokens.length) {
    return { score: 0, candidates: [], ambiguous: false };
  }

  const scored = catalog.routes
    .map((path) => {
      const primaryScore = scoreRoute(path, primaryTokens, tc.module || undefined);
      const secondaryScore = secondaryTokens.length
        ? scoreRoute(path, secondaryTokens) * 0.15
        : 0;
      return {
        path,
        primaryScore,
        score: primaryScore + secondaryScore,
      };
    })
    .filter((x) => x.primaryScore > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));

  const minScore =
    opts?.minScore ??
    (opts?.hasFePrimary ? STRONG_CATALOG_SCORE : MIN_MATCH_SCORE);
  const top = scored[0];
  const second = scored[1];
  const pathAmbiguous = Boolean(
    top &&
      second &&
      top.score >= minScore &&
      second.score >= minScore &&
      top.score - second.score < AMBIGUOUS_GAP
  );

  if (top && !pathAmbiguous && top.score >= minScore && top.primaryScore >= 2) {
    return {
      path: top.path,
      score: top.score,
      matchedBy: "path",
      candidates: scored.slice(0, 3).map(({ path, score }) => ({ path, score })),
      ambiguous: false,
    };
  }

  // Locale bridge: ASCII segments cannot match a Vietnamese module, but the labels
  // rendered by that feature's own templates can. Fallback only — never overrides
  // a clean path match above.
  const labelFallback = matchFeaturePathByLabels(
    { primaryBlob, secondaryBlob: tcBlob },
    catalog
  );
  if (labelFallback.path && !pathAmbiguous) return labelFallback;

  if (!top) {
    return labelFallback.candidates.length
      ? labelFallback
      : { score: 0, candidates: [], ambiguous: false };
  }
  return {
    score: top.score,
    labelScore: labelFallback.labelScore,
    candidates: scored
      .slice(0, pathAmbiguous ? 5 : 3)
      .map(({ path, score }) => ({ path, score })),
    ambiguous: pathAmbiguous,
  };
}

/**
 * Label-only route resolution (fail-closed): needs an absolute score, a margin
 * over the runner-up, and ≥2 distinct module/requirement tokens.
 */
export function matchFeaturePathByLabels(
  blobs: { primaryBlob: string; secondaryBlob?: string },
  catalog: E2eRouteCatalog
): RouteMatchResult {
  const labels = catalog.labels;
  if (!labels || !Object.keys(labels).length) {
    return { score: 0, candidates: [], ambiguous: false };
  }
  const scores = scoreRoutesByLabelIndex(
    tokenize(blobs.primaryBlob),
    tokenize(blobs.secondaryBlob || ""),
    labels
  );
  const ranked = Object.entries(scores)
    .map(([path, m]) => ({ path, ...m }))
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!ranked.length) return { score: 0, candidates: [], ambiguous: false };

  const top = ranked[0];
  const runnerUp = ranked[1]?.score || 0;
  const candidates = ranked
    .slice(0, 5)
    .map(({ path, score }) => ({ path, score }));
  const strong = top.score >= LABEL_STRONG_SCORE;
  const distinctive =
    strong &&
    top.matched >= LABEL_MIN_MATCHED_TOKENS &&
    top.score >= runnerUp * LABEL_AMBIGUOUS_RATIO;
  if (!distinctive) {
    return {
      score: top.score,
      labelScore: top.score,
      candidates,
      ambiguous: strong,
    };
  }
  return {
    path: top.path,
    score: top.score,
    labelScore: top.score,
    matchedBy: "label",
    candidates,
    ambiguous: false,
  };
}
