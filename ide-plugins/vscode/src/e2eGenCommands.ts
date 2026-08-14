/**
 * E2E Gen Owner = Extension + Cursor Agent CLI (same as Unit).
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  IdeNotifications,
  UNIT_GEN_LIMITS,
  type CodegenE2eItem,
  type CodegenFileDto,
  type CodegenGenerateE2eBatchParams,
  type CodegenGeneratedFileMeta,
  type CodegenPerTcResult,
  type CodegenProgressNotification,
  type CodegenResultCallback,
} from "@aitest/ide-protocol";
import { workspaceRoot } from "./semanticContext";
import { EMBEDDED_E2E_CONVENTIONS } from "./e2eGenConventions";
import { parseE2eFilesFromRaw, buildE2eAgentPrompt } from "./e2eGenParse";
import { getUnitGenEngine } from "./cursorAgentCliEngine";

type NotifyFn = (method: string, params: unknown) => void;

const cancelledIds = new Set<string>();

export function markE2eGenCancelled(commandId: string): void {
  cancelledIds.add(commandId);
}

function notifyProgress(notify: NotifyFn, progress: CodegenProgressNotification): void {
  notify(IdeNotifications.codegenProgress, progress);
}

function notifyResult(notify: NotifyFn, result: CodegenResultCallback): void {
  notify(IdeNotifications.codegenResult, result);
}

async function readTextIfExists(abs: string, maxChars: number): Promise<string> {
  try {
    let body = await fs.readFile(abs, "utf8");
    if (body.length > maxChars) body = body.slice(0, maxChars) + "\n/* …truncated… */";
    return body;
  } catch {
    return "";
  }
}

function adaptiveTimeoutMs(prompt: string): number {
  const base = UNIT_GEN_LIMITS.genTimeoutMs;
  const chars = (prompt || "").length;
  if (chars <= 12_000) return Math.max(90_000, Math.floor(base * 0.5));
  if (chars <= 24_000) return Math.max(120_000, Math.floor(base * 0.75));
  return base;
}

async function genOneItem(
  item: CodegenE2eItem,
  conventions: string,
  commandId: string,
  notify: NotifyFn,
  current: number,
  total: number,
  runPrompt: (prompt: string, timeoutMs: number, onLine?: (s: string) => void) => Promise<string>
): Promise<{ files: CodegenFileDto[]; perTc: CodegenPerTcResult; metas: CodegenGeneratedFileMeta[] }> {
  const suggested =
    (item.suggestedSpecPath || "").trim() ||
    `AItest/E2ETest/${item.module || "Module"}/${item.testCaseId}/specs/journey.spec.ts`;
  notifyProgress(notify, {
    commandId,
    phase: "generating",
    current,
    total,
    message: `E2E Gen ${item.testCaseId} (${getUnitGenEngine().name})…`,
  });
  const prompt = buildE2eAgentPrompt({ item, conventions, suggestedSpecPath: suggested });
  const raw = await runPrompt(prompt, adaptiveTimeoutMs(prompt), (s) =>
    notifyProgress(notify, {
      commandId,
      phase: "generating",
      current,
      total,
      message: s.slice(0, 200),
    })
  );
  const files = parseE2eFilesFromRaw(raw, suggested);
  if (!files.length) {
    throw new Error("Empty E2E files from Agent CLI");
  }
  const metas: CodegenGeneratedFileMeta[] = files.map((f) => ({
    path: f.path,
    size: Buffer.byteLength(f.content || "", "utf8"),
    status: "CREATED",
  }));
  return {
    files,
    metas,
    perTc: {
      testCaseId: item.testCaseId,
      genOk: true,
      filePaths: files.map((f) => f.path),
    },
  };
}

export async function handleCodegenGenerateE2eBatch(
  params: CodegenGenerateE2eBatchParams,
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
    message: `E2E Gen batch queued (${getUnitGenEngine().name})…`,
  });

  const conventionsRaw = await readTextIfExists(
    path.join(root, ".ai-test", "e2e-conventions.md"),
    UNIT_GEN_LIMITS.maxConventionsChars
  );
  const conventions =
    (params.projectRules || "").trim() || conventionsRaw.trim() || EMBEDDED_E2E_CONVENTIONS;

  const { openAgentCliSession, getAgentCliSession } = await import("./agentCliSession");
  let session = params.sessionId ? getAgentCliSession(params.sessionId) : null;
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
  let i = 0;
  try {
    for (const item of params.items) {
      if (cancelledIds.has(params.commandId)) break;
      i += 1;
      try {
        const one = await genOneItem(
          item,
          conventions,
          params.commandId,
          notify,
          i,
          params.items.length,
          runPrompt
        );
        perTc.push(one.perTc);
        files.push(...one.files);
        generatedFiles.push(...one.metas);
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        perTc.push({ testCaseId: item.testCaseId, genOk: false, error: msg });
      }
    }
  } finally {
    if (ephemeralSession && session) session.close();
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
    workspaceTree: { testRoot: "AItest/E2ETest", generatedFiles },
    perTc,
    error: anyOk
      ? undefined
      : perTc.map((p) => p.error).filter(Boolean).join("; ") || "E2E Gen failed",
  };
  notifyProgress(notify, {
    commandId: params.commandId,
    phase: "done",
    current: params.items.length,
    total: params.items.length,
    message: `E2E Gen ${status}`,
  });
  notifyResult(notify, result);
  return result;
}
