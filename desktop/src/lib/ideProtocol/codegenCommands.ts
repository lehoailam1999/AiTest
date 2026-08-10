/**
 * Desktop codegen protocol helpers — build payloads + dispatch via IDE bridge.
 * Phase A: applyFiles / runTests. Gen stays on API.
 */
import {
  IdeNotifications,
  type CodegenApplyFilesParams,
  type CodegenApplyFilesResult,
  type CodegenFileDto,
  type CodegenLayout,
  type CodegenProgressNotification,
  type CodegenResultCallback,
  type CodegenRunTestsParams,
  type CodegenRunTestsResult,
  type CodegenTestRunner,
} from "@aitest/ide-protocol";
import { getIdeRpcClientOrNull } from "../ideBridge/session";

export function newCodegenCommandId(prefix = "codegen"): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function toCodegenFiles(
  files: Array<{ path: string; content?: string; kind?: string }>
): CodegenFileDto[] {
  return files
    .filter((f) => f.path?.trim())
    .map((f) => ({
      path: f.path.replace(/\\/g, "/"),
      content: f.content ?? "",
      kind: (f.kind as CodegenFileDto["kind"]) || "other",
    }));
}

export function isIdeCodegenReady(): boolean {
  const client = getIdeRpcClientOrNull();
  return Boolean(client?.isConnected);
}

export type CodegenSessionHandlers = {
  onProgress?: (p: CodegenProgressNotification) => void;
  onResult?: (r: CodegenResultCallback) => void;
};

const sessionUnsubs = new Map<string, () => void>();

export function subscribeCodegenNotifications(
  commandId: string,
  handlers: CodegenSessionHandlers
): () => void {
  const client = getIdeRpcClientOrNull();
  if (!client) return () => {};
  const unsub = client.onNotification((method, params) => {
    if (method === IdeNotifications.codegenProgress) {
      const p = params as CodegenProgressNotification;
      if (p?.commandId === commandId) handlers.onProgress?.(p);
    }
    if (method === IdeNotifications.codegenResult) {
      const r = params as CodegenResultCallback;
      if (r?.commandId === commandId) handlers.onResult?.(r);
    }
  });
  sessionUnsubs.set(commandId, unsub);
  return () => {
    unsub();
    sessionUnsubs.delete(commandId);
  };
}

export async function ideApplyFiles(opts: {
  projectId: string;
  projectRoot: string;
  layout: CodegenLayout;
  files: Array<{ path: string; content?: string; kind?: string }>;
  projectRules?: string;
  projectRulesSource?: CodegenApplyFilesParams["projectRulesSource"];
  packagePrefix?: string;
  handlers?: CodegenSessionHandlers;
}): Promise<CodegenApplyFilesResult> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) {
    throw new Error("IDE bridge offline — connect Extension or use local Apply");
  }
  const commandId = newCodegenCommandId("apply");
  const unsub = subscribeCodegenNotifications(commandId, opts.handlers || {});
  try {
    const params: CodegenApplyFilesParams = {
      commandId,
      action: "APPLY_FILES",
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      packagePrefix: opts.packagePrefix,
      projectRules: opts.projectRules ?? "",
      projectRulesSource: opts.projectRulesSource ?? "none",
      layout: opts.layout,
      files: toCodegenFiles(opts.files),
    };
    return await client.codegenApplyFiles(params);
  } finally {
    unsub();
  }
}

export async function ideRunTests(opts: {
  projectId: string;
  projectRoot: string;
  runner: CodegenTestRunner;
  cwd?: string;
  specs?: string[];
  command?: string[];
  env?: Record<string, string>;
  headed?: boolean;
  timeoutMs?: number;
  handlers?: CodegenSessionHandlers;
}): Promise<CodegenRunTestsResult> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) {
    throw new Error("IDE bridge offline — connect Extension or use API sandbox");
  }
  const commandId = newCodegenCommandId("run");
  const unsub = subscribeCodegenNotifications(commandId, opts.handlers || {});
  try {
    const params: CodegenRunTestsParams = {
      commandId,
      action: "RUN_TESTS",
      projectId: opts.projectId,
      projectRoot: opts.projectRoot,
      runner: opts.runner,
      cwd: opts.cwd,
      specs: opts.specs,
      command: opts.command,
      env: opts.env,
      headed: opts.headed,
      timeoutMs: opts.timeoutMs,
    };
    return await client.codegenRunTests(params);
  } finally {
    unsub();
  }
}

export type CodegenTreeState = {
  commandId?: string;
  status?: string;
  files: Array<{ path: string; status: string; error?: string }>;
  runReport?: {
    passed: number;
    failed: number;
    skipped: number;
    durationMs: number;
    errors: Array<{ title?: string; stacktrace: string; screenshotPath?: string }>;
  };
  logExcerpt?: string;
  updatedAt: number;
};

let lastTree: CodegenTreeState = { files: [], updatedAt: 0 };
const treeListeners = new Set<() => void>();

export function getLastCodegenTree(): CodegenTreeState {
  return lastTree;
}

/** Subscribe to Apply/Run tree updates (used by codegenUiStore). */
export function onCodegenTreeChanged(fn: () => void): () => void {
  treeListeners.add(fn);
  return () => {
    treeListeners.delete(fn);
  };
}

export function rememberCodegenResult(result: CodegenResultCallback | CodegenApplyFilesResult): void {
  const tree = "workspaceTree" in result ? result.workspaceTree : undefined;
  const run =
    "testRunReport" in result
      ? (result as CodegenResultCallback).testRunReport
      : undefined;
  const draftFiles =
    "files" in result && Array.isArray((result as CodegenResultCallback).files)
      ? (result as CodegenResultCallback).files!
      : [];
  const fromTree = (tree?.generatedFiles || []).map((f) => ({
    path: f.path,
    status: f.status,
    error: f.error,
  }));
  const fromDraft = draftFiles.map((f) => ({
    path: f.path,
    status: "CREATED",
    error: undefined as string | undefined,
  }));
  lastTree = {
    commandId: result.commandId,
    status: result.status,
    files: fromTree.length ? fromTree : fromDraft,
    runReport: run
      ? {
          passed: run.passed,
          failed: run.failed,
          skipped: run.skipped,
          durationMs: run.durationMs,
          errors: run.errors,
        }
      : lastTree.runReport,
    logExcerpt:
      "artifacts" in result
        ? (result as CodegenResultCallback).artifacts?.logExcerpt
        : lastTree.logExcerpt,
    updatedAt: Date.now(),
  };
  for (const fn of treeListeners) {
    try {
      fn();
    } catch {
      /* ignore listener errors */
    }
  }
}
