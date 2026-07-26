import type { TestCase } from "../../api/types";
import { normalizeFunctionLabel } from "../normalizeFunctionLabel";
import {
  expandVietnameseToCodeTokens,
  parseCodeHintsFromText,
  type CodeAliasMap,
} from "./viCodeAliases";
import type { ProjectFileIndex, ResolvedSeed, SeedCandidate } from "./types";
import { findByStem } from "./projectIndex";

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
  { re: /(controller|service|handler|manager|usecase|use-case|repository|repo|api|page|viewmodel|view)\b/i, pts: 14 },
  { re: /\b(dto|model|entity|domain)\b/i, pts: 4 },
];

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

/** Tách token từ chuỗi (Latin + bỏ dấu VN + CamelCase + alias dự án). */
export function extractMatchTokens(
  raw: string,
  projectAliases?: CodeAliasMap | null
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
  out.push(...expandVietnameseToCodeTokens(text, projectAliases));
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

  const moduleTokens = extractMatchTokens(tc.module ?? "", projectAliases);
  const titleTokens = extractMatchTokens(tc.title ?? "", projectAliases);
  const bodyTokens = extractMatchTokens(
    [tc.steps, tc.expectedResult, tc.precondition ?? ""].join(" "),
    projectAliases
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
  hintTokens: string[] = []
): { score: number; hits: string[] } {
  const { lower, stem, segments } = pathParts(pathRel);
  const stemAscii = stripDiacritics(stem).toLowerCase();
  const hits: string[] = [];
  let score = 0;

  const hitToken = (t: string, weightStem: number, weightSeg: number, weightPath: number) => {
    const tl = stripDiacritics(t).toLowerCase();
    if (tl.length < 2) return;
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

  for (const t of hintTokens) hitToken(t, 40, 28, 12);
  for (const t of moduleTokens) hitToken(t, 28, 18, 8);
  for (const t of titleTokens) hitToken(t, 14, 8, 4);
  for (const t of bodyTokens) hitToken(t, 10, 5, 2);

  for (const layer of LAYER_BONUS) {
    if (layer.re.test(pathRel)) score += layer.pts;
  }

  if (/\.(test|spec)\./i.test(pathRel) || /\/(test|tests|spec|__tests__|mocks?)\//i.test(lower)) {
    score -= 40;
  }
  if (/\/(bin|obj|dist|node_modules|vendor|\.git)\//i.test(lower)) score -= 100;

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
  const aiTokens = uniq(
    (opts.extraCodeTokens ?? [])
      .map((t) => String(t).trim())
      .filter(Boolean)
      .flatMap((t) => [t, ...extractMatchTokens(t, opts.projectAliases)])
  );
  const effectiveHints = uniq([...hintTokens, ...aiTokens]);
  const effectiveAll = uniq([...effectiveHints, ...all]);
  if (!effectiveAll.length && !pathHints.length) return [];

  const scored: SeedCandidate[] = [];

  // path: hints → ưu tiên tuyệt đối nếu khớp file local
  for (const hint of pathHints) {
    const h = hint.replace(/\\/g, "/").toLowerCase();
    for (const f of index.files) {
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

  for (const f of index.files) {
    if (scored.some((s) => s.pathRel === f.pathRel)) continue;
    const { score, hits } = scorePath(
      f.pathRel,
      moduleTokens,
      titleTokens,
      bodyTokens,
      effectiveHints
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

  return scored.slice(0, limit);
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
