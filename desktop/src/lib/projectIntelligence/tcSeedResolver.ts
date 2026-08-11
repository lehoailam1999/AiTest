import {
  extractUnitIntent,
  filterStrongRankTokens,
  filterUnitLogicLayerCandidates,
  isDeniedUnitPrimaryPath,
  UNIT_INTENT_DEFS,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { normalizeFunctionLabel } from "../normalizeFunctionLabel";
import { isExcludedFromUnitRetrieve } from "../retrieval/rankScore";
import {
  expandCodeMatchTokens,
  parseCodeHintsFromText,
  type CodeAliasMap,
} from "./viCodeAliases";
import type { ProjectFileIndex, ResolvedSeed, SeedCandidate } from "./types";
import { findByStem, findByToken } from "./projectIndex";

/** Bỏ dấu tiếng Việt để khớp tên file Latin / PascalCase. */
export function stripDiacritics(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/đ/g, "d")
    .replace(/Đ/g, "D");
}

const STOP = new Set(
  [
    "the",
    "and",
    "for",
    "with",
    "from",
    "that",
    "this",
    "when",
    "then",
    "user",
    "test",
    "case",
    "step",
    "expected",
    "result",
    "system",
    "nhap",
    "vao",
    "cua",
    "cho",
    "voi",
    "khi",
    "thi",
    "cac",
    "mot",
    "nay",
    "duoc",
    "khong",
    "phai",
    "tren",
    "duoi",
    "sau",
    "truoc",
  ].map((x) => x)
);

const LAYER_BONUS = [
  { re: /(^|\/)(src|lib|app|backend|server|api|application|domain)(\/|$)/i, pts: 22 },
  {
    re: /(controller|service|handler|manager|usecase|use-case|repository|repo|validator|validation|policy|authorization|command|query)\b/i,
    pts: 18,
  },
  { re: /\b(dto|model|entity|domain|mapper|helper|util)\b/i, pts: 6 },
];

/** Không lấy tài liệu / FE shell / thin HTTP client làm SUT Unit. */
const LAYER_PENALTY = [
  {
    re: /(^|\/)(docs?|documentation|scripts?|tools?|examples?|samples?|fixtures?|tmp|temp|migrations?)(\/|$)/i,
    pts: -90,
  },
  { re: /(generate_srs|openapi|swagger|readme)/i, pts: -55 },
  {
    re: /(\/clientapp\/|\/client-app\/|\/wwwroot\/|\/components?\/|\/pages?\/|\/views?\/|\.component\.(ts|js))/i,
    pts: -70,
  },
  { re: /\.designer\.cs$|\.snapshot\.cs$|modelsnapshot\.cs$/i, pts: -100 },
];

type ExtFamily = "node" | "python" | "dotnet" | "other";

function extFamilyOf(pathRel: string): ExtFamily {
  const p = pathRel.toLowerCase().replace(/\\/g, "/");
  if (/\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p)) return "node";
  if (p.endsWith(".py")) return "python";
  if (p.endsWith(".cs")) return "dotnet";
  return "other";
}

function dominantExtFamily(index: ProjectFileIndex): ExtFamily {
  const counts: Record<ExtFamily, number> = {
    node: 0,
    python: 0,
    dotnet: 0,
    other: 0,
  };
  for (const f of index.files) {
    counts[extFamilyOf(f.pathRel)] += 1;
  }
  let best: ExtFamily = "other";
  let n = 0;
  for (const k of ["node", "dotnet", "python"] as ExtFamily[]) {
    if (counts[k] > n) {
      n = counts[k];
      best = k;
    }
  }
  return best;
}

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

