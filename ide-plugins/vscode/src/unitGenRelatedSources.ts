/**
 * Resolve related production sources for Unit Gen (bounded, project-agnostic).
 * Collects many path candidates (name-only), ranks, then reads top hits.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  UNIT_GEN_LIMITS,
  PATH_RANK_STOP,
  codeMatchesPathStem,
  entryFeatureKeys,
  extractOpPreferTokens,
  extractTcSourceMarkers,
  extractUnitIntent,
  expandUnitRelatedPaths,
  filterUnitLogicLayerCandidates,
  isBlockedUnitPrimaryPath,
  isSutAlignedEnough,
  isWeakUnitClientPath,
  pathContradictsOpPreferTokens,
  pathsMatchMarker,
  promoteImplementationPrimary,
  isInterfaceLikePrimaryPath,
  sutTcAlignmentScore,
  expandVietnameseToCodeTokens,
  sutDomainConflict,
  isPacketSutAcceptable,
  weakCommonPathTokenPenalty,
  type CodeAliasMap,
} from "@aitest/ide-protocol";

const SKIP_DIR = new Set([
  "node_modules",
  ".git",
  "dist",
  "build",
  "coverage",
  "bin",
  "obj",
  ".ai-test",
  "aitest",
  "vendor",
  "__pycache__",
  "test",
  "tests",
  "__tests__",
]);

export function isNonProductionUnitPath(relOrName: string): boolean {
  const p = relOrName.replace(/\\/g, "/").toLowerCase();
  if (/(^|\/)(test|tests|__tests__|spec)(\/|$)/.test(p)) return true;
  if (p.includes("/integration/") || p.includes("/integrations/")) return true;
  if (/\/[^/]+\.(test|tests)(\/|$)/.test(p)) return true;
  const base = p.split("/").pop() || p;
  if (/\.(test|spec)\./i.test(base)) return true;
  if (/tests?\.cs$/.test(base) || /\.(tests?|spec)\.cs$/.test(base)) return true;
  // EF migrations / designer — never Unit SUT (conflict with Gen when TC has no markers)
  if (/(^|\/)migrations?(\/|$)/.test(p)) return true;
  if (/\.designer\.cs$/.test(base) || /\.snapshot\.cs$/.test(base) || /modelsnapshot\.cs$/.test(base))
    return true;
  return false;
}

const SRC_EXT = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".cs",
  ".py",
  ".go",
  ".java",
  ".kt",
]);

/** Paths to score (name-only). Large repos need far more than 120. */
const MAX_PATH_CANDIDATES = 4000;
/** Files to read after ranking */
const MAX_READ_CANDIDATES = 16;

function tokensFrom(
  parts: Array<string | undefined>,
  codeAliases?: CodeAliasMap | null
): string[] {
  const bag = new Set<string>();
  const blob = parts.filter(Boolean).join("\n");
  for (const p of parts) {
    const raw = (p || "")
      .replace(/[^\p{L}\p{N}]+/gu, " ")
      .split(/\s+/)
      .map((t) => t.trim().toLowerCase())
      .filter((t) => t.length >= 3 && t.length <= 40 && !PATH_RANK_STOP.has(t));
    for (const t of raw) bag.add(t);
  }
  for (const t of expandVietnameseToCodeTokens(blob, codeAliases)) {
    const low = t.toLowerCase();
    if (low.length >= 3 && !PATH_RANK_STOP.has(low)) bag.add(low);
    for (const part of t.replace(/([a-z])([A-Z])/g, "$1 $2").split(/\s+/)) {
      const p = part.toLowerCase();
      if (p.length >= 3 && !PATH_RANK_STOP.has(p)) bag.add(p);
    }
  }
  return [...bag].slice(0, 48);
}

