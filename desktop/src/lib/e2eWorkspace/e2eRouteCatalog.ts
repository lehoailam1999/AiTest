/**
 * Batch route catalog — scan FE routing files once, match TC module/title → featurePath.
 * Cheap preflight for E2E batch (avoids per-TC full-tree walks).
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

const MIN_MATCH_SCORE = 1.5;
const AMBIGUOUS_GAP = 0.75;

/** Light VI/EN synonyms so catalog can match Forensic-style modules. */
const TOKEN_SYNONYMS: Record<string, string[]> = {
  evidence: ["vat", "chung", "vatchung", "forensic"],
  storage: ["phong", "kho", "phongkho", "room", "rooms"],
  room: ["phong", "kho"],
  rooms: ["phong", "kho"],
  case: ["vu", "an", "ho", "so", "hoso"],
  cases: ["vu", "an", "hoso"],
  user: ["nguoi", "dung", "nguoidung"],
  account: ["tai", "khoan", "taikhoan"],
  login: ["dang", "nhap", "dangnhap"],
};

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

export function isRoutingFilePath(pathRel: string): boolean {
  const p = pathRel.replace(/\\/g, "/").toLowerCase();
  if (p.includes("/aitest/") || p.includes("/node_modules/")) return false;
  return ROUTING_PATH_RE.test(p);
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

function extractRoutesFromText(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const n = normalizePath(raw);
    if (!n || n === "/" || isAuthRoute(n) || seen.has(n)) return;
    seen.add(n);
    out.push(n);
  };
  let m: RegExpExecArray | null;
  const pathRe = new RegExp(ROUTE_PATH_RE.source, "gi");
  while ((m = pathRe.exec(text || "")) !== null) {
    const seg = m[1].trim();
    if (!seg || seg === "**" || seg.startsWith(":")) continue;
    push(seg.startsWith("/") ? seg : `/${seg}`);
  }
  const linkRe = new RegExp(ROUTER_LINK_RE.source, "gi");
  while ((m = linkRe.exec(text || "")) !== null) push(m[1]);
  const absRe = new RegExp(ABS_ROUTE_RE.source, "gi");
  while ((m = absRe.exec(text || "")) !== null) push(m[1]);
  return out;
}

export async function buildE2eRouteCatalog(opts: {
  paths: string[];
  readFile: (pathRel: string) => Promise<string>;
  maxFiles?: number;
}): Promise<E2eRouteCatalog> {
  const maxFiles = opts.maxFiles ?? 40;
  const routingPaths = opts.paths.filter(isRoutingFilePath).slice(0, maxFiles);
  const routes: string[] = [];
  const sources: string[] = [];
  const seen = new Set<string>();
  for (const pathRel of routingPaths) {
    try {
      const text = await opts.readFile(pathRel);
      sources.push(pathRel);
      for (const r of extractRoutesFromText(text)) {
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

function scoreRoute(route: string, tokens: string[], module?: string): number {
  const low = route.toLowerCase();
  const segs = low.split("/").filter(Boolean);
  let score = 0;
  for (const t of tokens) {
    if (low.includes(t)) score += 1;
    for (const seg of segs) {
      const syns = TOKEN_SYNONYMS[seg] || [];
      if (syns.includes(t)) score += 1.25;
      // reverse: token maps to route segment
      for (const [eng, viList] of Object.entries(TOKEN_SYNONYMS)) {
        if (viList.includes(t) && (seg.includes(eng) || eng.includes(seg))) {
          score += 1.25;
        }
      }
    }
  }
  const mod = (module || "").trim().toLowerCase();
  if (mod.length >= 3 && low.includes(mod)) score += 2;
  // module slug often matches leaf: "StorageRoom" → storage-room
  if (mod) {
    const slug = mod.replace(/[^a-z0-9]+/g, "");
    for (const seg of segs) {
      const segSlug = seg.replace(/[^a-z0-9]+/g, "");
      if (slug && segSlug && (slug.includes(segSlug) || segSlug.includes(slug))) {
        score += 2;
      }
    }
  }
  if ((route.match(/\//g) || []).length >= 2) score += 0.5;
  return score;
}

export function matchFeaturePathFromCatalog(
  tc: Pick<TestCase, "title" | "module" | "steps" | "testData" | "precondition">,
  catalog: E2eRouteCatalog
): RouteMatchResult {
  if (!catalog.routes.length) {
    return { score: 0, candidates: [], ambiguous: false };
  }
  const blob = [tc.module, tc.title, tc.steps, tc.testData, tc.precondition]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");
  const tokens = tokenize(blob);
  const scored = catalog.routes
    .map((path) => ({
      path,
      score: scoreRoute(path, tokens, tc.module || undefined),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  if (!scored.length) {
    return { score: 0, candidates: [], ambiguous: false };
  }
  const top = scored[0];
  const second = scored[1];
  const ambiguous =
    second &&
    top.score >= MIN_MATCH_SCORE &&
    second.score >= MIN_MATCH_SCORE &&
    top.score - second.score < AMBIGUOUS_GAP;
  if (ambiguous) {
    return {
      score: top.score,
      candidates: scored.slice(0, 5),
      ambiguous: true,
    };
  }
  if (top.score < MIN_MATCH_SCORE) {
    return { score: top.score, candidates: scored.slice(0, 3), ambiguous: false };
  }
  return {
    path: top.path,
    score: top.score,
    candidates: scored.slice(0, 3),
    ambiguous: false,
  };
}
