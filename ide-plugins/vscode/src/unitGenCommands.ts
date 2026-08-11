/**
 * Phase B.1 — Extension Unit Gen orchestrator (protocol handler).
 * Gen Owner = UnitGenEngine (default: CursorAgentCliEngine).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  IdeNotifications,
  UNIT_GEN_LIMITS,
  decideUnitSutGate,
  expandUnitRelatedPaths,
  extractTcSourceMarkers,
  hasUnitSourceMarkers,
  isBlockedUnitPrimaryPath,
  isInterfaceLikePrimaryPath,
  pathsMatchMarker,
  primaryMatchesMarkers,
  promoteImplementationPrimary,
  type CodegenFileDto,
  type CodegenGenerateUnitBatchParams,
  type CodegenGeneratedFileMeta,
  type CodegenPerTcResult,
  type CodegenProgressNotification,
  type CodegenResultCallback,
  type CodegenUnitItem,
  type UnitDomainGuardRule,
} from "@aitest/ide-protocol";
import { workspaceRoot } from "./semanticContext";
import { EMBEDDED_UNIT_CONVENTIONS } from "./unitGenConventions";
import { excerptFromContextPacket, toRepoRelativePath } from "./unitGenParse";
import {
  isNonProductionUnitPath,
  isPacketSutAligned,
  resolveRelatedSourcesFromDisk,
  scopedFamilyReresolveFromDisk,
} from "./unitGenRelatedSources";
import { getUnitGenEngine, writeUnitGenDebugDump } from "./cursorAgentCliEngine";

export { stripCodeFences, excerptFromContextPacket, toRepoRelativePath } from "./unitGenParse";
export {
  getUnitGenEngine,
  registerUnitGenEngine,
  CursorAgentCliEngine,
} from "./cursorAgentCliEngine";
export type { UnitGenEngine, UnitGenEngineCtx, UnitGenEngineResult } from "./unitGenEngine";

type NotifyFn = (method: string, params: unknown) => void;

const cancelledIds = new Set<string>();

export function markUnitGenCancelled(commandId: string): void {
  cancelledIds.add(commandId);
}

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readSourceExcerpt(
  root: string,
  rel: string,
  maxChars = UNIT_GEN_LIMITS.maxExcerptChars
): Promise<string | null> {
  try {
    const abs = path.join(root, rel);
    let body = await fs.readFile(abs, "utf8");
    if (body.length > maxChars) body = body.slice(0, maxChars) + "\n/* …truncated… */";
    return body;
  } catch {
    return null;
  }
}

function formatRelatedBlocks(
  root: string,
  rels: string[],
  maxCharsEach: number
): Promise<string> {
  return (async () => {
    const blocks: string[] = [];
    for (const rel of rels) {
      const body = await readSourceExcerpt(root, rel, maxCharsEach);
      if (body) blocks.push(`### ${rel}\n\`\`\`\n${body}\n\`\`\``);
    }
    return blocks.join("\n\n");
  })();
}

function notifyProgress(notify: NotifyFn, progress: CodegenProgressNotification): void {
  notify(IdeNotifications.codegenProgress, progress);
}

function notifyResult(notify: NotifyFn, result: CodegenResultCallback): void {
  notify(IdeNotifications.codegenResult, result);
}

function canSoftBypassGateForGroundedSource(opts: {
  code: string;
  primaryPath?: string;
  source?: string;
  markers: { paths: string[]; codes: string[] };
}): boolean {
  if (!/FEATURE_GAP|SUT_MISMATCH/i.test(opts.code || "")) return false;
  if (!opts.primaryPath || !opts.source?.trim()) return false;
  // Logic-layer SUT with concrete excerpt should be enough to generate.
  if (isNonProductionUnitPath(opts.primaryPath)) return false;
  if (isBlockedUnitPrimaryPath(opts.primaryPath, opts.markers)) return false;
  // If markers exist, prefer consistency; if markers absent, still allow grounded generate.
  if (
    (opts.markers.paths.length > 0 || opts.markers.codes.length > 0) &&
    !primaryMatchesMarkers(opts.primaryPath, opts.markers)
  ) {
    return false;
  }
  return true;
}

async function readTextIfExists(abs: string, maxChars = UNIT_GEN_LIMITS.maxConventionsChars): Promise<string> {
  try {
    const raw = await fs.readFile(abs, "utf8");
    return raw.length > maxChars ? raw.slice(0, maxChars) + "\n/* …truncated… */" : raw;
  } catch {
    return "";
  }
}

