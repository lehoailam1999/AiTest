/**
 * Batch route catalog — scan FE routing files once, match TC module → featurePath.
 * Cheap preflight for E2E batch (avoids per-TC full-tree walks).
 *
 * Portable: no product-specific VI/EN synonym tables. Match is module-first
 * (TC.module + requirementTitle + requirement:) against path segments from source
 * routing files. Title/steps are weak tie-breakers only — never pick a route from
 * verbs like "Upload" alone.
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

export type E2eRouteCatalog = {
  routes: string[];
  sources: string[];
};

export type RouteMatchResult = {
  path?: string;
  score: number;
  candidates: Array<{ path: string; score: number }>;
  ambiguous: boolean;
};

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

export async function buildE2eRouteCatalog(opts: {
  paths: string[];
  readFile: (pathRel: string) => Promise<string>;
  maxFiles?: number;
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
  for (const pathRel of routingPaths) {
    try {
      const text = await opts.readFile(pathRel);
      sources.push(pathRel);
      for (const r of extractRoutesFromText(text, pathRel)) {
        if (!seen.has(r)) {
          seen.add(r);
          routes.push(r);
        }
      }
    } catch {
      /* skip unreadable */
    }
  }
  routes.sort((a, b) => a.localeCompare(b));
  return { routes, sources };
}

function tokenize(blob: string): string[] {
  return blob
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
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
  const primaryTokens = strongTokens(primaryBlob);
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

  if (!scored.length) {
    return { score: 0, candidates: [], ambiguous: false };
  }

  const top = scored[0];
  const second = scored[1];
  const minScore =
    opts?.minScore ??
    (opts?.hasFePrimary ? STRONG_CATALOG_SCORE : MIN_MATCH_SCORE);
  const ambiguous =
    second &&
    top.score >= minScore &&
    second.score >= minScore &&
    top.score - second.score < AMBIGUOUS_GAP;
  if (ambiguous) {
    return {
      score: top.score,
      candidates: scored.slice(0, 5).map(({ path, score }) => ({ path, score })),
      ambiguous: true,
    };
  }
  if (top.score < minScore || top.primaryScore < 2) {
    return {
      score: top.score,
      candidates: scored.slice(0, 3).map(({ path, score }) => ({ path, score })),
      ambiguous: false,
    };
  }
  return {
    path: top.path,
    score: top.score,
    candidates: scored.slice(0, 3).map(({ path, score }) => ({ path, score })),
    ambiguous: false,
  };
}
