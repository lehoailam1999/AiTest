/**
 * Phase 1 — Unit Implementation Planner.
 * Maps Approved TC (+ optional MD) → entry SUT + multi-layer dependency closure.
 * Fail-closed: no inventing entry when alignment/markers insufficient.
 */
import {
  UNIT_GEN_LIMITS,
  UNIT_RANK_POLICY,
  extractTcSourceMarkers,
  isInterfaceLikePrimaryPath,
  isSutAlignedEnough,
  isWeakUnitClientPath,
  pathsMatchMarker,
  promoteImplementationPrimary,
  sutTcAlignmentScore,
  sutDomainConflict,
  type CodeAliasMap,
} from "@aitest/ide-protocol";
import type { CodeIndexSnapshot } from "../codeIndex/types";
import { listDependencies, lookupSymbol } from "../codeIndex/lookup";
import { resolveImportSpecifier } from "../codeIndex/buildDependencyGraph";
import {
  isExcludedFromUnitRetrieve,
  isUnsuitableUnitPrimary,
  unitPathBonus,
} from "../retrieval/rankScore";
import { retrieveUnitSources } from "../retrieval/unitRetriever";
import type {
  PlannerTestCaseInput,
  TestPlan,
  UnitImplementationPlan,
  UnitPlanEntry,
  UnitPlanLayer,
  UnitPlanLayerKind,
} from "./types";

export type BuildUnitImplementationPlanInput = {
  tc: PlannerTestCaseInput;
  /** Approved TC markdown body when available */
  tcMd?: string | null;
  intent: TestPlan;
  snapshot: CodeIndexSnapshot;
  /** Read production excerpts for alignment (index has no bodies). */
  readFile?: (pathRel: string) => Promise<string | null>;
  /** Optional framework override from UI / profile */
  frameworkHint?: string | null;
  maxLayers?: number;
  /** Project VI→code aliases for domain conflict checks */
  codeAliases?: CodeAliasMap | null;
};

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function tcBlob(tc: PlannerTestCaseInput, tcMd?: string | null): string {
  return [
    tcMd,
    tc.title,
    tc.module,
    tc.testData,
    tc.steps,
    tc.expectedResult,
    tc.precondition,
    tc.testCaseId,
  ]
    .filter(Boolean)
    .join("\n");
}

function detectLayer(pathRel: string): UnitPlanLayerKind {
  const p = norm(pathRel).toLowerCase();
  if (/handler/.test(p)) return "handler";
  if (/controller/.test(p)) return "controller";
  if (/usecase|use-case|application/.test(p)) return "usecase";
  if (/service/.test(p)) return "service";
  return "other";
}

/** Weak FE / thin HTTP clients — only accept with strong markers/alignment (Phase 2 SoT). */
export function isWeakClientAppAdmin(pathRel: string): boolean {
  return isWeakUnitClientPath(norm(pathRel));
}

function guessFramework(
  pathRel: string | undefined,
  intent: TestPlan,
  hint?: string | null
): string | undefined {
  if (hint?.trim()) return hint.trim();
  if (intent.hints.framework) return intent.hints.framework;
  const ext = (pathRel || "").split(".").pop()?.toLowerCase();
  if (ext === "cs") return "xunit";
  if (ext === "py") return "pytest";
  if (ext === "java" || ext === "kt") return "junit";
  if (ext === "ts" || ext === "tsx" || ext === "js") return "jest";
  return undefined;
}

function resolvePathInIndex(
  snapshot: CodeIndexSnapshot,
  want: string
): string | null {
  const w = norm(want);
  if (!w) return null;
  const keys = Object.keys(snapshot.files);
  const exact = keys.find((k) => norm(k).toLowerCase() === w.toLowerCase());
  if (exact) return exact;
  // Prefer exact basename / pathsMatchMarker — never IFoo.cs for marker Foo.cs
  const matched = keys.filter((k) => pathsMatchMarker(k, w));
  if (!matched.length) return null;
  // Prefer concrete implementation when both IFoo and Foo match (shouldn't for exact helpers)
  const promoted = promoteImplementationPrimary(matched[0], matched);
  return promoted || matched[0];
}

