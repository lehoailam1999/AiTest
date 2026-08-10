/**
 * Codegen Protocol handlers — Apply files (path jail) + Run tests + Phase B stubs.
 */
import { spawn } from "node:child_process";
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  assertSafeAitestTargetRel,
  filterAllowedEnv,
  IdeNotifications,
  makeNotification,
  type CodegenApplyFilesParams,
  type CodegenApplyFilesResult,
  type CodegenCancelParams,
  type CodegenFileStatus,
  type CodegenGeneratedFileMeta,
  type CodegenProgressNotification,
  type CodegenResultCallback,
  type CodegenRunTestsParams,
  type CodegenRunTestsResult,
  type CodegenTestRunReport,
} from "@aitest/ide-protocol";
import { workspaceRoot } from "./semanticContext";

const cancelledIds = new Set<string>();

type NotifyFn = (method: string, params: unknown) => void;

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

function notifyProgress(notify: NotifyFn, progress: CodegenProgressNotification): void {
  notify(IdeNotifications.codegenProgress, progress);
}

function notifyResult(notify: NotifyFn, result: CodegenResultCallback): void {
  notify(IdeNotifications.codegenResult, result);
}

export function handleCodegenCancel(params: CodegenCancelParams): { ok: boolean } {
  cancelledIds.add(params.commandId);
  return { ok: true };
}

export async function handleCodegenApplyFiles(
  params: CodegenApplyFilesParams,
  notify: NotifyFn
): Promise<CodegenApplyFilesResult> {
  const root = workspaceRoot() || params.projectRoot;
  if (!root) {
    throw new Error("No workspace root — open project folder in IDE");
  }

  notifyProgress(notify, {
    commandId: params.commandId,
    phase: "applying",
    current: 0,
    total: params.files.length,
    message: "Applying files…",
  });

  const generatedFiles: CodegenGeneratedFileMeta[] = [];
  let i = 0;
  for (const f of params.files) {
    if (cancelledIds.has(params.commandId)) {
      break;
    }
    i += 1;
    const rel = normRel(f.path);
    let status: CodegenFileStatus = "ERROR";
    let error: string | undefined;
    try {
      const safe = assertSafeAitestTargetRel(rel);
      if (params.layout === "e2e" && !/\/e2etest\//i.test(`/${safe}/`)) {
        throw new Error(`Path jail E2E: thiếu segment E2ETest (got ${safe})`);
      }
      if (params.layout === "unit" && !/\/unittest\//i.test(`/${safe}/`)) {
        throw new Error(`Path jail Unit: thiếu segment UnitTest (got ${safe})`);
      }
      const abs = path.join(root, ...safe.split("/"));
      const existed = await fileExists(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content ?? "", "utf8");
      status = existed ? "UPDATED" : "CREATED";
      generatedFiles.push({
        path: safe,
        size: Buffer.byteLength(f.content ?? "", "utf8"),
        status,
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = /Path jail/i.test(error) ? "REJECTED_JAIL" : "ERROR";
      generatedFiles.push({ path: rel, status, error });
    }
    notifyProgress(notify, {
      commandId: params.commandId,
      phase: "applying",
      current: i,
      total: params.files.length,
      message: `${status} ${rel}`,
    });
  }

  const rejected = generatedFiles.some(
    (g) => g.status === "REJECTED_JAIL" || g.status === "ERROR"
  );
  const result: CodegenApplyFilesResult = {
    commandId: params.commandId,
    status: cancelledIds.has(params.commandId)
      ? "CANCELLED"
      : rejected
        ? "PARTIAL"
        : "COMPLETED",
    workspaceTree: {
      testRoot: params.layout === "e2e" ? "AItest/E2ETest" : "AItest/UnitTest",
      generatedFiles,
    },
  };

  notifyResult(notify, {
    commandId: params.commandId,
    status: result.status,
    workspaceTree: result.workspaceTree,
  });
  return result;
}

function parsePlaywrightLikeSummary(log: string): CodegenTestRunReport {
  const errors: CodegenTestRunReport["errors"] = [];
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const pw = log.match(
    /(\d+)\s+passed(?:.*?(\d+)\s+failed)?(?:.*?(\d+)\s+skipped)?/i
  );
  if (pw) {
    passed = Number(pw[1] || 0);
    failed = Number(pw[2] || 0);
    skipped = Number(pw[3] || 0);
  }
  const dotnet = log.match(/Failed:\s*(\d+).*Passed:\s*(\d+)/is);
  if (dotnet && !pw) {
    failed = Number(dotnet[1] || 0);
    passed = Number(dotnet[2] || 0);
  }
  const jest = log.match(/Tests:\s+(\d+)\s+failed.*?(\d+)\s+passed/i);
  if (jest && !pw && !dotnet) {
    failed = Number(jest[1] || 0);
    passed = Number(jest[2] || 0);
  }
  if (failed > 0 || /Error:|FAIL\s/i.test(log)) {
    const shot = log.match(/(?:screenshot|Screenshot)\s*[:=]\s*([^\s]+\.(?:png|jpg|jpeg))/i);
    errors.push({
      stacktrace: log.slice(-4000),
      screenshotPath: shot?.[1],
    });
  }
  return { passed, failed, skipped, durationMs: 0, errors };
}

async function runProcess(
  command: string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number
): Promise<{ code: number; log: string; durationMs: number }> {
  const started = Date.now();
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd,
      env: { ...process.env, ...env },
      shell: process.platform === "win32",
    });
    let log = "";
    const onData = (buf: Buffer) => {
      log += buf.toString("utf8");
      if (log.length > 200_000) log = log.slice(-160_000);
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    const timer = setTimeout(() => {
      child.kill();
      resolve({
        code: 124,
        log: log + "\n[timeout]",
        durationMs: Date.now() - started,
      });
    }, timeoutMs);
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code: code ?? 1, log, durationMs: Date.now() - started });
    });
  });
}

