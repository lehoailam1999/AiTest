/**
 * Deterministic VI/label → BE property from index + DTO Display.
 * Ambiguous labels: LLM shortlist pick (see llmPickUnitField) — no role heuristics.
 */
import type { CodeIndexSnapshot, IndexedSymbol } from "../codeIndex/types";

const LATIN_ID_RE = /^[A-Za-z_][\w]*$/;
const SHORTLIST_CAP = 24;

export function normFieldLabel(s: string): string {
  return (s || "")
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "");
}

function toPascalCase(id: string): string {
  const s = (id || "").trim();
  if (!s) return "";
  if (/^[A-Z]/.test(s) && LATIN_ID_RE.test(s)) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** EntityCreateCommandHandler → Entity */
function entityStemFromPrimary(primaryPath: string | null | undefined): string {
  const base = ((primaryPath || "").replace(/\\/g, "/").split("/").pop() || "")
    .replace(/\.[^.]+$/, "")
    .replace(/(CommandHandler|Handler|Service|Controller|Command)$/i, "");
  const stem = base
    .replace(/^(Create|Update|Delete|Get|Query|List|Add|Remove|Assign)/i, "")
    .replace(/(Create|Update|Delete|Get|Query|List|Add|Remove|Assign).*$/i, "");
  return (stem || base).replace(/Dto$/i, "");
}

function dtoPathsNearPrimary(
  snap: CodeIndexSnapshot,
  primaryPath: string
): string[] {
  const primary = primaryPath.replace(/\\/g, "/");
  const parts = primary.split("/").filter(Boolean);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const k of Object.keys(snap.files || {})) {
    const rel = k.replace(/\\/g, "/");
    const low = rel.toLowerCase();
    if (
      !/(dto|request|input|validator)/i.test(low) ||
      !/\.(cs|ts|tsx|js|jsx|java|kt|py|go)$/i.test(low)
    ) {
      continue;
    }
    let ok = false;
    for (const seg of parts) {
      if (seg.length >= 4 && low.includes(seg.toLowerCase())) {
        ok = true;
        break;
      }
    }
    if (!ok) {
      const primaryStem = (parts[parts.length - 1] || "")
        .replace(/\.[^.]+$/, "")
        .replace(/(commandhandler|handler|service|controller)$/i, "");
      const fileStem = (rel.split("/").pop() || "").replace(/\.[^.]+$/, "");
      if (
        primaryStem.length >= 4 &&
        fileStem.toLowerCase().includes(primaryStem.toLowerCase().slice(0, 8))
      ) {
        ok = true;
      }
    }
    if (!ok) continue;
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(rel);
  }
  const entity = entityStemFromPrimary(primary).toLowerCase();
  out.sort((a, b) => {
    const an = (a.split("/").pop() || "").toLowerCase();
    const bn = (b.split("/").pop() || "").toLowerCase();
    const aExact =
      entity && an === `${entity}dto.cs` ? 0 : entity && an.startsWith(entity) ? 1 : 2;
    const bExact =
      entity && bn === `${entity}dto.cs` ? 0 : entity && bn.startsWith(entity) ? 1 : 2;
    if (aExact !== bExact) return aExact - bExact;
    const as = /dto\.(cs|ts|tsx|js|jsx|java|kt|py|go)$/i.test(a) ? 0 : 1;
    const bs = /dto\.(cs|ts|tsx|js|jsx|java|kt|py|go)$/i.test(b) ? 0 : 1;
    return as - bs || a.length - b.length;
  });
  return out.slice(0, 24);
}