/** Tách token từ chuỗi (Latin + bỏ dấu VN + CamelCase + alias + optional index stems). */
export function extractMatchTokens(
  raw: string,
  projectAliases?: CodeAliasMap | null,
  indexPaths?: string[] | null
): string[] {
  const text = normalizeFunctionLabel(raw);
  if (!text) return [];
  const ascii = stripDiacritics(text);
  const out: string[] = [];

  for (const m of ascii.match(/[A-Za-z][a-z]+|[A-Z]+(?![a-z])|[A-Za-z]+|\d+/g) ?? []) {
    if (m.length >= 2) out.push(m);
  }
  for (const m of ascii.toLowerCase().match(/[a-z0-9_]{2,}/g) ?? []) {
    if (!STOP.has(m)) out.push(m);
  }
  const words = ascii
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 2 && !STOP.has(w));
  if (words.length >= 2) {
    out.push(words.join(""));
    out.push(words.join("_"));
    out.push(words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(""));
  }
  out.push(
    ...expandCodeMatchTokens(text, { projectAliases, indexPaths })
  );
  return uniq(out);
}

function tokensFromTc(
  tc: TestCase,
  projectAliases?: CodeAliasMap | null
): {
  moduleTokens: string[];
  titleTokens: string[];
  bodyTokens: string[];
  hintTokens: string[];
  pathHints: string[];
  all: string[];
} {
  const hintBlob = [tc.testData ?? "", tc.precondition ?? "", tc.steps ?? ""].join("\n");
  const { codeTokens, pathHints } = parseCodeHintsFromText(hintBlob);

  const moduleTokens = filterStrongRankTokens(
    extractMatchTokens(tc.module ?? "", projectAliases)
  );
  const titleTokens = filterStrongRankTokens(
    extractMatchTokens(tc.title ?? "", projectAliases)
  );
  const bodyTokens = filterStrongRankTokens(
    extractMatchTokens(
      [tc.steps, tc.expectedResult, tc.precondition ?? ""].join(" "),
      projectAliases
    )
  );
  const techBody = bodyTokens.filter(
    (t) => /[A-Z]/.test(t) || t.includes("_") || t.length >= 5
  );
  const hintTokens = uniq([
    ...codeTokens,
    ...codeTokens.flatMap((c) => extractMatchTokens(c, projectAliases)),
  ]);
  return {
    moduleTokens,
    titleTokens,
    bodyTokens: techBody,
    hintTokens,
    pathHints,
    all: uniq([...hintTokens, ...moduleTokens, ...titleTokens, ...techBody]),
  };
}

function pathParts(pathRel: string): { lower: string; stem: string; segments: string[] } {
  const lower = pathRel.toLowerCase().replace(/\\/g, "/");
  const base = lower.split("/").pop() || lower;
  const stem = base.replace(/\.[^.]+$/, "");
  const segments = lower.split("/").filter(Boolean);
  return { lower, stem, segments };
}