export async function handleCodegenRunTests(
  params: CodegenRunTestsParams,
  notify: NotifyFn
): Promise<CodegenRunTestsResult> {
  const root = workspaceRoot() || params.projectRoot;
  if (!root) throw new Error("No workspace root");

  notifyProgress(notify, {
    commandId: params.commandId,
    phase: "running",
    message: `Running ${params.runner}…`,
  });

  if (cancelledIds.has(params.commandId)) {
    const empty: CodegenTestRunReport = {
      passed: 0,
      failed: 0,
      skipped: 0,
      durationMs: 0,
      errors: [{ stacktrace: "cancelled" }],
    };
    return { commandId: params.commandId, status: "CANCELLED", testRunReport: empty };
  }

  const cwdRel = (params.cwd || ".").replace(/\\/g, "/");
  const cwd = path.isAbsolute(cwdRel) ? cwdRel : path.join(root, cwdRel);
  const env = filterAllowedEnv(params.env);
  const timeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : 300_000;

  let command: string[] = [];
  if (params.runner === "custom" && params.command?.length) {
    command = params.command;
  } else if (params.runner === "playwright") {
    const specs = params.specs?.length ? params.specs : ["."];
    command = ["npx", "playwright", "test", ...specs];
    if (params.headed) command.push("--headed");
  } else if (params.runner === "dotnet") {
    command = params.command?.length
      ? params.command
      : ["dotnet", "test", "--nologo"];
  } else if (params.runner === "jest") {
    command = params.command?.length ? params.command : ["npx", "jest"];
  } else if (params.runner === "vitest") {
    command = params.command?.length ? params.command : ["npx", "vitest", "run"];
  } else if (params.runner === "pytest") {
    command = params.command?.length ? params.command : ["pytest", "-q"];
  } else {
    throw new Error(`Unsupported runner: ${params.runner}`);
  }

  const { code, log, durationMs } = await runProcess(command, cwd, env, timeoutMs);
  const report = parsePlaywrightLikeSummary(log);
  report.durationMs = durationMs;
  if (code !== 0 && report.failed === 0) {
    report.failed = 1;
    if (!report.errors.length) {
      report.errors.push({ stacktrace: log.slice(-4000) || `exit ${code}` });
    }
  }

  const status =
    code === 0 && report.failed === 0
      ? "COMPLETED"
      : report.passed > 0
        ? "PARTIAL"
        : "FAILED";

  const result: CodegenRunTestsResult = {
    commandId: params.commandId,
    status,
    testRunReport: report,
    artifacts: { logExcerpt: log.slice(-12000) },
  };

  notifyResult(notify, {
    commandId: params.commandId,
    status,
    testRunReport: report,
    artifacts: result.artifacts,
  });
  return result;
}

export function handleCodegenGenerateStub(
  kind: "unit" | "e2e",
  commandId: string
): CodegenResultCallback {
  return {
    commandId,
    status: "FAILED",
    error:
      `Phase A/B: aitest/codegen.generate${kind === "unit" ? "Unit" : "E2e"}Batch not implemented — ` +
      "Desktop/API still owns Gen + guards. Approved TC markdown may exist under `.ai-test/test-cases/` " +
      "(Phase C sync) as supplemental artifact only. Use applyFiles/runTests.",
  };
}

/** Optional: read profile testRoot for UI hints (best-effort). */
export async function readProjectProfileHint(): Promise<{
  testRoot?: string;
  testIdAttribute?: string;
} | null> {
  const root = workspaceRoot();
  if (!root) return null;
  try {
    const raw = await fs.readFile(path.join(root, ".ai-test", "project.profile.json"), "utf8");
    const parsed = JSON.parse(raw) as {
      testRoot?: string;
      playwrightRun?: { testIdAttribute?: string };
    };
    return {
      testRoot: parsed.testRoot,
      testIdAttribute: parsed.playwrightRun?.testIdAttribute,
    };
  } catch {
    return null;
  }
}

export function makeBridgeNotify(sockets: Set<{ readyState: number; send: (s: string) => void }>): NotifyFn {
  return (method, params) => {
    const body = JSON.stringify(makeNotification(method, params));
    for (const s of sockets) {
      if (s.readyState === 1) s.send(body);
    }
  };
}