async function loadModuleMapTokens(root: string): Promise<string[]> {
  try {
    const raw = await fs.readFile(
      path.join(root, ".ai-test", "project-profile.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as { moduleMap?: Record<string, string> };
    const out: string[] = [];
    for (const [k, v] of Object.entries(parsed.moduleMap || {})) {
      if (k.length >= 3) out.push(k);
      for (const seg of (v || "").split(/[/\\]+/)) {
        if (seg.length >= 3) out.push(seg);
      }
    }
    return out;
  } catch {
    return [];
  }
}

async function loadDiskCodeAliases(root: string): Promise<CodeAliasMap | null> {
  try {
    const raw = await fs.readFile(
      path.join(root, ".ai-test", "code-aliases.json"),
      "utf8"
    );
    const parsed = JSON.parse(raw) as CodeAliasMap;
    if (parsed && typeof parsed === "object") return parsed;
  } catch {
    /* optional */
  }
  return null;
}

async function walkFiles(
  root: string,
  dir: string,
  out: string[],
  budget: { n: number }
): Promise<void> {
  if (budget.n <= 0 || out.length >= MAX_PATH_CANDIDATES) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const ent of entries) {
    if (budget.n <= 0 || out.length >= MAX_PATH_CANDIDATES) return;
    const name = ent.name;
    if (name.startsWith(".")) continue;
    const abs = path.join(dir, name);
    if (ent.isDirectory()) {
      if (SKIP_DIR.has(name.toLowerCase())) continue;
      if (/\.(test|tests)$/i.test(name) || /^tests?$/i.test(name)) continue;
      budget.n -= 1;
      await walkFiles(root, abs, out, budget);
      continue;
    }
    if (!ent.isFile()) continue;
    const ext = path.extname(name).toLowerCase();
    if (!SRC_EXT.has(ext)) continue;
    const rel = path.relative(root, abs).replace(/\\/g, "/");
    if (isNonProductionUnitPath(rel)) continue;
    out.push(abs);
    budget.n -= 1;
  }
}

/** Phase 2 SoT — FE / thin upload / pipes; path: marker may override. */
function isUnsuitablePrimaryWithoutPathMarker(
  rel: string,
  markers: { paths: string[]; codes: string[] }
): boolean {
  return isBlockedUnitPrimaryPath(rel, markers);
}

function parseTcGrounding(md: string | undefined): {
  requirement: string;
  module: string;
  title: string;
} {
  const text = md || "";
  const fm = (key: string) => {
    const m = text.match(new RegExp(`^${key}:\\s*(.+)$`, "im"));
    return (m?.[1] || "").trim().replace(/^["']|["']$/g, "");
  };
  const block = (key: string) => {
    const m = text.match(
      new RegExp(`##\\s*Grounding[\\s\\S]*?^${key}:\\s*(.+)$`, "im")
    );
    return (m?.[1] || "").trim();
  };
  return {
    requirement: block("requirement") || fm("requirement"),
    module: block("module") || fm("module"),
    title: block("title") || fm("title"),
  };
}

function scorePath(
  abs: string,
  root: string,
  layers: {
    requirement: string[];
    module: string[];
    title: string[];
    other: string[];
  },
  markers: { paths: string[]; codes: string[] },
  tcBlob: string,
  codeAliases: CodeAliasMap | null
): number {
  const rel = path.relative(root, abs).replace(/\\/g, "/");
  const relLow = rel.toLowerCase();
  const base = path.basename(abs).toLowerCase();
  let score = 0;

  const hit = (tokens: string[], baseW: number, pathW: number) => {
    for (const t of tokens) {
      if (base.includes(t)) score += baseW;
      else if (relLow.includes(t)) score += pathW;
    }
  };
  // Progressive: requirement → module → title → other
  hit(layers.requirement, 16, 8);
  hit(layers.module, 12, 6);
  hit(layers.title, 8, 3);
  hit(layers.other, 5, 2);

  for (const p of markers.paths) {
    if (pathsMatchMarker(rel, p)) score += 40;
  }
  for (const c of markers.codes) {
    if (codeMatchesPathStem(c, rel)) score += 25;
  }
  if (/\/(src|app|lib|services|domain|application|handlers|controllers)\//i.test(rel)) {
    score += 2;
  }
  if (/(handler|controller|service|usecase|command|query|validator|policy)\./i.test(base))
    score += 4;
  if (/\.cs$/i.test(base) && /(handler|service|command|validator)/i.test(base)) score += 3;
  // Prefer command/write handlers over Get*Query for reject/validate mutation TCs (language-agnostic verbs)
  if (
    /^get|list|query/i.test(base) &&
    /reject|deny|validate|invalid|refuse|từ chối|tu choi/i.test(tcBlob)
  ) {
    score -= 10;
  }
  if (isWeakUnitClientPath(rel) && markers.paths.length === 0 && markers.codes.length === 0) {
    score -= 12;
  }
  // Phase 2 hard shapes — strong demote when not path:-overridden
  if (isUnsuitablePrimaryWithoutPathMarker(rel, markers)) {
    score -= 40;
  }
  if (
    sutDomainConflict({
      tcText: tcBlob,
      primaryPath: rel,
      codeAliases,
    }).conflict
  ) {
    score -= 100;
  }
  const strongHit =
    layers.requirement.some((t) => relLow.includes(t) || base.includes(t)) ||
    layers.module.some((t) => relLow.includes(t) || base.includes(t));
  score += weakCommonPathTokenPenalty(rel, {
    hasMarkers: markers.paths.length > 0 || markers.codes.length > 0,
    strongTokenHit: strongHit,
  });
  return score;
}

export type ResolveRelatedResult = {
  primaryPath?: string;
  source?: string;
  related?: string;
  alignmentScore?: number;
  sharedTokens?: string[];
  /** Top ranked paths (even on fail) — for fail-closed UX */
  candidates?: string[];
};

function acceptResolved(
  bestAlign: { score: number; markersHit: number },
  _pathScore: number,
  _secondPathScore: number,
  rel: string,
  markers: { paths: string[]; codes: string[] },
  tcBlob: string,
  codeAliases: CodeAliasMap | null
): boolean {
  if (isUnsuitablePrimaryWithoutPathMarker(rel, markers)) {
    return false;
  }
  if (
    sutDomainConflict({
      tcText: tcBlob,
      primaryPath: rel,
      codeAliases,
    }).conflict
  ) {
    return false;
  }
  // P0: no soft path-rank bypass — weak Create/Unit latch caused cross-domain primaries.
  return isSutAlignedEnough(bestAlign);
}

export async function resolveRelatedSourcesFromDisk(
  root: string,
  opts: {
    title?: string;
    module?: string;
    testCaseId?: string;
    testData?: string;
    /** Full TC markdown improves alignment */
    tcMd?: string;
    maxFiles?: number;
    maxCharsEach?: number;
    codeAliases?: CodeAliasMap | null;
  }
): Promise<ResolveRelatedResult> {
  const tcBlob = [opts.tcMd, opts.title, opts.module, opts.testData, opts.testCaseId]
    .filter(Boolean)
    .join("\n");
  const grounding = parseTcGrounding(opts.tcMd);
  const requirementLabel =
    grounding.requirement || opts.module || "";
  const moduleLabel = grounding.module || opts.module || "";
  const titleLabel = grounding.title || opts.title || "";

  const markers = extractTcSourceMarkers(tcBlob);
  const diskAliases =
    opts.codeAliases || (await loadDiskCodeAliases(root)) || null;
  const moduleMapTokens = await loadModuleMapTokens(root);

  const layers = {
    requirement: tokensFrom([requirementLabel], diskAliases),
    module: tokensFrom([moduleLabel, ...moduleMapTokens], diskAliases),
    title: tokensFrom([titleLabel], diskAliases),
    other: tokensFrom(
      [opts.testData, opts.testCaseId, opts.tcMd?.slice(0, 2000), ...markers.codes],
      diskAliases
    ),
  };
  const anyTokens =
    layers.requirement.length +
      layers.module.length +
      layers.title.length +
      layers.other.length >
    0;
  if ((!anyTokens && !markers.paths.length && !markers.codes.length) || !root) {
    return {};
  }

  const candidates: string[] = [];
  await walkFiles(root, root, candidates, { n: 12_000 });
  const maxChars = opts.maxCharsEach ?? UNIT_GEN_LIMITS.maxExcerptChars;
  const ranked = candidates
    .map((abs) => ({
      abs,
      score: scorePath(abs, root, layers, markers, tcBlob, diskAliases),
    }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(MAX_READ_CANDIDATES, opts.maxFiles ?? UNIT_GEN_LIMITS.maxRelatedFiles));
  const candidateRels = ranked.map((r) =>
    path.relative(root, r.abs).replace(/\\/g, "/")
  );
  if (!ranked.length) return { candidates: [] };

  const blocks: Array<{ rel: string; body: string; score: number }> = [];
  for (const r of ranked) {
    try {
      let body = await fs.readFile(r.abs, "utf8");
      if (body.length > maxChars) body = body.slice(0, maxChars) + "\n/* …truncated… */";
      const rel = path.relative(root, r.abs).replace(/\\/g, "/");
      blocks.push({ rel, body, score: r.score });
    } catch {
      /* skip */
    }
  }
  if (!blocks.length) return { candidates: candidateRels.slice(0, 5) };

  // Phase 2: prefer logic-layer candidates when no explicit path: marker
  const logicPool = markers.paths.length
    ? blocks
    : (() => {
        const kept = new Set(
          filterUnitLogicLayerCandidates(
            blocks.map((b) => ({ pathRel: b.rel, score: b.score }))
          ).map((c) => c.pathRel.replace(/\\/g, "/").toLowerCase())
        );
        return blocks.filter((b) => kept.has(b.rel.replace(/\\/g, "/").toLowerCase()));
      })();
  const primaryPool = logicPool.length ? logicPool : blocks;

  // Pick primary by TC alignment among Phase-2-filtered candidates
  let best: (typeof blocks)[0] | null = null;
  let bestAlign = { score: -1, shared: [] as string[], markersHit: 0 };
  for (const b of primaryPool.slice(0, 8)) {
    if (isUnsuitablePrimaryWithoutPathMarker(b.rel, markers)) {
      continue;
    }
    if (
      sutDomainConflict({
        tcText: tcBlob,
        primaryPath: b.rel,
        codeAliases: diskAliases,
      }).conflict
    ) {
      continue;
    }
    const align = sutTcAlignmentScore({
      tcText: tcBlob,
      primaryPath: b.rel,
      sourceExcerpt: b.body,
      codeAliases: diskAliases,
    });
    if (
      align.score > bestAlign.score ||
      (align.score === bestAlign.score && (best ? b.score > best.score : true))
    ) {
      best = b;
      bestAlign = align;
    }
  }
  // P0: prefer concrete implementation over I* when sibling in candidate pool
  if (best && isInterfaceLikePrimaryPath(best.rel)) {
    const promotedRel = promoteImplementationPrimary(
      best.rel,
      primaryPool.map((b) => b.rel)
    );
    if (promotedRel && promotedRel !== best.rel) {
      const alt = primaryPool.find((b) => b.rel === promotedRel);
      if (alt) {
        best = alt;
        bestAlign = sutTcAlignmentScore({
          tcText: tcBlob,
          primaryPath: alt.rel,
          sourceExcerpt: alt.body,
          codeAliases: diskAliases,
        });
      }
    }
  }

  const secondPathScore = primaryPool.find((b) => b.rel !== best?.rel)?.score ?? 0;
  if (
    !best ||
    !acceptResolved(
      bestAlign,
      best.score,
      secondPathScore,
      best.rel,
      markers,
      tcBlob,
      diskAliases
    )
  ) {
    return {
      alignmentScore: bestAlign.score,
      sharedTokens: bestAlign.shared,
      candidates: candidateRels.slice(0, 5),
    };
  }

  // Phase 4: related = Interface/DTO/enum family (not next ranked FE files)
  const allRels = candidates.map((abs) =>
    path.relative(root, abs).replace(/\\/g, "/")
  );
  const featureTokens = [
    ...markers.codes,
    ...layers.requirement,
    ...layers.module,
    ...layers.title,
  ];
  const relatedRels = expandUnitRelatedPaths({
    entryPathRel: best.rel,
    allPaths: allRels,
    featureTokens,
    maxRelated: opts.maxFiles ?? UNIT_GEN_LIMITS.maxRelatedFiles,
  });

  const relatedBlocks: string[] = [];
  for (const rel of relatedRels) {
    const abs = path.join(root, rel);
    try {
      let body = await fs.readFile(abs, "utf8");
      if (body.length > maxChars) body = body.slice(0, maxChars) + "\n/* …truncated… */";
      relatedBlocks.push(`### ${rel}\n\`\`\`\n${body}\n\`\`\``);
    } catch {
      /* skip unreadable */
    }
  }
  const related = relatedBlocks.join("\n\n");

  return {
    primaryPath: best.rel,
    source: best.body,
    related: related || undefined,
    alignmentScore: bestAlign.score,
    sharedTokens: bestAlign.shared,
    candidates: candidateRels.slice(0, 5),
  };
}

/** True when packet primary is aligned enough with TC; else prefer disk re-resolve. */
export function isPacketSutAligned(
  tcText: string,
  primaryPath: string,
  source: string,
  codeAliases?: CodeAliasMap | null
): boolean {
  return isPacketSutAcceptable({
    tcText,
    primaryPath,
    sourceExcerpt: source,
    codeAliases,
  });
}

/**
 * Accept disk re-resolve only inside marker/packet family + optional op-token hit.
 * Portable fail-closed — not full allowDiskReresolve.
 */
export function acceptScopedFamilyPrimary(opts: {
  candidatePath: string;
  familyAnchors: string[];
  opTokens?: string[] | null;
}): boolean {
  const cand = (opts.candidatePath || "").replace(/\\/g, "/");
  if (!cand || isNonProductionUnitPath(cand)) return false;
  const anchors = (opts.familyAnchors || [])
    .map((p) => p.replace(/\\/g, "/"))
    .filter(Boolean);
  const op = (opts.opTokens || []).filter((t) => String(t || "").trim().length >= 4);
  const opOk = !op.length || !pathContradictsOpPreferTokens(cand, op);

  if (!anchors.length) return opOk;

  const weakKey =
    /^(create|update|delete|assign|attach|link|filter|handler|command|query|service|request|response|dto)$/i;
  const strongKeys = (pathRel: string) =>
    entryFeatureKeys(pathRel).filter((k) => k.length >= 4 && !weakKey.test(k));

  const candKeys = new Set(strongKeys(cand));
  for (const a of anchors) {
    const aKeys = strongKeys(a);
    if (aKeys.some((k) => candKeys.has(k))) {
      return opOk;
    }
    const aParts = a.split("/").filter(Boolean);
    const cParts = cand.split("/").filter(Boolean);
    for (let i = 0; i < Math.min(aParts.length, cParts.length) - 1; i++) {
      const seg = aParts[i]!;
      if (
        seg.length >= 4 &&
        !/^(src|app|application|commands|queries|handlers|services|domain|infrastructure)$/i.test(
          seg
        ) &&
        cParts.some((p) => p.toLowerCase() === seg.toLowerCase())
      ) {
        return opOk;
      }
    }
  }
  return false;
}

/**
 * One-shot scoped re-resolve (module/family lock) — used when packet/marker fail
 * FEATURE_GAP / SUT_MISMATCH without enabling global allowDiskReresolve.
 */
export async function scopedFamilyReresolveFromDisk(
  root: string,
  opts: {
    title?: string;
    module?: string;
    testCaseId?: string;
    testData?: string;
    tcMd?: string;
    familyAnchors?: string[];
    codeAliases?: CodeAliasMap | null;
  }
): Promise<ResolveRelatedResult> {
  const disk = await resolveRelatedSourcesFromDisk(root, {
    title: opts.title,
    module: opts.module,
    testCaseId: opts.testCaseId,
    testData: opts.testData,
    tcMd: opts.tcMd,
    codeAliases: opts.codeAliases,
  });
  if (!disk.primaryPath || !disk.source) return { candidates: disk.candidates };

  const blob = [opts.tcMd, opts.title, opts.module].filter(Boolean).join("\n");
  const intent = extractUnitIntent({
    title: opts.title,
    module: opts.module,
    testData: opts.testData,
  });
  const opTokens = extractOpPreferTokens(intent, blob);
  const anchors = opts.familyAnchors || [];

  const tryAccept = (rel: string) =>
    acceptScopedFamilyPrimary({
      candidatePath: rel,
      familyAnchors: anchors,
      opTokens,
    });

  if (tryAccept(disk.primaryPath)) {
    return disk;
  }

  for (const rel of disk.candidates || []) {
    if (!tryAccept(rel)) continue;
    try {
      const abs = path.join(root, rel);
      let body = await fs.readFile(abs, "utf8");
      const maxChars = UNIT_GEN_LIMITS.maxExcerptChars;
      if (body.length > maxChars) body = body.slice(0, maxChars) + "\n/* …truncated… */";
      return {
        ...disk,
        primaryPath: rel,
        source: body,
      };
    } catch {
      /* next */
    }
  }
  return { candidates: disk.candidates };
}
