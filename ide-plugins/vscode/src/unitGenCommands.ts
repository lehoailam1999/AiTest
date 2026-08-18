/**
 * Phase B.1 — Extension Unit Gen orchestrator (protocol handler).
 * Gen Owner = UnitGenEngine (default: CursorAgentCliEngine).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import { createHash } from "node:crypto";
import {
  AI_TEST_CASES_DIR,
  IdeNotifications,
  LEGACY_AI_TEST_CASES_DIR,
  UNIT_GEN_LIMITS,
  extractTcSourceMarkers,
  hasUnitSourceMarkers,
  primaryMatchesMarkers,
  sameContentHash,
  type CodegenFileDto,
  type CodegenGenerateUnitBatchParams,
  type CodegenGeneratedFileMeta,
  type CodegenPerTcResult,
  type CodegenProgressNotification,
  type CodegenResultCallback,
  type CodegenUnitItem,
} from "@aitest/ide-protocol";
import { workspaceRoot } from "./semanticContext";
import { EMBEDDED_UNIT_CONVENTIONS } from "./unitGenConventions";
import { excerptFromContextPacket, toRepoRelativePath } from "./unitGenParse";
import { getUnitGenEngine, writeUnitGenDebugDump } from "./cursorAgentCliEngine";
import { focusSutExcerpt } from "./focusSutExcerpt";
import { slimTcMdForGen } from "./slimTcMdForGen";
import {
  groundingRelatedPaths,
  isAuthoritativeUnitGrounding,
  loadUnitGroundingContract,
  resolveTestDataForGen,
} from "./unitGenPromptPrep";

export { stripCodeFences, excerptFromContextPacket, toRepoRelativePath } from "./unitGenParse";
export {
  getUnitGenEngine,
  registerUnitGenEngine,
  CursorAgentCliEngine,
} from "./cursorAgentCliEngine";
export type { UnitGenEngine, UnitGenEngineCtx, UnitGenEngineResult } from "./unitGenEngine";

type NotifyFn = (method: string, params: unknown) => void;

const cancelledIds = new Set<string>();
const PERF_MAX_RELATED_FILES = 3;
const PERF_MAX_RELATED_CHARS_EACH = Math.max(
  2000,
  Math.floor(UNIT_GEN_LIMITS.maxExcerptChars * 0.5)
);

export function markUnitGenCancelled(commandId: string): void {
  cancelledIds.add(commandId);
}

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function readSourceExcerpt(
  root: string,
  rel: string,
  maxChars: number = UNIT_GEN_LIMITS.maxExcerptChars
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
  maxCharsEach: number,
  targetProperty?: string
): Promise<string> {
  return (async () => {
    const loaded = await Promise.all(
      rels.map(async (rel) => ({
        rel,
        body: await readSourceExcerpt(root, rel, maxCharsEach),
      }))
    );
    const property = String(targetProperty || "").trim().toLowerCase();
    return loaded
      .filter((item): item is { rel: string; body: string } => Boolean(item.body))
      .sort((a, b) => {
        if (!property) return 0;
        const ah = a.body.toLowerCase().includes(property) ? 1 : 0;
        const bh = b.body.toLowerCase().includes(property) ? 1 : 0;
        return bh - ah;
      })
      .map(({ rel, body }) => `### ${rel}\n\`\`\`\n${body}\n\`\`\``)
      .join("\n\n");
  })();
}

function prepareTcMdForGen(
  rawMd: string,
  codeAliases: Parameters<typeof resolveTestDataForGen>[1]
): string {
  const resolved = resolveTestDataForGen(rawMd, codeAliases);
  return slimTcMdForGen(resolved.md);
}

function notifyProgress(notify: NotifyFn, progress: CodegenProgressNotification): void {
  notify(IdeNotifications.codegenProgress, progress);
}

function notifyResult(notify: NotifyFn, result: CodegenResultCallback): void {
  notify(IdeNotifications.codegenResult, result);
}

async function readTextIfExists(abs: string, maxChars = UNIT_GEN_LIMITS.maxConventionsChars): Promise<string> {
  try {
    const raw = await fs.readFile(abs, "utf8");
    return raw.length > maxChars ? raw.slice(0, maxChars) + "\n/* …truncated… */" : raw;
  } catch {
    return "";
  }
}