/** Optional unit gate knobs from `.ai-test/project.profile.json`. */
async function loadUnitProfileGate(root: string): Promise<{
  domainGuards: UnitDomainGuardRule[];
  requireMarkers: boolean | null;
  unitScope: "backend" | "frontend" | "any";
  minAlignment: number;
  genMode: "strict_spec" | "always_generate";
  /** When false (default), Extension never fuzzy-resolves SUT from disk. */
  allowDiskReresolve: boolean;
}> {
  try {
    const raw = await fs.readFile(path.join(root, ".ai-test", "project.profile.json"), "utf8");
    const j = JSON.parse(raw) as {
      unit?: {
        domainGuards?: UnitDomainGuardRule[];
        requireMarkers?: boolean | string[];
        scope?: "backend" | "frontend" | "any";
        minAlignment?: number;
        genMode?: "strict_spec" | "always_generate";
        allowDiskReresolve?: boolean;
      };
    };
    const unit = j?.unit;
    const domainGuards = Array.isArray(unit?.domainGuards) ? unit!.domainGuards! : [];
    // Phase 5: default require path:+code: unless profile sets requireMarkers: false
    let requireMarkers: boolean | null = true;
    if (unit?.requireMarkers === false) requireMarkers = false;
    else if (unit?.requireMarkers === true) requireMarkers = true;
    else if (Array.isArray(unit?.requireMarkers) && unit!.requireMarkers!.length)
      requireMarkers = true;
    const scopeRaw = (unit?.scope || "backend").toLowerCase();
    const unitScope: "backend" | "frontend" | "any" =
      scopeRaw === "frontend" || scopeRaw === "any" || scopeRaw === "backend"
        ? scopeRaw
        : "backend";
    const minAlignment =
      typeof unit?.minAlignment === "number" && Number.isFinite(unit.minAlignment)
        ? unit.minAlignment
        : 50;
    const genMode = unit?.genMode === "always_generate" ? "always_generate" : "strict_spec";
    const allowDiskReresolve = unit?.allowDiskReresolve === true;
    return {
      domainGuards,
      requireMarkers,
      unitScope,
      minAlignment,
      genMode,
      allowDiskReresolve,
    };
  } catch {
    return {
      domainGuards: [],
      requireMarkers: true,
      unitScope: "backend",
      minAlignment: 50,
      genMode: "strict_spec",
      allowDiskReresolve: false,
    };
  }
}

function withGapFallbackInstruction(tcMd: string, detail: string): string {
  const note = [
    "## AITest Fallback Mode (Always Generate)",
    "- Output fallback tests only; never fake pass for missing behavior.",
    "- Use `test.skip` / trait-style marker for missing behavior.",
    "- Add clear TODO with exact missing backend rule/signal.",
    "- Prefer closest existing branch assertion from current source.",
    `- Fallback reason: ${detail}`,
  ].join("\n");
  return `${tcMd}\n\n${note}`.trim();
}

function annotateGapFallbackCode(code: string, testCaseId: string, reason: string): string {
  const trimmed = (code || "").trim();
  if (!trimmed) return code;
  const header = [
    "// AITEST_FALLBACK_GAP",
    `// fallbackFrom: ${testCaseId}`,
    `// reason: ${reason}`,
    "// mode: always_generate",
  ].join("\n");
  if (/^\s*using\s+/m.test(trimmed) || /\.cs$/i.test(testCaseId)) {
    return `${header}\n${trimmed}`;
  }
  return `${header}\n${trimmed}`;
}

function withSoftBypassDiagnosticInstruction(
  tcMd: string,
  input: { code: string; reason: string; primaryPath?: string }
): string {
  const note = [
    "## AITest Source Diagnostic",
    "- Generation proceeded with soft-bypass (grounded TC + source).",
    `- Gate code: ${input.code || "UNKNOWN"}`,
    `- Gate reason: ${input.reason || "n/a"}`,
    `- SUT: ${input.primaryPath || "unknown-sut"}`,
    "- If verification fails, treat this as source-behavior gap and fix SUT/rules in source.",
  ].join("\n");
  return `${tcMd}\n\n${note}`.trim();
}