function methodHintsFromSymbols(
  snapshot: CodeIndexSnapshot,
  pathRel: string,
  keywords: string[]
): string[] {
  const syms = snapshot.symbolsByFile[pathRel] || [];
  const methods = syms.filter((s) => s.kind === "method" || s.kind === "function");
  const kw = keywords.map((k) => k.toLowerCase());
  const scored = methods
    .map((m) => {
      const n = m.name.toLowerCase();
      let s = 0;
      for (const k of kw) {
        if (k.length >= 3 && n.includes(k)) s += 2;
      }
      return { name: m.name, s };
    })
    .filter((x) => x.s > 0)
    .sort((a, b) => b.s - a.s);
  const names = scored.map((x) => x.name);
  if (names.length) return names.slice(0, 6);
  return methods.slice(0, 4).map((m) => m.name);
}

function extractMocks(
  snapshot: CodeIndexSnapshot,
  entryPath: string
): string[] {
  const edges = snapshot.importsByFile[entryPath] || [];
  const out = new Set<string>();
  for (const e of edges) {
    for (const n of e.names || []) {
      if (
        /^I[A-Z]/.test(n) ||
        /Repository|Client|Gateway|Port|Store|Factory|Provider$/i.test(n)
      ) {
        out.add(n);
      }
    }
  }
  return [...out].slice(0, 12);
}

function findExistingTests(
  snapshot: CodeIndexSnapshot,
  entryPath: string,
  symbol?: string
): string[] {
  const stem = (entryPath.split("/").pop() || "")
    .replace(/\.[^.]+$/, "")
    .toLowerCase();
  const sym = (symbol || "").toLowerCase();
  const hits: string[] = [];
  for (const p of Object.keys(snapshot.files)) {
    const low = p.toLowerCase();
    const isTestPath =
      /\.(test|spec)\./i.test(low) ||
      /\/unittest\//i.test(low) ||
      /\/__tests__\//i.test(low) ||
      /tests?\.cs$/i.test(low);
    if (!isTestPath) continue;
    const base = (p.split("/").pop() || "").toLowerCase();
    if (
      (stem.length >= 3 && base.includes(stem)) ||
      (sym.length >= 3 && base.includes(sym))
    ) {
      hits.push(p);
    }
  }
  return hits.slice(0, 6);
}

async function excerptFor(
  pathRel: string,
  readFile?: (pathRel: string) => Promise<string | null>
): Promise<string> {
  if (!readFile) return "";
  try {
    const body = await readFile(pathRel);
    return (body || "").slice(0, UNIT_GEN_LIMITS.maxExcerptChars);
  } catch {
    return "";
  }
}