/** Walk canonical `AItest/test-cases`, then legacy `.ai-test/test-cases`. */
export async function findApprovedTcMarkdown(
  root: string,
  testCaseId: string
): Promise<{ path: string; content: string } | null> {
  const code = (testCaseId || "").trim();
  if (!code || !root) return null;
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
  for (const relBase of [AI_TEST_CASES_DIR, LEGACY_AI_TEST_CASES_DIR]) {
    const hit = await walk(path.join(root, ...relBase.split("/")));
    if (hit) return hit;
  }
  return null;
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
  mdCache: Map<string, { path: string; content: string } | null>,
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

  const cacheKey = (item.testCaseId || "").trim();
  let md = mdCache.get(cacheKey);
  if (md === undefined) {
    md = await findApprovedTcMarkdown(root, item.testCaseId);
    mdCache.set(cacheKey, md ?? null);
  }
  if (!md?.content?.trim()) {
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `Missing Approved TC markdown for «${item.testCaseId}» under AItest/test-cases/UnitTest/. ` +
          `Duyệt TC trong AITest (Approve ghi MD) trước khi Gen Unit.`,
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "Missing approved TC markdown",
      },
    };
  }

  // MD projections are required, but they are never accepted without the
  // authoritative companion decision validated below.
  const markerBlob = [md.content, item.testData || ""].join("\n");
  if (!hasUnitSourceMarkers(markerBlob)) {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: "MISSING_APPROVE_DECISION — missing path/code projections",
      domainGuard: "skip",
      resolvedSut: "unresolved",
      candidatesTop3: [],
    });
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          `MISSING_APPROVE_DECISION — «${item.testCaseId}» chưa có path/code projection. ` +
          `Re-Approve để IDE đồng bộ lại decision và Markdown.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "MISSING_APPROVE_DECISION",
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
  const groundingContract = await loadUnitGroundingContract(root, md.path);
  const groundingPaths = groundingRelatedPaths(groundingContract);
  const groundingPrimary = groundingContract?.primary?.pathRel
    ? toRepoRelativePath(root, groundingContract.primary.pathRel)
    : "";
  const packetPrimary = fromPacket.primaryPath
    ? toRepoRelativePath(root, fromPacket.primaryPath)
    : "";

  // Prefer Desktop packet when it already matches authoritative grounding + markers.
  // Always verify FULL on-disk primary hash — never hash a truncated packet excerpt.
  let fullPrimaryBody = "";
  let fullPrimaryHash = "";
  if (groundingPrimary) {
    try {
      const onDisk = await fs.readFile(path.join(root, groundingPrimary), "utf8");
      if (onDisk.trim()) {
        fullPrimaryHash = createHash("sha256")
          .update(onDisk, "utf8")
          .digest("hex");
        fullPrimaryBody =
          onDisk.length > UNIT_GEN_LIMITS.maxExcerptChars
            ? onDisk.slice(0, UNIT_GEN_LIMITS.maxExcerptChars) +
              "\n/* …truncated… */"
            : onDisk;
      }
    } catch {
      fullPrimaryBody = "";
      fullPrimaryHash = "";
    }
  }
  const hashOk = sameContentHash(
    fullPrimaryHash,
    groundingContract?.primary?.contentHash
  );
  const groundingAuthoritative =
    isAuthoritativeUnitGrounding(groundingContract, {
      paths: markers.paths,
      codes: markers.codes,
    }) &&
    Boolean(groundingPrimary) &&
    hashOk &&
    (!packetPrimary ||
      packetPrimary.toLowerCase() === groundingPrimary.toLowerCase()) &&
    (markers.paths.length + markers.codes.length === 0 ||
      primaryMatchesMarkers(groundingPrimary, markers));

  if (groundingContract?.authoritative === true && !groundingAuthoritative) {
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          "STALE_APPROVE_DECISION — grounding contract/markers/source hash mismatch; Re-Approve required",
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "STALE_APPROVE_DECISION",
      },
    };
  }

  // Consume-only: no disk re-resolve / alternate-primary recovery.
  if (!groundingAuthoritative) {
    return {
      perTc: {
        testCaseId: item.testCaseId,
        genOk: false,
        error:
          "MISSING_APPROVE_DECISION — Unit Gen requires authoritative IDE Approve Decision; Re-Approve required",
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "MISSING_APPROVE_DECISION",
      },
    };
  }

  primaryPath = groundingPrimary;
  source = fullPrimaryBody.trim() ? fullPrimaryBody : fromPacket.source;
  primarySource = "packet";
  lastAlignScore = 100;
  candidatesTop3 = [
    {
      path: primaryPath,
      score: 100,
      reason: "approved-grounding-decision",
    },
  ];

  // Related: prefer packet; else materialize from grounding contract deps only.
  if (!(related?.trim())) {
    const relatedRels = [...groundingPaths]
      .map(normRel)
      .filter((p) => p && p !== primaryPath);
    const uniqRelated = [...new Set(relatedRels)].slice(
      0,
      PERF_MAX_RELATED_FILES
    );
    if (uniqRelated.length) {
      const merged = await formatRelatedBlocks(
        root,
        uniqRelated,
        PERF_MAX_RELATED_CHARS_EACH,
        tcBlob.match(/^\s*target\.property\s*:\s*(\S+)/im)?.[1]
      );
      if (merged.trim()) related = merged;
    }
  }

    if (!source?.trim() || !primaryPath?.trim()) {
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: root,
      item,
      tcMdPath: md.path,
      suggestedPath: suggested,
      gateDecision: "block",
      blockedReason: "INVALID_APPROVE_DECISION — primary source unavailable",
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
          `INVALID_APPROVE_DECISION — Không đọc được primary source đã khóa cho «${item.testCaseId}». ` +
          `Re-Approve để làm mới decision/hash.` +
          (debugRel ? ` Debug: ${debugRel}` : ""),
      },
      meta: {
        path: suggested,
        status: "ERROR",
        error: "INVALID_APPROVE_DECISION",
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

  if (source?.trim() && markers.codes[0]) {
    source = focusSutExcerpt(
      source,
      markers.codes[0],
      UNIT_GEN_LIMITS.maxExcerptChars
    );
  }
  // Approve already validated identity, bindings, and behavior evidence. Gen
  // consumes the locked packet and does not run a second SUT/feature gate.

  try {
    const engine = getUnitGenEngine();
    const genTcMd = prepareTcMdForGen(md.content, paramsCodeAliases);
    const result = await engine.generate(item, {
      workspaceRoot: root,
      conventions,
      projectRules,
      tcMd: genTcMd,
      tcMdPath: md.path,
      primaryPath,
      source,
      related,
      suggestedPath: suggested,
      commandId,
      alignmentScore: lastAlignScore,
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
    const fileOut = file;
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

  let session: import("./agentCliSession").AgentCliSession;
  let ephemeralSession = false;
  try {
    const { bindAgentCliSession } = await import("./agentCliSession");
    const bound = bindAgentCliSession({
      workspaceRoot: root,
      sessionId: params.sessionId,
      agentExecutable: params.agentExecutable,
    });
    session = bound.session;
    ephemeralSession = bound.ephemeral;
  } catch (e) {
    const failed: CodegenResultCallback = {
      commandId: params.commandId,
      status: "FAILED",
      error: e instanceof Error ? e.message : String(e),
    };
    notifyResult(notify, failed);
    return failed;
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
  const mdCache = new Map<string, { path: string; content: string } | null>();

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
        mdCache,
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