/** Walk `.ai-test/test-cases/**` for `{testCaseId}.md` (business code or UUID). */
export async function findApprovedTcMarkdown(
  root: string,
  testCaseId: string
): Promise<{ path: string; content: string } | null> {
  const code = (testCaseId || "").trim();
  if (!code || !root) return null;
  const base = path.join(root, ".ai-test", "test-cases");
  const want = `${code}.md`.toLowerCase();
  async function walk(dir: string): Promise<{ path: string; content: string } | null> {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return null;
    }
    for (const ent of entries) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        const hit = await walk(abs);
        if (hit) return hit;
        continue;
      }
      if (ent.isFile() && ent.name.toLowerCase() === want) {
        const content = await fs.readFile(abs, "utf8");
        const rel = normRel(path.relative(root, abs));
        return { path: rel, content };
      }
    }
    return null;
  }
  return walk(base);
}

async function genOneItem(
  root: string,
  item: CodegenUnitItem,
  projectRules: string,
  conventions: string,
  commandId: string,
  notify: NotifyFn,
  index: number,
  total: number,
  paramsCodeAliases: Record<string, string[]> | null | undefined,
  runPrompt?: (
    prompt: string,
    timeoutMs: number,
    onLine?: (s: string) => void
  ) => Promise<string>
): Promise<{
  file?: CodegenFileDto;
  meta?: CodegenGeneratedFileMeta;
  perTc: CodegenPerTcResult;
  truncated?: boolean;
}> {
  let suggested =
    (item.suggestedPath || "").trim().replace(/\\/g, "/") ||
    `AItest/UnitTest/${(item.module || "General").replace(/[\\/]+/g, "-")}/${item.testCaseId}.test.ts`;

  notifyProgress(notify, {
    commandId,
    phase: "generating",
    current: index,
    total,
    message: `Unit Gen ${item.testCaseId}…`,
  });

  if (cancelledIds.has(commandId)) {
    return {
      perTc: { testCaseId: item.testCaseId, genOk: false, error: "CANCELLED" },
    };
  }

  const md = await findApprovedTcMarkdown(root, item.testCaseId);
  if (!md?.content?.trim()) {
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `Missing Approved TC markdown for «${item.testCaseId}» under .ai-test/test-cases/. ` +
          `Duyệt TC trong AITest (Approve ghi MD) trước khi Gen Unit.`,
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "Missing approved TC markdown",
      },
    };
  }

  // Phase 5 — fail-closed before disk resolve / CLI when path:+code: missing
  const markerBlob = [md.content, item.testData || ""].join("\n");
  if (!hasUnitSourceMarkers(markerBlob)) {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: "FAIL_NEEDS_MARKER — missing path:/code: before Gen",
      domainGuard: "skip",
      resolvedSut: "unresolved",
      candidatesTop3: [],
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `FAIL_NEEDS_MARKER — «${item.testCaseId}» chưa có path: + code:. ` +
          `Approve lại hoặc thêm marker thủ công, rồi Gen.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "FAIL_NEEDS_MARKER",
      },
    };
  }

  const fromPacket = excerptFromContextPacket(item.contextPacket);
  let primaryPath = fromPacket.primaryPath
    ? toRepoRelativePath(root, fromPacket.primaryPath)
    : undefined;
  let source = fromPacket.source;
  let related = fromPacket.related;
  let primarySource: "marker" | "packet" | "disk" | undefined = primaryPath
    ? "packet"
    : undefined;
  let candidatesTop3: Array<{ path: string; score?: number; reason?: string }> = [];
  let lastAlignScore: number | undefined;

  const tcBlob = [
    md.content,
    item.title,
    item.module,
    item.testData,
    item.steps,
    item.expectedOutcome,
  ]
    .filter(Boolean)
    .join("\n");

  const markers = extractTcSourceMarkers(tcBlob);
  const profileGate = await loadUnitProfileGate(root);
  const allowDisk = profileGate.allowDiskReresolve;

  // Exact marker path reads only (not fuzzy rank) — orchestration trusts Desktop packet.
  let markerResolved = false;
  for (const mp of markers.paths) {
    const want = toRepoRelativePath(root, mp);
    if (!want || isNonProductionUnitPath(want)) continue;
    const body = await readSourceExcerpt(root, want);
    if (!body) continue;
    primaryPath = want;
    source = body;
    primarySource = "marker";
    markerResolved = true;
    break;
  }

  // Reject non-production / Phase-2-denied packet primary (unless marker points there)
  if (
    !markerResolved &&
    primaryPath &&
    (isNonProductionUnitPath(primaryPath) ||
      isBlockedUnitPrimaryPath(primaryPath, markers))
  ) {
    primaryPath = undefined;
    source = undefined;
    primarySource = undefined;
  }

  // Promote I* only within marker/packet/related pool — never invent disk siblings.
  const promotePool = [
    primaryPath || "",
    ...markers.paths,
    ...markers.related,
  ]
    .map((p) => toRepoRelativePath(root, p))
    .filter(Boolean);
  if (primaryPath && isInterfaceLikePrimaryPath(primaryPath)) {
    const promoted = promoteImplementationPrimary(primaryPath, promotePool);
    if (promoted && promoted !== primaryPath) {
      const body = await readSourceExcerpt(root, promoted);
      if (body) {
        primaryPath = promoted;
        source = body;
        primarySource = markerResolved ? "marker" : "packet";
      }
    }
  }

  const packetMatchesMarkers =
    Boolean(primaryPath?.trim() && source?.trim()) &&
    (markers.paths.length + markers.codes.length === 0 ||
      primaryMatchesMarkers(primaryPath || "", markers)) &&
    isPacketSutAligned(tcBlob, primaryPath || "", source || "", paramsCodeAliases);

  const packetOk =
    markerResolved ||
    (packetMatchesMarkers &&
      !(
        primaryPath &&
        isInterfaceLikePrimaryPath(primaryPath) &&
        !markers.paths.some((p) => pathsMatchMarker(primaryPath!, p))
      ));

  // Optional legacy disk fuzzy — off by default (Desktop owns resolve).
  // Scoped family recovery: one shot when packet fails (not full allowDiskReresolve).
  let disk: Awaited<ReturnType<typeof resolveRelatedSourcesFromDisk>> | null = null;
  let scopedRecoveryUsed = false;
  const familyAnchors = [
    ...markers.paths,
    fromPacket.primaryPath || "",
    primaryPath || "",
  ]
    .map((p) => toRepoRelativePath(root, p))
    .filter(Boolean);

  if (!packetOk && allowDisk) {
    disk = await resolveRelatedSourcesFromDisk(root, {
      title: item.title,
      module: item.module,
      testCaseId: item.testCaseId,
      testData: [item.testData, item.steps, item.expectedOutcome]
        .filter(Boolean)
        .join("\n"),
      tcMd: md.content,
      maxFiles: UNIT_GEN_LIMITS.maxRelatedFiles,
      maxCharsEach: UNIT_GEN_LIMITS.maxExcerptChars,
      codeAliases: paramsCodeAliases,
    });
    lastAlignScore = disk.alignmentScore;
    if (disk.primaryPath && disk.source) {
      const rel = toRepoRelativePath(root, disk.primaryPath);
      if (isNonProductionUnitPath(rel)) {
        const debugRel = await writeUnitGenDebugDump({
          workspaceRoot: root,
          item,
          tcMdPath: md.path,
          suggestedPath: suggested,
          gateDecision: "block",
          blockedReason: `Non-production SUT «${rel}»`,
          domainGuard: "skip",
          resolvedSut: rel,
          alignmentScore: disk.alignmentScore,
          candidatesTop3: (disk.candidates || []).slice(0, 3).map((p) => ({
            path: p,
            score: disk.alignmentScore,
            reason: "candidate",
          })),
        });
        return {
          perTc: {
            testCaseId: item.testCaseId,
            genOk: false,
            error:
              `SUT «${rel}» không phải production logic (migration/test). ` +
              `Thêm path:/code: trỏ handler/service thật, Approve lại, rồi Gen.` +
              (debugRel ? ` Debug: ${debugRel}` : ""),
          },
          meta: {
            path: suggested,
            status: "ERROR",
            error: "Non-production SUT path",
          },
        };
      }
      primaryPath = rel;
      source = disk.source;
      primarySource = "disk";
      related = disk.related || related;
    }
  } else if (!packetOk && !allowDisk) {
    disk = await scopedFamilyReresolveFromDisk(root, {
      title: item.title,
      module: item.module,
      testCaseId: item.testCaseId,
      testData: [item.testData, item.steps, item.expectedOutcome]
        .filter(Boolean)
        .join("\n"),
      tcMd: md.content,
      familyAnchors,
      codeAliases: paramsCodeAliases,
    });
    scopedRecoveryUsed = true;
    lastAlignScore = disk.alignmentScore;
    if (disk.primaryPath && disk.source) {
      primaryPath = toRepoRelativePath(root, disk.primaryPath);
      source = disk.source;
      primarySource = "disk";
      related = disk.related || related;
    }
  }

  if (!packetOk && !primaryPath?.trim()) {
    const hinted = fromPacket.primaryPath?.trim();
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      primaryPath: hinted,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason:
        "FAIL_NEEDS_MARKER — Extension verify-only; no packet/marker primary" +
        (allowDisk ? " (disk reresolve also failed)" : " (disk reresolve disabled)"),
      domainGuard: "skip",
      resolvedSut: "unresolved",
      alignmentScore: lastAlignScore ?? 0,
      candidatesTop3: [],
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `FAIL_NEEDS_MARKER — SUT unresolved cho «${item.testCaseId}»` +
          (hinted ? ` (packet=${hinted})` : "") +
          `. Desktop phải gửi packet + path:/code:; Extension không fuzzy resolve` +
          (allowDisk ? "" : " (unit.allowDiskReresolve=false)") +
          `. Approve lại, rồi Gen.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "FAIL_NEEDS_MARKER",
      },
    };
  }

  primaryPath = primaryPath ? toRepoRelativePath(root, primaryPath) : undefined;

  // Hard stop: markers present but primary still mismatches — one scoped recovery first
  if (
    (markers.paths.length > 0 || markers.codes.length > 0) &&
    primaryPath &&
    !primaryMatchesMarkers(primaryPath, markers)
  ) {
    if (!scopedRecoveryUsed) {
      const recovered = await scopedFamilyReresolveFromDisk(root, {
        title: item.title,
        module: item.module,
        testCaseId: item.testCaseId,
        testData: [item.testData, item.steps, item.expectedOutcome]
          .filter(Boolean)
          .join("\n"),
        tcMd: md.content,
        familyAnchors: [
          ...markers.paths,
          primaryPath,
          ...familyAnchors,
        ],
        codeAliases: paramsCodeAliases,
      });
      scopedRecoveryUsed = true;
      if (
        recovered.primaryPath &&
        recovered.source &&
        primaryMatchesMarkers(recovered.primaryPath, markers)
      ) {
        primaryPath = toRepoRelativePath(root, recovered.primaryPath);
        source = recovered.source;
        primarySource = "disk";
        related = recovered.related || related;
        disk = recovered;
      }
    }
  }

  if (
    (markers.paths.length > 0 || markers.codes.length > 0) &&
    primaryPath &&
    !primaryMatchesMarkers(primaryPath, markers)
  ) {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      primaryPath,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: `FAIL_SUT_MISMATCH — Primary «${primaryPath}» ≠ Test Data path:/code:`,
      domainGuard: "pass",
      resolvedSut: primaryPath,
      alignmentScore: lastAlignScore ?? 0,
      candidatesTop3: (disk?.candidates || []).slice(0, 3).map((p) => ({
        path: p,
        score: disk?.alignmentScore,
        reason: "candidate",
      })),
      relatedFiles: markers.related.slice(0, UNIT_GEN_LIMITS.maxRelatedFiles),
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `FAIL_SUT_MISMATCH — Primary «${primaryPath}» không khớp path:/code: trong Test Data. ` +
          `Không gửi CLI.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
        sourceFileName: primaryPath,
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "FAIL_SUT_MISMATCH",
      },
    };
  }

  candidatesTop3 = (disk?.candidates || [])
    .slice(0, 3)
    .map((p) => ({
      path: p,
      score: disk?.alignmentScore,
      reason:
        primaryPath && pathsMatchMarker(p, primaryPath)
          ? `resolved-${primarySource || "primary"}`
          : "candidate",
    }));
  if (!candidatesTop3.length && primaryPath) {
    candidatesTop3 = [
      {
        path: primaryPath,
        score: lastAlignScore,
        reason: `resolved-${primarySource || "packet"}`,
      },
    ];
  }

  // Related: markers + packet expand only (no disk candidate pool unless allowDisk)
  {
    const relatedRels = [
      ...markers.related.map((p) => toRepoRelativePath(root, p)),
      ...expandUnitRelatedPaths({
        entryPathRel: primaryPath || "",
        allPaths: [
          ...(disk?.candidates || []),
          ...markers.related,
          ...markers.paths,
          primaryPath || "",
        ].map((p) => toRepoRelativePath(root, p)),
        featureTokens: [...markers.codes, ...(item.module || "").split(/\s+/)],
        maxRelated: UNIT_GEN_LIMITS.maxRelatedFiles,
        preferDtoValidator: true,
      }),
    ]
      .map(normRel)
      .filter((p) => p && p !== primaryPath);
    const uniqRelated = [...new Set(relatedRels)].slice(
      0,
      UNIT_GEN_LIMITS.maxRelatedFiles
    );
    if (uniqRelated.length) {
      const merged = await formatRelatedBlocks(
        root,
        uniqRelated,
        UNIT_GEN_LIMITS.maxExcerptChars
      );
      if (merged.trim()) related = merged;
    } else if (allowDisk && disk?.related?.trim()) {
      related = disk.related;
    }
  }

  if (!source?.trim() || !primaryPath?.trim()) {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: "FAIL_NEEDS_MARKER — unresolved SUT",
      domainGuard: "skip",
      resolvedSut: "unresolved",
      alignmentScore: lastAlignScore ?? 0,
      candidatesTop3,
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `FAIL_NEEDS_MARKER — Không resolve được SUT cho «${item.testCaseId}». ` +
          `Thêm path:/code: vào Test Data, Approve lại, rồi Gen.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "FAIL_NEEDS_MARKER",
      },
    };
  }

  // Align suggestedPath stem with actual primary (not stale I* from Desktop)
  {
    const sutStem = path.basename(primaryPath).replace(/\.[^.]+$/, "");
    if (sutStem && !new RegExp(`${sutStem}Tests`, "i").test(suggested)) {
      suggested = suggested.replace(
        /([^/\\]+?)(Tests)?(_[a-f0-9]+)?(\.[^.]+)$/i,
        `${sutStem}Tests$3$4`
      );
    }
  }

  // Align suggestedPath extension with SUT stack when Desktop sent wrong ext
  const sutExt = path.extname(primaryPath).toLowerCase();
  if (sutExt === ".cs" && !/\.cs$/i.test(suggested)) {
    suggested = suggested.replace(/\.(ts|tsx|js|jsx)$/i, ".cs");
    if (!/\.cs$/i.test(suggested)) suggested = `${suggested}.cs`;
  } else if (
    (sutExt === ".ts" || sutExt === ".tsx") &&
    /\.cs$/i.test(suggested)
  ) {
    suggested = suggested.replace(/\.cs$/i, sutExt === ".tsx" ? ".tsx" : ".ts");
  }

  const { domainGuards, requireMarkers, unitScope, minAlignment } = profileGate;
  const relatedFileList = () => {
    const fromBlocks = (related || "")
      .split(/\n/)
      .map((l) => l.match(/^###\s+(.+)\s*$/)?.[1]?.trim())
      .filter((x): x is string => Boolean(x));
    return [...new Set([...markers.related.map(normRel), ...fromBlocks])].slice(
      0,
      UNIT_GEN_LIMITS.maxRelatedFiles
    );
  };
  let gapFallbackUsed = false;
  let gapFallbackReason = "";
  let softBypassUsed = false;
  let softBypassReason = "";
  let softBypassCode = "";

  let gate = decideUnitSutGate({
    tcText: tcBlob,
    primaryPath,
    sourceExcerpt: source,
    codeAliases: paramsCodeAliases,
    moduleText: [item.module, item.title, md.content.slice(0, 1500)].filter(Boolean).join("\n"),
    domainGuards,
    requireMarkers: requireMarkers !== false,
    unitScope,
    minAlignment,
  });

  if (gate.decision === "block") {
    const code = gate.code || "FAIL_NEEDS_MARKER";
    // One scoped recovery on FEATURE_GAP / SUT_MISMATCH then re-gate
    if (
      !scopedRecoveryUsed &&
      /FEATURE_GAP|SUT_MISMATCH/i.test(code) &&
      primaryPath
    ) {
      const recovered = await scopedFamilyReresolveFromDisk(root, {
        title: item.title,
        module: item.module,
        testCaseId: item.testCaseId,
        testData: [item.testData, item.steps, item.expectedOutcome]
          .filter(Boolean)
          .join("\n"),
        tcMd: md.content,
        familyAnchors: [...familyAnchors, primaryPath],
        codeAliases: paramsCodeAliases,
      });
      scopedRecoveryUsed = true;
      if (
        recovered.primaryPath &&
        recovered.source &&
        recovered.primaryPath.replace(/\\/g, "/") !==
          primaryPath.replace(/\\/g, "/")
      ) {
        primaryPath = toRepoRelativePath(root, recovered.primaryPath);
        source = recovered.source;
        primarySource = "disk";
        related = recovered.related || related;
        disk = recovered;
        gate = decideUnitSutGate({
          tcText: tcBlob,
          primaryPath,
          sourceExcerpt: source,
          codeAliases: paramsCodeAliases,
          moduleText: [item.module, item.title, md.content.slice(0, 1500)]
            .filter(Boolean)
            .join("\n"),
          domainGuards,
          requireMarkers: requireMarkers !== false,
          unitScope,
          minAlignment,
        });
      }
    }
  }

  if (gate.decision === "block") {
    const code = gate.code || "FAIL_NEEDS_MARKER";
    if (/FEATURE_GAP/i.test(code) && profileGate.genMode === "always_generate") {
      gapFallbackUsed = true;
      gapFallbackReason = `${code} — ${gate.reason}`;
      notifyProgress(notify, {
        commandId,
        phase: "generating",
        current: index,
        total,
        message: "fallback mode: FEATURE_GAP → always_generate",
      });
    } else if (
      canSoftBypassGateForGroundedSource({
        code,
        primaryPath,
        source,
        markers,
      })
    ) {
      softBypassUsed = true;
      softBypassReason = gate.reason || "";
      softBypassCode = code;
      notifyProgress(notify, {
        commandId,
        phase: "generating",
        current: index,
        total,
        message: `gate soft-bypass ${code} · SUT=${primaryPath || "unknown"} · ${gate.reason || ""}`,
      });
    } else {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      primaryPath,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: `${code} — ${gate.reason}`,
      domainGuard: gate.domainGuard,
      resolvedSut: toRepoRelativePath(root, gate.resolvedSut || primaryPath || ""),
      alignmentScore: gate.alignmentScore,
      candidatesTop3,
      relatedFiles: relatedFileList(),
      intentClass: gate.intentClass,
      intentClasses: gate.intentClasses,
      minAlignment: gate.minAlignment,
    });
    notifyProgress(notify, {
      commandId,
      phase: "generating",
      current: index,
      total,
      message: `gate block ${code}`,
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `${code} — ${gate.reason}. ` +
          `Thêm path:/code: đúng domain, Approve lại, rồi Gen.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
        sourceFileName: primaryPath,
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: code,
      },
    };
    }
  }

  try {
    const engine = getUnitGenEngine();
    const result = await engine.generate(item, {
      workspaceRoot: root,
      conventions,
      projectRules,
      tcMd: gapFallbackUsed
        ? withGapFallbackInstruction(md.content, gapFallbackReason || "FEATURE_GAP")
        : softBypassUsed
          ? withSoftBypassDiagnosticInstruction(md.content, {
              code: softBypassCode || "SOFT_BYPASS",
              reason: softBypassReason,
              primaryPath,
            })
          : md.content,
      tcMdPath: md.path,
      primaryPath,
      source,
      related,
      suggestedPath: suggested,
      commandId,
      alignmentScore: gate.alignmentScore ?? lastAlignScore,
      candidatesTop3,
      onProgress: (s) => {
        notifyProgress(notify, {
          commandId,
          phase: "generating",
          current: index,
          total,
          message: s,
        });
      },
      isCancelled: () => cancelledIds.has(commandId),
      runPrompt,
    });
    const file = result.files[0];
    if (!file) {
      return {
        perTc: {
          testCaseId: item.testCaseId,
          genOk: false,
          error: "Engine returned no files",
          sourceFileName: primaryPath,
        },
      };
    }
    const fileOut =
      gapFallbackUsed && file
        ? {
            ...file,
            content: annotateGapFallbackCode(
              file.content,
              item.testCaseId,
              gapFallbackReason || "FEATURE_GAP"
            ),
          }
        : file;
    return {
      file: fileOut,
      truncated: result.truncated,
      meta: {
        path: fileOut.path,
        size: Buffer.byteLength(fileOut.content, "utf8"),
        status: "CREATED",
      },
      perTc: {
        testCaseId: item.testCaseId,
        genOk: true,
        filePaths: [file.path],
        sourceFileName: result.sourceFileName || primaryPath,
        metrics: result.metrics,
      },
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error: msg,
        sourceFileName: primaryPath,
      },
      meta: { path: suggested, status: "ERROR", error: msg },
    };
  }
}

export async function handleCodegenGenerateUnitBatch(
  params: CodegenGenerateUnitBatchParams,
  notify: NotifyFn
): Promise<CodegenResultCallback> {
  const fromParams = (params.projectRoot || "").trim();
  const fromIde = (workspaceRoot() || "").trim();
  const root = fromParams || fromIde;
  if (!root) {
    const failed: CodegenResultCallback = {
      commandId: params.commandId,
      status: "FAILED",
      error:
        "No workspace root — Desktop phải gửi projectRoot (thư mục SUT) hoặc mở đúng workspace trong IDE",
    };
    notifyResult(notify, failed);
    return failed;
  }
  if (!params.items?.length) {
    const failed: CodegenResultCallback = {
      commandId: params.commandId,
      status: "FAILED",
      error: "items[] required",
    };
    notifyResult(notify, failed);
    return failed;
  }

  cancelledIds.delete(params.commandId);
  notifyProgress(notify, {
    commandId: params.commandId,
    phase: "queued",
    current: 0,
    total: params.items.length,
    message: `Unit Gen batch queued (${getUnitGenEngine().name})…`,
  });

  const conventionsRaw = await readTextIfExists(
    path.join(root, ".ai-test", "unit-conventions.md"),
    UNIT_GEN_LIMITS.maxConventionsChars
  );
  const conventions = conventionsRaw.trim() || EMBEDDED_UNIT_CONVENTIONS;
  const projectRules = (params.projectRules || "").trim() || conventions;

  const {
    openAgentCliSession,
    getAgentCliSession,
  } = await import("./agentCliSession");
  let session = params.sessionId
    ? getAgentCliSession(params.sessionId)
    : null;
  let ephemeralSession = false;
  if (!session) {
    session = openAgentCliSession(root);
    ephemeralSession = !params.sessionId;
  }
  const runPrompt = (
    prompt: string,
    timeoutMs: number,
    onLine?: (s: string) => void
  ) => session!.run(prompt, timeoutMs, onLine);

  const files: CodegenFileDto[] = [];
  const generatedFiles: CodegenGeneratedFileMeta[] = [];
  const perTc: CodegenPerTcResult[] = [];
  let anyTruncated = false;

  let i = 0;
  try {
    for (const item of params.items) {
      if (cancelledIds.has(params.commandId)) break;
      i += 1;
      const one = await genOneItem(
        root,
        item,
        projectRules,
        conventions,
        params.commandId,
        notify,
        i,
        params.items.length,
        params.codeAliases,
        runPrompt
      );
      perTc.push(one.perTc);
      if (one.file) files.push(one.file);
      if (one.meta) generatedFiles.push(one.meta);
      if (one.truncated) anyTruncated = true;
    }
  } finally {
    if (ephemeralSession && session) {
      session.close();
    }
  }

  if (anyTruncated) {
    notifyProgress(notify, {
      commandId: params.commandId,
      phase: "generating",
      current: i,
      total: params.items.length,
      message: "job.gen.context_truncated",
    });
  }

  const anyOk = perTc.some((p) => p.genOk);
  const anyFail = perTc.some((p) => !p.genOk);
  const status = cancelledIds.has(params.commandId)
    ? "CANCELLED"
    : anyOk && anyFail
      ? "PARTIAL"
      : anyOk
        ? "COMPLETED"
        : "FAILED";

  const result: CodegenResultCallback = {
    commandId: params.commandId,
    status,
    files,
    workspaceTree: { generatedFiles },
    perTc,
    error: anyOk
      ? undefined
      : perTc.map((p) => p.error).filter(Boolean).join("; ") || "Unit Gen failed",
  };
  notifyProgress(notify, {
    commandId: params.commandId,
    phase: "done",
    current: params.items.length,
    total: params.items.length,
    message: `Unit Gen ${status}`,
  });
  notifyResult(notify, result);
  return result;
}
