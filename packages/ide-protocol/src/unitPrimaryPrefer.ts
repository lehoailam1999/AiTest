/**
 * Portable Unit primary preference: marker path/code match + prefer implementation
 * over I* interface when both exist. No product-specific paths.
 */

function norm(pathRel: string): string {
  return (pathRel || "").replace(/\\/g, "/");
}

function normLow(pathRel: string): string {
  return norm(pathRel).toLowerCase();
}

/** File stem without extension (UploadService / IUploadService). */
export function stemOfPath(pathRel: string): string {
  const base = norm(pathRel).split("/").pop() || "";
  return base.replace(/\.[^.]+$/, "");
}

/**
 * True for interface-like Unit primaries (C# IFoo, *.interface.*, /interfaces/).
 * Marker path: pointing here is still allowed as explicit override.
 */
export function isInterfaceLikePrimaryPath(pathRel: string): boolean {
  const p = normLow(pathRel);
  if (!p) return false;
  if (/\/interfaces?\//.test(p) || /\.interface\./i.test(p)) return true;
  const stem = stemOfPath(pathRel);
  // C# / Java-style IPascalCase (IUploadService) — not "IdService" / "IndexService"
  return /^I[A-Z][A-Za-z0-9]*$/.test(stem);
}

/** Strip leading I from C# interface stem → implementation family stem. */
export function stripInterfaceStemPrefix(stem: string): string {
  const s = (stem || "").trim();
  if (/^I[A-Z]/.test(s)) return s.slice(1);
  return s;
}

/**
 * Path matches TC path:/file: marker without latching IFoo onto Foo.
 * Accepts exact, endsWith("/marker"), or basename equality — not IFoo.cs ⊃ Foo.cs.
 */
export function pathsMatchMarker(
  candidatePath: string,
  markerPath: string
): boolean {
  const cand = normLow(candidatePath);
  const want = normLow(markerPath);
  if (!cand || !want) return false;
  if (cand === want) return true;
  if (cand.endsWith("/" + want)) return true;

  const candBase = cand.split("/").pop() || "";
  const wantBase = want.split("/").pop() || "";
  if (candBase && wantBase && candBase === wantBase) return true;

  // Full-path suffix: candidate ends with marker path segments
  if (want.includes("/") && cand.endsWith(want)) {
    const candStem = stemOfPath(candidatePath);
    const wantStem = stemOfPath(markerPath);
    if (candStem.toLowerCase() === wantStem.toLowerCase()) return true;
  }
  return false;
}

/**
 * code: Foo matches Foo.cs / FooService.cs stem exact — not IFoo.cs.
 * Implementation stem may equal code or start with code as Pascal prefix.
 */
export function codeMatchesPathStem(code: string, pathRel: string): boolean {
  const c = (code || "").trim();
  if (!c) return false;
  const stem = stemOfPath(pathRel);
  if (!stem) return false;
  if (isInterfaceLikePrimaryPath(pathRel)) {
    // Explicit: code IFoo matches IFoo only
    return stem.toLowerCase() === c.toLowerCase();
  }
  const cl = c.toLowerCase();
  const sl = stem.toLowerCase();
  if (sl === cl) return true;
  // Foo → FooService / FooHandler (stem starts with code as whole Pascal word)
  if (sl.startsWith(cl) && (sl.length === cl.length || /^[A-Z]/.test(stem.slice(c.length)))) {
    return true;
  }
  return false;
}

/** Feature family stem for pairing IFooService ↔ FooService. */
export function implementationFamilyStem(pathRel: string): string {
  const stem = stemOfPath(pathRel);
  const stripped = stripInterfaceStemPrefix(stem);
  return stripped
    .replace(
      /(Service|Handler|Controller|Validator|UseCase|Policy|Repository|Manager|Provider)$/i,
      ""
    )
    .toLowerCase();
}

/** Prefer Handler/Service over bare Command / Delete when picking among concretes. */
function preferConcreteUnitShape(paths: string[]): string {
  const scored = paths.map((p) => {
    const base = stemOfPath(p);
    let rank = 50;
    if (/Handler$|Service$/i.test(base)) rank = 100;
    else if (/Delete/i.test(base)) rank = 15;
    else if (/Command$/i.test(base) && !/Handler$/i.test(base)) rank = 40;
    else if (/Query$/i.test(base)) rank = 30;
    return { p, rank };
  });
  scored.sort((a, b) => b.rank - a.rank || a.p.localeCompare(b.p));
  return scored[0]?.p || paths[0]!;
}

/**
 * Among path candidates, prefer concrete implementation over I* interface
 * when both share the same feature family (UploadService vs IUploadService).
 * Among concretes, prefer *Handler/*Service over bare *Command/*Delete.
 */
export function preferImplementationOverInterface(
  paths: string[]
): string[] {
  const list = (paths || []).map((p) => norm(p)).filter(Boolean);
  if (list.length <= 1) return list;

  const byFamily = new Map<string, string[]>();
  for (const p of list) {
    const fam = implementationFamilyStem(p) || stemOfPath(p).toLowerCase();
    const bucket = byFamily.get(fam) ?? [];
    bucket.push(p);
    byFamily.set(fam, bucket);
  }

  const out: string[] = [];
  const seen = new Set<string>();
  for (const p of list) {
    const fam = implementationFamilyStem(p) || stemOfPath(p).toLowerCase();
    const bucket = byFamily.get(fam) || [p];
    const impls = bucket.filter((x) => !isInterfaceLikePrimaryPath(x));
    const pick = impls.length
      ? preferConcreteUnitShape(impls)
      : bucket[0]!;
    const key = pick.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(pick);
  }
  return out;
}

/**
 * If current primary is interface-like and pool has a concrete sibling, return sibling.
 * Otherwise return primary unchanged.
 */
export function promoteImplementationPrimary(
  primaryPath: string,
  pool: string[]
): string {
  const primary = norm(primaryPath);
  if (!primary || !isInterfaceLikePrimaryPath(primary)) return primary;
  const fam = implementationFamilyStem(primary);
  if (!fam) return primary;
  for (const p of pool) {
    const n = norm(p);
    if (!n || isInterfaceLikePrimaryPath(n)) continue;
    if (implementationFamilyStem(n) === fam) return n;
  }
  return primary;
}

/** True when primary matches at least one path: or code: marker (exact helpers). */
export function primaryMatchesMarkers(
  primaryPath: string,
  markers: { paths?: string[] | null; codes?: string[] | null }
): boolean {
  const primary = norm(primaryPath);
  if (!primary) return false;
  for (const p of markers.paths || []) {
    if (pathsMatchMarker(primary, p)) return true;
  }
  for (const c of markers.codes || []) {
    if (codeMatchesPathStem(c, primary)) return true;
  }
  return false;
}
