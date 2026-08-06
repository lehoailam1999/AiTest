/**
 * Derive feature entry path for E2E_FEATURE_PATH from TC markers / Spec comments / FE routes.
 *
 * Project-agnostic — never invent /admin/... without evidence in TC, Spec, or FE source.
 */

const PATH_MARKER_RE =
  /(?:^|\n)\s*(?:path|route|url|featurePath|feature_path)\s*[:=]\s*([^\n;,|]+)/i;

/** AI often writes: Feature entry: /admin/evidence  or  E2E_FEATURE_PATH || /admin/evidence */
const PATH_IN_PROSE_RE =
  /(?:E2E_FEATURE_PATH|Feature\s*entry|deep-?link|gotoFeature|feature\s*path)\s*[^\n/]{0,60}(\/[A-Za-z][\w\-./]{1,100})/gi;

const ABS_ROUTE_RE =
  /(?<![\w/])(\/(?:admin|app|portal|dashboard|console|features?|modules?|workspace)\/[A-Za-z][\w\-./]{1,80})(?![\w/])/gi;

const HREF_RE =
  /(?:routerLink|routerlink|href|path)\s*[:=]\s*['"`](\/[^'"`\s]{1,120})['"`]/gi;

/** Angular/React route segment: path: 'evidence' (not :id, '', **) */
const ROUTE_SEG_RE = /path\s*:\s*['"`]([A-Za-z][\w-]{1,40})['"`]/g;

const AUTH_SEG =
  /^(login|signin|sign-in|signup|sign-up|register|auth|callback|oauth)$/i;

export function deriveFeaturePathFromTc(opts: {
  title?: string | null;
  precondition?: string | null;
  testData?: string | null;
  steps?: string | null;
  /** Extra prose (Spec source, POM comments) */
  specSource?: string | null;
  /** Routes discovered from FE / Inspect */
  routes?: string[];
  /** FE source blob (html/ts) for routerLink / path: extraction */
  feSource?: string;
  /** FE file paths (e.g. …/admin/evidence/…) for prefix composition */
  feFilePaths?: string[];
}): string | undefined {
  const blob = [
    opts.precondition,
    opts.testData,
    opts.steps,
    opts.title,
    opts.specSource,
  ]
    .map((s) => (s || "").trim())
    .filter(Boolean)
    .join("\n");

  const marked = PATH_MARKER_RE.exec(blob);
  if (marked?.[1]) {
    const raw = marked[1].trim().replace(/^["']|["']$/g, "");
    const n = raw ? normalizePath(raw) : "";
    if (n && isUsableRoutePath(n)) return n;
  }

  const fromProse = extractAbsolutePaths(blob);
  // Prefer Feature-entry prose over bare /admin/* listing
  const proseHit = extractFeatureEntryPaths(blob);
  if (proseHit[0]) return proseHit[0];
  if (fromProse[0] && tokenize(blob).some((t) => fromProse[0].toLowerCase().includes(t))) {
    return fromProse[0];
  }

  const fromRoutes = (opts.routes || [])
    .map((r) => (r || "").trim())
    .filter((r) => r.startsWith("/") && r.length > 1 && !isAuthRoute(r));
  if (fromRoutes.length === 1) return normalizePath(fromRoutes[0]);

  const fe = opts.feSource || "";
  const hrefs: string[] = [];
  let m: RegExpExecArray | null;
  const hrefRe = new RegExp(HREF_RE.source, "gi");
  while ((m = hrefRe.exec(fe)) !== null) {
    if (!isAuthRoute(m[1])) hrefs.push(m[1]);
  }
  if (hrefs.length === 1) return normalizePath(hrefs[0]);

  const composed = composeRouteFromFe({
    feSource: fe,
    feFilePaths: opts.feFilePaths || [],
    tokens: tokenize(blob),
  });
  if (composed) return composed;

  const scored = [...new Set([...fromRoutes, ...hrefs, ...fromProse])].map(
    (route) => ({
      route,
      score: scoreRoute(route, tokenize(blob)),
    })
  );
  scored.sort((a, b) => b.score - a.score);
  if (scored[0] && scored[0].score > 0) return normalizePath(scored[0].route);

  return undefined;
}

/** Paths next to Feature entry / E2E_FEATURE_PATH phrasing (highest confidence). */
export function extractFeatureEntryPaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const re =
    /(?:E2E_FEATURE_PATH|Feature\s*entry|deep-?link|gotoFeature|feature\s*path)[^\n]{0,80}?(\/[A-Za-z][\w\-./]{1,100})/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text || "")) !== null) {
    if (/set\s+E2E_FEATURE_PATH\s*\/\s*Feature/i.test(m[0])) continue;
    const n = normalizePath(m[1]);
    if (!n || isAuthRoute(n) || seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out;
}

/** Extract absolute UI paths from Spec/comment prose (portable). */
export function extractAbsolutePaths(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (raw: string) => {
    const n = normalizePath(raw);
    if (!n || isAuthRoute(n) || seen.has(n)) return;
    // skip asset-like
    if (/\.(ts|js|css|png|svg|json)(\?|$)/i.test(n)) return;
    seen.add(n);
    out.push(n);
  };
  let m: RegExpExecArray | null;
  const prose = new RegExp(PATH_IN_PROSE_RE.source, "gi");
  while ((m = prose.exec(text || "")) !== null) push(m[1]);
  const abs = new RegExp(ABS_ROUTE_RE.source, "gi");
  while ((m = abs.exec(text || "")) !== null) push(m[1]);
  return out;
}

function composeRouteFromFe(opts: {
  feSource: string;
  feFilePaths: string[];
  tokens: string[];
}): string | undefined {
  const segs: string[] = [];
  let m: RegExpExecArray | null;
  const segRe = new RegExp(ROUTE_SEG_RE.source, "g");
  while ((m = segRe.exec(opts.feSource || "")) !== null) {
    const s = m[1];
    if (!AUTH_SEG.test(s) && s.toLowerCase() !== "home") segs.push(s);
  }
  const unique = [...new Set(segs)];
  if (!unique.length && !opts.feFilePaths.length) return undefined;

  // File path hint: …/admin/evidence/list/… → /admin/evidence
  // Prefer TC-token match; if FE was already retrieved for this TC, trust unique admin/module path.
  const fileDerived: string[] = [];
  for (const fp of opts.feFilePaths) {
    const norm = fp.replace(/\\/g, "/").toLowerCase();
    const hit = norm.match(
      /\/(admin|portal|dashboard|console)\/([a-z][\w-]{1,40})(?:\/|$)/i
    );
    if (hit?.[1] && hit?.[2]) {
      const candidate = normalizePath(`/${hit[1]}/${hit[2]}`);
      const leaf = hit[2];
      if (
        scoreRoute(candidate, opts.tokens) > 0 ||
        opts.tokens.some((t) => leaf.includes(t) || t.includes(leaf))
      ) {
        return candidate;
      }
      fileDerived.push(candidate);
    }
  }
  // FE primary already chosen by retriever for this TC — unique admin/* path is usable.
  const uniqFile = [...new Set(fileDerived)];
  if (uniqFile.length === 1) return uniqFile[0];
  if (uniqFile.length > 1) {
    const scored = uniqFile
      .map((route) => ({ route, score: scoreRoute(route, opts.tokens) }))
      .sort((a, b) => b.score - a.score);
    if (scored[0].score > 0) return scored[0].route;
  }

  // Score path segments against TC tokens / file names
  const fileBlob = opts.feFilePaths.join(" ").toLowerCase();
  const ranked = unique
    .map((seg) => {
      const low = seg.toLowerCase();
      let score = 0;
      for (const t of opts.tokens) {
        if (low.includes(t) || t.includes(low)) score += 2;
      }
      if (fileBlob.includes("/" + low) || fileBlob.includes(low + ".")) score += 3;
      if (fileBlob.includes("/" + low + "/")) score += 2;
      return { seg, score };
    })
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score);

  if (!ranked.length) return undefined;
  const leaf = ranked[0].seg;

  // Parent prefix from FE only when TC tokens already selected this leaf (never invent /admin)
  const parents = unique.filter((s) =>
    /^(admin|app|portal|dashboard|console)$/i.test(s)
  );
  if (parents.length === 1 && parents[0].toLowerCase() !== leaf.toLowerCase()) {
    return normalizePath(`/${parents[0]}/${leaf}`);
  }
  // Compose /admin/leaf only when FE file tree contains /admin/ AND leaf matched TC tokens
  if (
    (fileBlob.includes("/admin/") ||
      /\bpath\s*:\s*['"`]admin['"`]/.test(opts.feSource)) &&
    opts.tokens.some((t) => leaf.toLowerCase().includes(t) || t.includes(leaf.toLowerCase()))
  ) {
    return normalizePath(`/admin/${leaf}`);
  }
  return normalizePath(`/${leaf}`);
}

function tokenize(blob: string): string[] {
  return blob
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3);
}

function scoreRoute(route: string, tokens: string[]): number {
  const low = route.toLowerCase();
  let score = 0;
  for (const t of tokens) {
    if (low.includes(t)) score += 1;
  }
  // mild boost for multi-segment app routes
  if ((route.match(/\//g) || []).length >= 2) score += 0.5;
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
  return /\/(login|signin|sign-in|signup|sign-up|register|auth)(\/|$)/i.test(path);
}

function isUsableRoutePath(path: string): boolean {
  const p = (path || "").trim();
  if (!p || p === "/") return false;
  if (/thi[eế]u\s*context|missing\s*context|[\[\]]/i.test(p)) return false;
  if (!/^\/[A-Za-z][\w\-./]*$/.test(p)) return false;
  return !isAuthRoute(p);
}