function propertiesInSource(src: string): string[] {
  const props: string[] = [];
  const patterns = [
    // C# / Java / Kotlin fields and auto-properties.
    /(?:\[.*?\]\s*)*(?:public|internal|private|protected)?\s*(?:readonly\s+)?[\w<>,.\s\[\]?]+\s+(\w+)\s*(?:\{\s*get|[;=])/gi,
    // TypeScript interface/class properties.
    /(?:^|\n)\s*(?:public|private|protected|readonly|declare)?\s*(\w+)\??\s*:\s*[\w<>{}\[\]|&.,\s]+[;=]?/gi,
    // Python/dataclass/Pydantic annotated fields.
    /(?:^|\n)\s*(\w+)\s*:\s*[\w.\[\]|, ]+(?:\s*=\s*[^\n]+)?/gi,
    // Go struct fields.
    /(?:^|\n)\s*(\w+)\s+[\w*\[\].]+(?:\s+`[^`]*`)?/gi,
  ];
  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(src))) {
      const name = m[1];
      if (name && LATIN_ID_RE.test(name)) props.push(name);
    }
  }
  return [...new Set(props)];
}

/** Properties from index symbols (kind=variable under a type) for DTO paths. */
export function propertiesFromIndex(
  snap: CodeIndexSnapshot | null | undefined,
  dtoPaths: string[]
): string[] {
  if (!snap?.symbolsByFile) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  const fileKeys = Object.keys(snap.symbolsByFile);
  for (const want of dtoPaths) {
    const wantNorm = want.replace(/\\/g, "/").toLowerCase();
    const hit =
      snap.symbolsByFile[want] ||
      fileKeys.find((k) => k.replace(/\\/g, "/").toLowerCase() === wantNorm) ||
      fileKeys.find((k) =>
        k
          .replace(/\\/g, "/")
          .toLowerCase()
          .endsWith("/" + wantNorm.split("/").pop())
      );
    const key = typeof hit === "string" ? hit : want;
    const syms: IndexedSymbol[] =
      (typeof hit === "string" ? snap.symbolsByFile[hit] : undefined) ||
      snap.symbolsByFile[key] ||
      [];
    for (const s of syms) {
      if (s.kind !== "variable" && s.kind !== "method") continue;
      if (!s.parent) continue;
      if (!LATIN_ID_RE.test(s.name)) continue;
      if (/dto$/i.test(s.name) && s.name[0] === s.name[0]?.toUpperCase()) continue;
      const n = s.name;
      if (seen.has(n)) continue;
      seen.add(n);
      out.push(n);
    }
  }
  return out;
}

export type ResolveFieldFromIndexInput = {
  fieldLabel: string;
  /** Optional input JSON keys — PascalCase match against index props */
  inputKeys?: string[];
  primaryPath?: string | null;
  relatedPaths?: string[] | null;
  /** Pre-read DTO bodies keyed by pathRel */
  dtoExcerpts?: Record<string, string>;
  codeIndex?: CodeIndexSnapshot | null;
};

export function fieldEvidencePaths(input: {
  primaryPath?: string | null;
  relatedPaths?: string[] | null;
  dtoExcerpts?: Record<string, string>;
  codeIndex?: CodeIndexSnapshot | null;
}): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const push = (p: string) => {
    const n = p.replace(/\\/g, "/");
    const k = n.toLowerCase();
    if (!n || seen.has(k)) return;
    seen.add(k);
    out.push(n);
  };
  for (const p of input.relatedPaths || []) {
    if (/dto\.cs$/i.test(p) || /\/dto\//i.test(p) || /\.dto\//i.test(p)) push(p);
  }
  if (input.dtoExcerpts) {
    for (const p of Object.keys(input.dtoExcerpts)) push(p);
  }
  if (input.primaryPath && input.codeIndex) {
    for (const p of dtoPathsNearPrimary(input.codeIndex, input.primaryPath)) push(p);
  }
  return out.slice(0, 6);
}

/**
 * Property shortlist from index DTO near primary — for LLM pick (cap 24).
 */
export function buildFieldPropertyShortlist(opts: {
  codeIndex?: CodeIndexSnapshot | null;
  primaryPath?: string | null;
  relatedPaths?: string[] | null;
  dtoExcerpts?: Record<string, string>;
}): string[] {
  const dtoPaths = fieldEvidencePaths(opts);
  const fromIndex = propertiesFromIndex(opts.codeIndex, dtoPaths);
  const fromExcerpt = new Set<string>();
  const excerpts = opts.dtoExcerpts || {};
  for (const rel of dtoPaths) {
    const body =
      excerpts[rel] ||
      excerpts[
        Object.keys(excerpts).find(
          (k) => k.replace(/\\/g, "/").toLowerCase() === rel.toLowerCase()
        ) || ""
      ];
    if (!body) continue;
    for (const p of propertiesInSource(body)) fromExcerpt.add(p);
  }
  return [...new Set([...fromIndex, ...fromExcerpt])].slice(0, SHORTLIST_CAP);
}

export type FieldPropertyEvidence = {
  name: string;
  ownerPath: string;
  ownerType?: string;
  excerpt?: string;
};

/** Owned property records; unlike a flat list these cannot drift across DTO candidates. */
export function buildFieldPropertyEvidence(opts: {
  codeIndex?: CodeIndexSnapshot | null;
  primaryPath?: string | null;
  relatedPaths?: string[] | null;
  dtoExcerpts?: Record<string, string>;
}): FieldPropertyEvidence[] {
  const paths = fieldEvidencePaths(opts);
  const out: FieldPropertyEvidence[] = [];
  const seen = new Set<string>();
  for (const path of paths) {
    const pathKey =
      Object.keys(opts.codeIndex?.symbolsByFile || {}).find(
        (k) => k.replace(/\\/g, "/").toLowerCase() === path.toLowerCase()
      ) || path;
    const symbols = opts.codeIndex?.symbolsByFile?.[pathKey] || [];
    const excerpt =
      opts.dtoExcerpts?.[path] ||
      opts.dtoExcerpts?.[
        Object.keys(opts.dtoExcerpts || {}).find(
          (k) => k.replace(/\\/g, "/").toLowerCase() === path.toLowerCase()
        ) || ""
      ];
    for (const symbol of symbols) {
      if (symbol.kind !== "variable" || !symbol.parent || !LATIN_ID_RE.test(symbol.name)) {
        continue;
      }
      const key = `${path.toLowerCase()}:${symbol.parent.toLowerCase()}:${symbol.name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        name: symbol.name,
        ownerPath: path,
        ownerType: symbol.parent,
        excerpt: excerpt?.slice(0, 1000),
      });
    }
    for (const name of propertiesInSource(excerpt || "")) {
      const key = `${path.toLowerCase()}::${name.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ name, ownerPath: path, excerpt: excerpt?.slice(0, 1000) });
    }
  }
  return out.slice(0, SHORTLIST_CAP);
}

/** True when property is already a known index/DTO shortlist member. */
export function isIndexedPropertyName(
  property: string | null | undefined,
  shortlist: string[]
): boolean {
  const want = String(property || "").trim();
  if (!want || !LATIN_ID_RE.test(want) || !shortlist.length) return false;
  const wantL = want.toLowerCase();
  return shortlist.some((p) => p.trim().toLowerCase() === wantL);
}

/**
 * Deterministic resolve only: Latin exact, input key ∈ props, Display attrs.
 * No VI role heuristics — use LLM shortlist when this returns null.
 * Never echo unbound TC labels (e.g. hoSoVuAn) as if they were BE properties.
 */
export function resolveFieldFromIndex(
  input: ResolveFieldFromIndexInput
): string | null {
  const label = (input.fieldLabel || "").trim();
  const inputKeys = (input.inputKeys || []).map((k) => k.trim()).filter(Boolean);

  const props = buildFieldPropertyShortlist(input);
  if (!props.length) return null;

  if (label && LATIN_ID_RE.test(label)) {
    const exact = props.find((p) => p.toLowerCase() === label.toLowerCase());
    if (exact) return exact;
  }

  for (const k of inputKeys) {
    if (LATIN_ID_RE.test(k) && /^[A-Z]/.test(k)) {
      const hit = props.find((p) => p.toLowerCase() === k.toLowerCase());
      if (hit) return hit;
    }
  }

  for (const k of inputKeys) {
    if (!LATIN_ID_RE.test(k)) continue;
    const pascal = toPascalCase(k);
    const hit = props.find((p) => p.toLowerCase() === pascal.toLowerCase());
    if (hit) return hit;
  }

  const want = normFieldLabel(label);
  if (want) {
    for (const prop of props) {
      const pn = normFieldLabel(prop);
      if (pn === want) return prop;
    }
  }

  const excerpts = input.dtoExcerpts || {};
  for (const rel of Object.keys(excerpts)) {
    const body = excerpts[rel];
    if (!body || !want) continue;
    const displayRe = new RegExp(
      `\\[Display\\([^\\)]*Name\\s*=\\s*["'\`]([^"'\`]+)["'\`]`,
      "gi"
    );
    let dm: RegExpExecArray | null;
    while ((dm = displayRe.exec(body))) {
      const disp = dm[1] || "";
      if (normFieldLabel(disp) === want) {
        const after = body.slice(dm.index, dm.index + 400);
        const pm = after.match(
          /(?:public|internal)\s+[\w<>,\s\[\]?]+\s+(\w+)\s*\{\s*get/i
        );
        if (pm?.[1]) return pm[1];
      }
    }
  }

  return null;
}

export type BindTargetPropertyResult = {
  testData: string;
  bound: boolean;
  property?: string;
};

/** Resolve profile `code-aliases.fields` by target.field label or input key. */
export function resolvePropertyFromFieldAliases(
  testData: string | null | undefined,
  fieldAliases: Record<string, string | string[]> | null | undefined
): string | null {
  const raw = String(testData || "");
  if (!raw.trim() || !fieldAliases || typeof fieldAliases !== "object") return null;
  const field =
    raw.match(/^\s*target\.field\s*:\s*(.+)$/im)?.[1]?.trim() || "";
  const inputRaw = raw.match(/^\s*input\s*:\s*(\{[\s\S]*?\})\s*$/im)?.[1];
  let inputKeys: string[] = [];
  if (inputRaw) {
    try {
      inputKeys = Object.keys(JSON.parse(inputRaw) as Record<string, unknown>);
    } catch {
      /* ignore */
    }
  }
  const wanted = new Set(
    [field, ...inputKeys].map(normFieldLabel).filter(Boolean)
  );
  for (const [alias, mapped] of Object.entries(fieldAliases)) {
    if (!wanted.has(normFieldLabel(alias))) continue;
    const values = Array.isArray(mapped) ? mapped : [mapped];
    const property = values
      .map((value) => String(value || "").trim())
      .find((value) => LATIN_ID_RE.test(value));
    if (property) return property;
  }
  return null;
}

function applyPropertyToTestData(
  raw: string,
  property: string,
  propM: RegExpMatchArray | null,
  inputM: RegExpMatchArray | null
): string {
  let next = raw;
  if (propM) {
    next = next.replace(/^(\s*target\.property\s*:\s*).+$/im, `$1${property}`);
  } else {
    next = next.replace(
      /^(\s*target\.field\s*:\s*.+)$/im,
      `$1\ntarget.property: ${property}`
    );
  }

  if (inputM) {
    try {
      const obj = JSON.parse(inputM[1]) as Record<string, unknown>;
      const keys = Object.keys(obj);
      let changed = false;
      const nextObj: Record<string, unknown> = {};
      for (const k of keys) {
        const needsRewrite =
          !LATIN_ID_RE.test(k) ||
          /[^\x00-\x7F]/.test(k) ||
          (k !== property &&
            normFieldLabel(k) !== normFieldLabel(property) &&
            !/^[A-Z]/.test(k));
        if (
          keys.length === 1 &&
          (needsRewrite || k.toLowerCase() !== property.toLowerCase())
        ) {
          nextObj[property] = obj[k];
          changed = true;
        } else if (k.toLowerCase() === property.toLowerCase() && k !== property) {
          nextObj[property] = obj[k];
          changed = true;
        } else {
          nextObj[k] = obj[k];
        }
      }
      if (changed) {
        const json = JSON.stringify(nextObj);
        next = next.replace(/^\s*input\s*:\s*\{[\s\S]*?\}\s*$/im, `input: ${json}`);
      }
    } catch {
      /* ignore */
    }
  }
  return next;
}

/**
 * Insert target.property + rewrite input keys when field binds from index/DTO
 * or from LLM shortlist override (must be Latin id).
 */
export function bindTargetPropertyInTestData(
  testData: string | null | undefined,
  opts: {
    primaryPath?: string | null;
    relatedPaths?: string[] | null;
    codeIndex?: CodeIndexSnapshot | null;
    dtoExcerpts?: Record<string, string>;
    /** LLM / caller pick — must be Latin; preferred over deterministic when set */
    propertyOverride?: string | null;
  }
): BindTargetPropertyResult {
  const raw = testData || "";
  if (!raw.trim()) return { testData: raw, bound: false };

  const fieldM = raw.match(/^\s*target\.field\s*:\s*(.+)$/im);
  const propM = raw.match(/^\s*target\.property\s*:\s*(.+)$/im);
  if (!fieldM) return { testData: raw, bound: false };
  const fieldLabel = fieldM[1].trim();
  const shortlist = buildFieldPropertyShortlist({
    primaryPath: opts.primaryPath,
    relatedPaths: opts.relatedPaths,
    codeIndex: opts.codeIndex,
    dtoExcerpts: opts.dtoExcerpts,
  });
  const existingProp = propM?.[1]?.trim() || "";
  // Skip only when target.property is already a real index/DTO member.
  if (existingProp && isIndexedPropertyName(existingProp, shortlist)) {
    return { testData: raw, bound: false, property: existingProp };
  }

  let inputKeys: string[] = [];
  const inputM = raw.match(/^\s*input\s*:\s*(\{[\s\S]*?\})\s*$/im);
  if (inputM) {
    try {
      const obj = JSON.parse(inputM[1]) as Record<string, unknown>;
      inputKeys = Object.keys(obj);
    } catch {
      /* ignore */
    }
  }

  const override = (opts.propertyOverride || "").trim();
  let property: string | null = null;
  if (override && LATIN_ID_RE.test(override)) {
    // Prefer override when it is in shortlist, or shortlist is unavailable.
    if (!shortlist.length || isIndexedPropertyName(override, shortlist)) {
      property = shortlist.find((p) => p.toLowerCase() === override.toLowerCase()) || override;
    }
  }
  if (!property) {
    property = resolveFieldFromIndex({
      fieldLabel,
      inputKeys,
      primaryPath: opts.primaryPath,
      relatedPaths: opts.relatedPaths,
      codeIndex: opts.codeIndex,
      dtoExcerpts: opts.dtoExcerpts,
    });
  }
  if (!property) return { testData: raw, bound: false };

  const next = applyPropertyToTestData(raw, property, propM, inputM);
  return { testData: next, bound: true, property };
}