function scorePath(
  pathRel: string,
  moduleTokens: string[],
  titleTokens: string[],
  bodyTokens: string[],
  hintTokens: string[] = [],
  dominantFamily: ExtFamily = "other",
  requirementTokens: string[] = []
): { score: number; hits: string[] } {
  const { lower, stem, segments } = pathParts(pathRel);
  const stemAscii = stripDiacritics(stem).toLowerCase();
  const hits: string[] = [];
  let score = 0;

  const hitToken = (t: string, weightStem: number, weightSeg: number, weightPath: number) => {
    const tl = stripDiacritics(t).toLowerCase();
    if (tl.length < 2) return;
    // Short tokens: segment/stem equality only (activate ⊃ vat).
    if (tl.length <= 3) {
      if (stemAscii === tl || segments.some((seg) => seg.replace(/\.[^.]+$/, "") === tl)) {
        score += weightStem;
        hits.push(t);
      }
      return;
    }
    if (stemAscii === tl || stemAscii.includes(tl) || tl.includes(stemAscii)) {
      score += weightStem;
      hits.push(t);
    } else if (segments.some((seg) => seg.includes(tl) || tl.includes(seg.replace(/\.[^.]+$/, "")))) {
      score += weightSeg;
      hits.push(t);
    } else if (lower.includes(tl)) {
      score += weightPath;
      hits.push(t);
    }
  };

  // Progressive: requirement → hints/markers → module → title → body
  for (const t of requirementTokens) hitToken(t, 36, 24, 10);
  for (const t of hintTokens) hitToken(t, 40, 28, 12);
  for (const t of moduleTokens) hitToken(t, 28, 18, 8);
  for (const t of titleTokens) hitToken(t, 14, 8, 4);
  for (const t of bodyTokens) hitToken(t, 10, 5, 2);

  for (const layer of LAYER_BONUS) {
    if (layer.re.test(pathRel)) score += layer.pts;
  }
  for (const layer of LAYER_PENALTY) {
    if (layer.re.test(pathRel)) score += layer.pts;
  }

  if (/\.(test|spec)\./i.test(pathRel) || /\/(test|tests|spec|__tests__|mocks?)\//i.test(lower)) {
    score -= 40;
  }
  if (/\/(bin|obj|dist|node_modules|vendor|\.git)\//i.test(lower)) score -= 100;

  const fam = extFamilyOf(pathRel);
  if (
    dominantFamily !== "other" &&
    fam !== "other" &&
    fam !== dominantFamily
  ) {
    // Repo chủ yếu Nest/TS (Jest) → đừng chọn docs/*.py làm SUT.
    score -= 70;
  }

  score -= Math.min(6, Math.max(0, segments.length - 3));

  return { score, hits: uniq(hits) };
}

export type { SeedCandidate };

export type SeedResolveOptions = {
  limit?: number;
  /** Alias VI → code token cấu hình trên project.meta.codeAliases */
  projectAliases?: CodeAliasMap | null;
  /** Token EN/code từ AI (map VI→identifier) — ưu tiên như hintTokens */
  extraCodeTokens?: string[] | null;
  /** Requirement title — progressive grounding (highest soft scope) */
  requirementTitle?: string | null;
  /**
   * Profile unit.scope — default backend.
   * UI/master intents refuse writeBack under backend.
   */
  unitScope?: "backend" | "frontend" | "any";
};

/**
 * Chọn file nguồn primary từ TC.
 * Ưu tiên: code:/path: trong TC → alias dự án → AI tokens → module/title (không gắn domain cứng).
 */
export function resolveSeedCandidates(
  tc: TestCase,
  index: ProjectFileIndex,
  limitOrOpts: number | SeedResolveOptions = 8
): SeedCandidate[] {
  const opts: SeedResolveOptions =
    typeof limitOrOpts === "number" ? { limit: limitOrOpts } : limitOrOpts ?? {};
  const limit = opts.limit ?? 8;
  const { moduleTokens, titleTokens, bodyTokens, hintTokens, pathHints, all } = tokensFromTc(
    tc,
    opts.projectAliases
  );
  const requirementTokens = filterStrongRankTokens(
    extractMatchTokens(opts.requirementTitle || "", opts.projectAliases)
  );
  const aiTokens = filterStrongRankTokens(
    uniq(
      (opts.extraCodeTokens ?? [])
        .map((t) => String(t).trim())
        .filter(Boolean)
        .flatMap((t) => [t, ...extractMatchTokens(t, opts.projectAliases)])
    )
  );
  const intent = extractUnitIntent(tc, {
    projectAliases: opts.projectAliases,
    requirementTitle: opts.requirementTitle,
    uiFromTitleModuleOnly: true,
  });
  // Body-rule: rank with body-rule class features (Upload/MaxFileSize), not
  // upload_resource Digital* or alias Evidence — those soft-boost via module/req.
  const bodyRuleRankTokens = filterStrongRankTokens(
    uniq(
      UNIT_INTENT_DEFS.filter(
        (d) => d.requiresBodyRule && intent.classes.includes(d.id)
      ).flatMap((d) => [...d.featureTokens, ...(d.rulePatterns ?? d.codePatterns)])
    )
  );
  const intentTokens = filterStrongRankTokens(
    uniq(
      (intent.requiresBodyRule && bodyRuleRankTokens.length
        ? bodyRuleRankTokens
        : intent.requiresBodyRule
          ? [...intent.classFeatureTokens, ...intent.codePatterns]
          : [...intent.featureTokens, ...intent.codePatterns]
      ).filter((t) => t.length >= 3)
    )
  );
  const effectiveHints = uniq([...hintTokens, ...aiTokens, ...intentTokens]);
  const effectiveAll = uniq([...effectiveHints, ...requirementTokens, ...all]);
  if (!effectiveAll.length && !pathHints.length) return [];

  const dominant = dominantExtFamily(index);
  const scored: SeedCandidate[] = [];

  // path: hints → ưu tiên tuyệt đối nếu khớp file local (production only)
  for (const hint of pathHints) {
    const h = hint.replace(/\\/g, "/").toLowerCase();
    for (const f of index.files) {
      if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
      // Explicit path: may point at FE — keep for manual override; auto still filtered later
      const p = f.pathRel.replace(/\\/g, "/").toLowerCase();
      if (p === h || p.endsWith(`/${h}`) || p.includes(h)) {
        scored.push({
          pathRel: f.pathRel,
          score: 200,
          hits: [hint],
          reason: `path: trong TC → ${hint}`,
        });
      }
    }
  }

  // Progressive pool: Requirement scopes → Module narrows → then score (+ title)
  const reqPool = new Map<string, (typeof index.files)[0]>();
  for (const t of requirementTokens) {
    for (const f of findByToken(index, t)) {
      if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
      reqPool.set(f.pathRel, f);
    }
  }
  let scoped = reqPool.size > 0 ? [...reqPool.values()] : null;
  if (scoped && moduleTokens.length) {
    const modNarrow = scoped.filter((f) => {
      const low = f.pathRel.toLowerCase();
      const stem = f.stem.toLowerCase();
      return moduleTokens.some((t) => {
        const tl = t.toLowerCase();
        return low.includes(tl) || stem.includes(tl);
      });
    });
    if (modNarrow.length) scoped = modNarrow;
  }
  // Title further narrows when still broad
  if (scoped && scoped.length > 24 && titleTokens.length) {
    const titleNarrow = scoped.filter((f) => {
      const low = f.pathRel.toLowerCase();
      const stem = f.stem.toLowerCase();
      return titleTokens.some((t) => {
        const tl = t.toLowerCase();
        return tl.length >= 3 && (low.includes(tl) || stem.includes(tl));
      });
    });
    if (titleNarrow.length) scoped = titleNarrow;
  }

  const poolTokens = uniq([
    ...requirementTokens,
    ...moduleTokens,
    ...effectiveHints,
    ...titleTokens.slice(0, 12),
  ]);
  const pool = new Map<string, (typeof index.files)[0]>();
  if (scoped) {
    for (const f of scoped) pool.set(f.pathRel, f);
  } else {
    for (const t of poolTokens) {
      for (const f of findByToken(index, t)) {
        if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
        pool.set(f.pathRel, f);
      }
    }
  }
  // If requirement tokens miss the path-index (e.g. VI noun vs English folder),
  // fall back to module/title/hint pool — do not return empty (blocks all enrich).
  if (requirementTokens.length && reqPool.size === 0 && pool.size === 0) {
    for (const t of uniq([...moduleTokens, ...titleTokens, ...effectiveHints])) {
      for (const f of findByToken(index, t)) {
        if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
        pool.set(f.pathRel, f);
      }
    }
  }
  // Phase 1/3: body-rule class tokens lead the pool (upload_size_limit → Upload/
  // InitUpload), not broader upload_resource Digital* or project aliases (Evidence).
  const bodyRuleFeat = uniq(
    UNIT_INTENT_DEFS.filter(
      (d) => d.requiresBodyRule && intent.classes.includes(d.id)
    )
      .flatMap((d) => d.featureTokens)
      .filter((x) => x.length >= 4)
  );
  const classFeat = (
    intent.requiresBodyRule && bodyRuleFeat.length
      ? bodyRuleFeat
      : intent.classFeatureTokens
  ).filter((x) => x.length >= 4);
  const intentPool = new Map<string, (typeof index.files)[0]>();
  for (const t of classFeat) {
    for (const f of findByToken(index, t)) {
      if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
      if (isDeniedUnitPrimaryPath(f.pathRel)) continue;
      intentPool.set(f.pathRel, f);
    }
  }
  if (intent.requiresBodyRule && intentPool.size > 0) {
    pool.clear();
    for (const f of intentPool.values()) pool.set(f.pathRel, f);
  } else {
    for (const f of intentPool.values()) pool.set(f.pathRel, f);
  }
  const scanList =
    pool.size > 0 && pool.size < Math.max(80, index.files.length * 0.35)
      ? [...pool.values()]
      : requirementTokens.length && pool.size > 0
        ? [...pool.values()]
        : index.files;

  for (const f of scanList) {
    if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
    if (isDeniedUnitPrimaryPath(f.pathRel)) continue;
    if (scored.some((s) => s.pathRel === f.pathRel)) continue;
    const { score, hits } = scorePath(
      f.pathRel,
      moduleTokens,
      titleTokens,
      bodyTokens,
      effectiveHints,
      dominant,
      requirementTokens
    );
    if (score < 8) continue;
    scored.push({
      pathRel: f.pathRel,
      score,
      hits,
      reason: hits.length
        ? `Khớp TC: ${hits.slice(0, 6).join(", ")}`
        : "Heuristic path",
    });
  }

  scored.sort((a, b) => b.score - a.score || a.pathRel.localeCompare(b.pathRel));

  if (scored.length === 0) {
    for (const t of effectiveHints.length
      ? effectiveHints
      : moduleTokens.length
        ? moduleTokens
        : effectiveAll) {
      const byStem = findByStem(index, t);
      for (const f of byStem) {
        if (isExcludedFromUnitRetrieve(f.pathRel)) continue;
        scored.push({
          pathRel: f.pathRel,
          score: 6,
          hits: [t],
          reason: `Tên file trùng «${t}»`,
        });
      }
    }
    scored.sort((a, b) => b.score - a.score);
  }

  const filtered = filterUnitLogicLayerCandidates(scored, {
    tcText: [
      tc.title,
      tc.module,
      tc.steps,
      tc.expectedResult,
      tc.testData,
    ]
      .filter(Boolean)
      .join("\n"),
  });
  // Explicit path: hints win even if shape is denied (manual marker intent)
  if (!filtered.length) {
    const hinted = scored.filter((s) => s.score >= 200);
    return hinted.slice(0, limit);
  }
  return filtered.slice(0, limit);
}

export function resolveSeedFromTestCase(
  tc: TestCase,
  index: ProjectFileIndex,
  opts?: SeedResolveOptions
): ResolvedSeed | null {
  const candidates = resolveSeedCandidates(tc, index, opts ?? 1);
  if (!candidates.length) return null;
  const best = candidates[0];
  return {
    pathRel: best.pathRel,
    score: best.score,
    reason: best.reason,
  };
}

/** Top ứng viên để UI cho chọn khi auto-pick chưa đúng. */
export function resolveSeedFromTestCaseWithAlternatives(
  tc: TestCase,
  index: ProjectFileIndex,
  opts?: SeedResolveOptions
): { best: ResolvedSeed | null; candidates: SeedCandidate[] } {
  const candidates = resolveSeedCandidates(tc, index, { ...opts, limit: opts?.limit ?? 8 });
  const best = candidates[0]
    ? { pathRel: candidates[0].pathRel, score: candidates[0].score, reason: candidates[0].reason }
    : null;
  return { best, candidates };
}