function buildDepLayers(
  snapshot: CodeIndexSnapshot,
  entryPath: string,
  maxDeps: number
): UnitPlanLayer[] {
  const known = new Set(Object.keys(snapshot.files).map(norm));
  const layers: UnitPlanLayer[] = [];
  const seen = new Set<string>([norm(entryPath)]);
  type Q = { path: string; depth: number };
  const q: Q[] = [{ path: entryPath, depth: 0 }];

  while (q.length && layers.length < maxDeps) {
    const cur = q.shift()!;
    if (cur.depth >= 2) continue;
    const specs = listDependencies(snapshot, cur.path);
    const ranked = specs
      .map((spec) => {
        // Already a pathRel (C# graph resolve) or relative/type → resolveImportSpecifier
        const asPath = known.has(norm(spec)) ? norm(spec) : null;
        const resolved =
          asPath ||
          resolveImportSpecifier(cur.path, spec, known, {
            symbolIndex: snapshot.symbolIndex,
          });
        return { spec, resolved };
      })
      .filter((x) => x.resolved && !seen.has(norm(x.resolved!)))
      .sort((a, b) => {
        const pa = a.resolved || "";
        const pb = b.resolved || "";
        const score = (p: string) => {
          let s = 0;
          if (/\/(interfaces?|ports?|contracts?)\//i.test(p)) s += 5;
          if (/I[A-Z]\w+/.test(p) || /Repository|Client|Gateway/i.test(p)) s += 4;
          if (isExcludedFromUnitRetrieve(p) || isUnsuitableUnitPrimary(p)) s -= 10;
          s += Math.max(0, unitPathBonus(p));
          return s;
        };
        return score(pb) - score(pa);
      });

    for (const { resolved, spec } of ranked) {
      if (!resolved || layers.length >= maxDeps) break;
      const r = norm(resolved);
      if (seen.has(r)) continue;
      if (isExcludedFromUnitRetrieve(r)) continue;
      seen.add(r);
      const role =
        /\/(interfaces?|ports?|contracts?)\//i.test(r) ||
        /Repository|Client|Gateway|Port/i.test(r)
          ? ("contract" as const)
          : ("dependency" as const);
      layers.push({
        pathRel: resolved,
        role,
        reason: `dep depth=${cur.depth + 1} via ${spec}`,
      });
      q.push({ path: resolved, depth: cur.depth + 1 });
    }
  }
  return layers;
}

async function scoreCandidate(
  blob: string,
  pathRel: string,
  readFile?: (pathRel: string) => Promise<string | null>
): Promise<{ score: number; markersHit: number; shared: string[] }> {
  const sourceExcerpt = await excerptFor(pathRel, readFile);
  const align = sutTcAlignmentScore({
    tcText: blob,
    primaryPath: pathRel,
    sourceExcerpt: sourceExcerpt || pathRel,
  });
  return {
    score: align.score,
    markersHit: align.markersHit,
    shared: align.shared,
  };
}

/**
 * Build Unit Implementation Plan (fail-closed when entry cannot be grounded).
 */
export async function buildUnitImplementationPlan(
  input: BuildUnitImplementationPlanInput
): Promise<UnitImplementationPlan> {
  const notes: string[] = [];
  const blob = tcBlob(input.tc, input.tcMd);
  const markers = extractTcSourceMarkers(blob);
  const maxFiles = input.maxLayers ?? UNIT_GEN_LIMITS.maxRelatedFiles;
  const maxDeps = Math.max(0, maxFiles - 1);

  const empty = (
    status: UnitImplementationPlan["status"],
    extraNotes: string[],
    confidence = 0
  ): UnitImplementationPlan => ({
    entry: null,
    layers: [],
    mocks: [],
    existingTests: [],
    framework: guessFramework(undefined, input.intent, input.frameworkHint),
    confidence,
    markers,
    status,
    notes: [...notes, ...extraNotes],
    intent: input.intent,
  });

  let entryPath: string | null = null;
  let entrySymbol: string | undefined;
  let entryReason = "";

  // 1) Marker paths
  for (const p of markers.paths) {
    const hit = resolvePathInIndex(input.snapshot, p);
    if (hit) {
      entryPath = hit;
      entryReason = `marker path:${p}`;
      break;
    }
    notes.push(`marker path not in index: ${p}`);
  }

  // 2) Marker codes → symbol lookup
  if (!entryPath) {
    for (const code of markers.codes) {
      const hits = lookupSymbol(input.snapshot, code, { limit: 8 });
      const prefer = hits.find(
        (h) =>
          !isExcludedFromUnitRetrieve(h.pathRel) &&
          !isUnsuitableUnitPrimary(h.pathRel) &&
          !isInterfaceLikePrimaryPath(h.pathRel)
      );
      const pick =
        prefer ||
        hits.find(
          (h) =>
            !isExcludedFromUnitRetrieve(h.pathRel) &&
            !isUnsuitableUnitPrimary(h.pathRel)
        ) ||
        hits[0];
      if (pick) {
        entryPath = pick.pathRel;
        entrySymbol = pick.name;
        entryReason = `marker code:${code}`;
        break;
      }
    }
  }

  // 3) Retrieve candidates when no marker hit
  if (!entryPath) {
    const retrieved = retrieveUnitSources(input.snapshot, input.intent, {
      topK: 12,
    });
    notes.push(...retrieved.notes);
    const candidates = retrieved.files
      .map((f) => f.pathRel)
      .filter((p) => !isExcludedFromUnitRetrieve(p) && !isUnsuitableUnitPrimary(p));

    let best: {
      path: string;
      score: number;
      markersHit: number;
    } | null = null;

    for (const pathRel of candidates.slice(0, 8)) {
      if (isWeakClientAppAdmin(pathRel) && markers.paths.length === 0 && markers.codes.length === 0) {
        notes.push(`skip weak ClientApp admin without markers: ${pathRel}`);
        continue;
      }
      if (
        sutDomainConflict({
          tcText: blob,
          primaryPath: pathRel,
          codeAliases: input.codeAliases,
        }).conflict
      ) {
        notes.push(`skip domain conflict: ${pathRel}`);
        continue;
      }
      const scored = await scoreCandidate(blob, pathRel, input.readFile);
      if (
        !best ||
        scored.score > best.score ||
        (scored.score === best.score &&
          unitPathBonus(pathRel) > unitPathBonus(best.path))
      ) {
        best = {
          path: pathRel,
          score: scored.score,
          markersHit: scored.markersHit,
        };
      }
    }

    if (best && isSutAlignedEnough(best)) {
      entryPath = best.path;
      entryReason = `retrieve+align score=${best.score}`;
    } else if (best) {
      notes.push(
        `best candidate ${best.path} alignment=${best.score} below threshold`
      );
    }
  }

  if (!entryPath) {
    return empty(
      markers.paths.length || markers.codes.length
        ? "unresolved"
        : "needs_marker",
      [
        "No grounded Unit entry — add path:/code: to Test Data, Approve, then Gen.",
      ]
    );
  }

  // P0: promote I*Foo → Foo when sibling implementation exists in index
  const indexPaths = Object.keys(input.snapshot.files);
  if (isInterfaceLikePrimaryPath(entryPath)) {
    const promoted = promoteImplementationPrimary(entryPath, indexPaths);
    if (promoted && promoted !== entryPath) {
      notes.push(`promoted interface entry ${entryPath} → ${promoted}`);
      entryPath = promoted;
      entryReason = entryReason
        ? `${entryReason}; promoted-impl`
        : "promoted-impl";
    }
  }

  // Final alignment gate (even for marker paths — wrong marker still fails)
  const finalAlign = await scoreCandidate(blob, entryPath, input.readFile);
  if (!isSutAlignedEnough(finalAlign) && markers.paths.length === 0 && markers.codes.length === 0) {
    return empty("needs_marker", [
      `Entry ${entryPath} not aligned (score=${finalAlign.score})`,
      "Add path:/code: markers for this TC.",
    ]);
  }
  // Marker path: accept even if token overlap is low (explicit user pointer),
  // unless weak admin FE and marker is only a vague code without path.
  if (
    !isSutAlignedEnough(finalAlign) &&
    isWeakClientAppAdmin(entryPath) &&
    markers.paths.length === 0
  ) {
    return empty("needs_marker", [
      `Refusing weak ClientApp admin entry ${entryPath} without path: marker`,
    ]);
  }

  if (!entrySymbol && markers.codes.length) {
    entrySymbol = markers.codes[0];
  }
  if (!entrySymbol) {
    const classes = (input.snapshot.symbolsByFile[entryPath] || []).filter(
      (s) => s.kind === "class" || s.kind === "interface"
    );
    entrySymbol = classes[0]?.name;
  }

  const entry: UnitPlanEntry = {
    pathRel: entryPath,
    symbol: entrySymbol,
    methodHints: methodHintsFromSymbols(
      input.snapshot,
      entryPath,
      input.intent.keywords
    ),
    layer: detectLayer(entryPath),
  };

  const depLayers = buildDepLayers(input.snapshot, entryPath, maxDeps);
  const layers: UnitPlanLayer[] = [
    { pathRel: entryPath, role: "entry", reason: entryReason },
    ...depLayers,
  ];

  const mocks = extractMocks(input.snapshot, entryPath);
  const existingTests = findExistingTests(
    input.snapshot,
    entryPath,
    entrySymbol
  );
  const framework = guessFramework(
    entryPath,
    input.intent,
    input.frameworkHint
  );

  const confidence = Math.min(
    1,
    0.35 +
      (markers.paths.length || markers.codes.length ? 0.4 : 0) +
      Math.min(0.25, finalAlign.score / 20)
  );

  notes.push(
    `entry=${entryPath}`,
    `layers=${layers.length}`,
    `mocks=${mocks.length}`,
    entryReason
  );

  return {
    entry,
    layers,
    mocks,
    existingTests,
    framework,
    confidence,
    markers,
    status: "ready",
    notes,
    intent: input.intent,
  };
}
