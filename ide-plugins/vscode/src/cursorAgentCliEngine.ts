/**
 * Default UnitGenEngine — Cursor `agent` CLI oneshot in SUT workspace.
 *
 * Windows: user home often has spaces (C:\\Users\\Dell One\\...). Never use
 * spawn(path, { shell: true }) — cmd splits on the space. Match API
 * process_runner: prefer .ps1 via powershell -File, else cmd /d /s /c + list2cmdline.
 */
import { execSync, spawn, type SpawnOptions } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import * as path from "node:path";
import {
  assertSafeAitestTargetRel,
  UNIT_GEN_LIMITS,
  UNIT_PROMPT_RULES_CORE,
  assertUnitGenQuality,
  buildUnitGenPhaseMetrics,
  isUnitGenRefuseOutput,
  type CodegenFileDto,
  type CodegenUnitItem,
  type UnitGenPhaseMetrics,
} from "@aitest/ide-protocol";
import { EMBEDDED_UNIT_CONVENTIONS } from "./unitGenConventions";
import { stripCodeFences } from "./unitGenParse";
import type { UnitGenEngine, UnitGenEngineCtx, UnitGenEngineResult } from "./unitGenEngine";

/** True when full prompt dump is enabled (default on — set AITEST_UNIT_GEN_DEBUG=0 to disable). */
function unitGenDebugEnabled(): boolean {
  const v = (process.env.AITEST_UNIT_GEN_DEBUG || "1").trim().toLowerCase();
  return v !== "0" && v !== "false" && v !== "off";
}

/** Full prompt dump is heavy I/O — off by default unless explicitly enabled. */
function unitGenPromptDumpEnabled(): boolean {
  const v = (process.env.AITEST_UNIT_GEN_DEBUG_PROMPT || "0").trim().toLowerCase();
  return v === "1" || v === "true" || v === "on";
}

function adaptiveUnitGenTimeoutMs(prompt: string): number {
  const base = UNIT_GEN_LIMITS.genTimeoutMs;
  const chars = (prompt || "").length;
  // Keep short prompts snappy while preserving headroom for very large contexts.
  if (chars <= 12_000) return Math.max(90_000, Math.floor(base * 0.5));
  if (chars <= 24_000) return Math.max(120_000, Math.floor(base * 0.75));
  return base;
}

function safeTcDebugId(testCaseId: string): string {
  return (testCaseId || "unknown").replace(/[^\w.-]+/g, "_").slice(0, 96) || "unknown";
}

/**
 * Write Gen debug artifact under SUT `.ai-test/logs/unit-gen-debug/`.
 * Disable with env AITEST_UNIT_GEN_DEBUG=0.
 * When gateDecision=block, omit full prompt (do not look like a valid Gen).
 */
export async function writeUnitGenDebugDump(opts: {
  workspaceRoot: string;
  item: CodegenUnitItem;
  prompt?: string;
  truncated?: boolean;
  primaryPath?: string;
  tcMdPath?: string;
  suggestedPath?: string;
  projectRulesChars?: number;
  conventionsChars?: number;
  sourceChars?: number;
  relatedChars?: number;
  relatedFiles?: string[];
  alignmentScore?: number;
  candidatesTop3?: Array<{ path: string; score?: number; reason?: string }>;
  domainGuard?: "pass" | "fail" | "skip";
  gateDecision: "gen" | "block";
  blockedReason?: string;
  resolvedSut?: string;
  intentClass?: string | null;
  intentClasses?: string[];
  minAlignment?: number;
  ruleHits?: string[];
  includePrompt?: boolean;
}): Promise<string | null> {
  if (!unitGenDebugEnabled()) return null;
  const dir = path.join(opts.workspaceRoot, ".ai-test", "logs", "unit-gen-debug");
  const id = safeTcDebugId(opts.item.testCaseId);
  const relMeta = `.ai-test/logs/unit-gen-debug/${id}.md`;
  const abs = path.join(dir, `${id}.md`);
  const candidates = (opts.candidatesTop3 || [])
    .map(
      (c) =>
        `  - path: ${c.path}` +
        (c.score != null ? ` score=${c.score}` : "") +
        (c.reason ? ` reason=${c.reason}` : "")
    )
    .join("\n");
  const header = [
    `# Unit Gen debug — ${opts.item.testCaseId}`,
    "",
    "```yaml",
    `testCaseId: ${opts.item.testCaseId}`,
    `module: ${opts.item.module || ""}`,
    `title: ${opts.item.title || ""}`,
    `intentClass: ${opts.intentClass || ""}`,
    `intentClasses: ${(opts.intentClasses || []).join(", ") || "[]"}`,
    `resolvedSut: ${opts.resolvedSut || opts.primaryPath || "unresolved"}`,
    `alignmentScore: ${opts.alignmentScore ?? ""}`,
    `minAlignment: ${opts.minAlignment ?? ""}`,
    `ruleHits: ${(opts.ruleHits || []).join(", ") || "[]"}`,
    `domainGuard: ${opts.domainGuard ?? "skip"}`,
    `gateDecision: ${opts.gateDecision}`,
    `blockedReason: ${opts.blockedReason || ""}`,
    `suggestedPath: ${opts.suggestedPath || ""}`,
    `tcMdPath: ${opts.tcMdPath || ""}`,
    `relatedFiles: ${(opts.relatedFiles || []).join(", ") || "[]"}`,
    `promptChars: ${opts.gateDecision === "gen" ? (opts.prompt || "").length : 0}`,
    `at: ${new Date().toISOString()}`,
    "candidatesTop3:",
    candidates || "  []",
    "```",
    "",
  ];
  const bodyParts = [...header];
  const includePrompt = opts.includePrompt === true && unitGenPromptDumpEnabled();
  if (opts.gateDecision === "gen" && includePrompt && opts.prompt?.trim()) {
    bodyParts.push(
      "## Full prompt sent to AI CLI",
      "",
      "```",
      opts.prompt,
      "```",
      ""
    );
  } else if (opts.gateDecision === "gen") {
    bodyParts.push(
      "## AI CLI invoked (prompt dump disabled)",
      "",
      "Set AITEST_UNIT_GEN_DEBUG_PROMPT=1 to include the full prompt in this artifact.",
      opts.blockedReason ? `Note: ${opts.blockedReason}` : "",
      ""
    );
  } else {
    bodyParts.push(
      "## Gate blocked — AI CLI not invoked",
      "",
      opts.blockedReason || "(no reason)",
      ""
    );
  }
  const body = bodyParts.join("\n");
  try {
    await mkdir(dir, { recursive: true });
    await writeFile(abs, body, "utf8");
    await writeFile(path.join(dir, "last.md"), body, "utf8");
    return relMeta;
  } catch {
    return null;
  }
}

/** Python subprocess.list2cmdline equivalent — safe for paths with spaces. */
function list2cmdline(argv: string[]): string {
  return argv
    .map((arg) => {
      if (!/[\s"]/.test(arg)) return arg;
      let out = '"';
      let bs = 0;
      for (const ch of arg) {
        if (ch === "\\") {
          bs += 1;
        } else if (ch === '"') {
          out += "\\".repeat(bs * 2 + 1) + '"';
          bs = 0;
        } else {
          out += "\\".repeat(bs) + ch;
          bs = 0;
        }
      }
      out += "\\".repeat(bs * 2) + '"';
      return out;
    })
    .join(" ");
}

function powershellExe(): string {
  const sys = process.env.SystemRoot || "C:\\Windows";
  const candidate = path.join(sys, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
  if (existsSync(candidate)) return candidate;
  return "powershell.exe";
}

/**
 * Spawn CLI without shell:true (avoids 'C:\\Users\\Dell' is not recognized).
 */
export function spawnCli(
  command: string,
  args: string[],
  opts: SpawnOptions
): ReturnType<typeof spawn> {
  if (process.platform !== "win32") {
    return spawn(command, args, { ...opts, shell: false });
  }

  let exe = command.trim();
  if (/\.cmd$/i.test(exe)) {
    const ps1 = exe.replace(/\.cmd$/i, ".ps1");
    if (existsSync(ps1)) {
      return spawn(
        powershellExe(),
        ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", ps1, ...args],
        { ...opts, shell: false, windowsHide: true }
      );
    }
  }

  if (/\.(cmd|bat)$/i.test(exe)) {
    const cmdline = list2cmdline([exe, ...args]);
    return spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", cmdline], {
      ...opts,
      shell: false,
      windowsVerbatimArguments: true,
      windowsHide: true,
    });
  }

  if (/\.ps1$/i.test(exe)) {
    return spawn(
      powershellExe(),
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", exe, ...args],
      { ...opts, shell: false, windowsHide: true }
    );
  }

  return spawn(exe, args, { ...opts, shell: false, windowsHide: true });
}

function resolveAgentBinary(): string {
  const fromEnv = (process.env.AITEST_AGENT_PATH || process.env.CURSOR_AGENT_PATH || "").trim();
  if (fromEnv) return fromEnv;

  const localApp = process.env.LOCALAPPDATA || "";
  if (localApp) {
    const cursorAgent = path.join(localApp, "cursor-agent", "agent.ps1");
    if (existsSync(cursorAgent)) return cursorAgent;
    const cursorCmd = path.join(localApp, "cursor-agent", "agent.cmd");
    if (existsSync(cursorCmd)) return cursorCmd;
  }

  const names =
    process.platform === "win32"
      ? ["agent.ps1", "agent.cmd", "agent.exe", "agent", "cursor-agent.cmd"]
      : ["agent", "cursor-agent"];
  for (const name of names) {
    try {
      const cmd = process.platform === "win32" ? `where ${name}` : `command -v ${name}`;
      const out = execSync(cmd, { encoding: "utf8", windowsHide: true });
      const line = out
        .split(/\r?\n/)
        .map((s) => s.trim())
        .find(Boolean);
      if (line) {
        if (/\.cmd$/i.test(line)) {
          const ps1 = line.replace(/\.cmd$/i, ".ps1");
          if (existsSync(ps1)) return ps1;
        }
        return line;
      }
    } catch {
      /* try next */
    }
  }
  return process.platform === "win32" ? "agent.cmd" : "agent";
}

/** Exported for Phase 2 session reuse (resolve once per session). */
export { resolveAgentBinary };

function extractStreamText(obj: Record<string, unknown>): string {
  for (const key of ["text", "delta", "content", "message", "result"]) {
    const val = obj[key];
    if (typeof val === "string" && val.trim()) return val;
    if (val && typeof val === "object") {
      const nested = extractStreamText(val as Record<string, unknown>);
      if (nested) return nested;
    }
  }
  return "";
}

export async function runCursorAgentOneshotWithBin(
  bin: string,
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onLine?: (s: string) => void
): Promise<string> {
  const args = [
    "--print",
    "--mode",
    "ask",
    "--output-format",
    "stream-json",
    "--stream-partial-output",
    "--trust",
    "--workspace",
    cwd,
  ];
  return new Promise((resolve, reject) => {
    const child = spawnCli(bin, args, {
      cwd,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    const chunks: string[] = [];
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`AI CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout?.on("data", (buf: Buffer) => {
      const s = buf.toString("utf8");
      stdout += s;
      for (const line of s.split(/\r?\n/)) {
        const t = line.trim();
        if (!t) continue;
        try {
          const obj = JSON.parse(t) as Record<string, unknown>;
          const piece = extractStreamText(obj);
          if (piece) {
            chunks.push(piece);
            onLine?.(piece.slice(0, 120));
          }
        } catch {
          chunks.push(t);
        }
      }
    });
    child.stderr?.on("data", (buf: Buffer) => {
      stderr += buf.toString("utf8");
    });
    child.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const joined = chunks.join("") || stdout;
      if (code !== 0 && !joined.trim()) {
        reject(
          new Error(
            stderr.trim() ||
              `AI CLI exit ${code} (bin=${bin})`
          )
        );
        return;
      }
      resolve(joined);
    });
    child.stdin?.write(prompt, "utf8");
    child.stdin?.end();
  });
}

export async function runCursorAgentOneshot(
  prompt: string,
  cwd: string,
  timeoutMs: number,
  onLine?: (s: string) => void
): Promise<string> {
  return runCursorAgentOneshotWithBin(
    resolveAgentBinary(),
    prompt,
    cwd,
    timeoutMs,
    onLine
  );
}

export function buildUnitPrompt(opts: {
  item: CodegenUnitItem;
  projectRules: string;
  conventions: string;
  tcMd: string;
  tcMdPath: string;
  primaryPath?: string;
  source?: string;
  related?: string;
  suggestedPath: string;
  /** P0: only inject «only allowed primary» when hard gate passed. */
  gatePassed?: boolean;
}): { prompt: string; truncated: boolean } {
  let truncated = false;
  const excerptLim = UNIT_GEN_LIMITS.maxExcerptChars;
  const tcLim = UNIT_GEN_LIMITS.maxTcMdChars;
  const slice = (s: string, label: string, lim = excerptLim) => {
    if (s.length > lim) {
      truncated = true;
      return s.slice(0, lim) + `\n/* …truncated ${label}… */`;
    }
    return s;
  };

  const gatePassed = opts.gatePassed !== false;
  const parts: string[] = [
    ...UNIT_PROMPT_RULES_CORE,
    `Save path (mandatory): ${opts.suggestedPath}`,
    gatePassed && opts.primaryPath
      ? `Import / exercise the SUT at «${opts.primaryPath}» — this is the only allowed primary SUT for this job.`
      : "",
    gatePassed && opts.primaryPath
      ? [
          "",
          "## Locked Approve Decision (do not re-rank SUT)",
          `- Implement the unit test for THIS Approved TC against locked files only.`,
          `- Primary: ${opts.primaryPath}`,
          `- Do not search the repo for an alternate Handler/DTO; do not reclassify intent.`,
          `- Prefer observable behavior already present in the Source / Related excerpts below.`,
        ].join("\n")
      : "",
    "",
  ];
  const rules = (opts.projectRules || opts.conventions || EMBEDDED_UNIT_CONVENTIONS).trim();
  parts.push(
    "## Project rules / unit-conventions (authoritative policy SoT)",
    slice(rules, "conventions"),
    ""
  );

  const tcMd = opts.tcMd.trim();
  parts.push(
    "## Approved TC markdown (required SoT for this Gen)",
    `Path: ${opts.tcMdPath}`,
    "This file was written when the TC was Approved in AITest — analyze THIS test case only.",
    slice(tcMd, "tc-md", tcLim),
    ""
  );

  // Skip Request meta when MD already carries title / id (avoids triple title dump).
  const mdHasTitle =
    /^#\s+\S/m.test(tcMd) || /\btitle:\s*\S/i.test(tcMd);
  const mdHasId =
    /\b(?:testCaseId|Code):\s*`?[\w.-]+/i.test(tcMd) ||
    /\|\s*Code\s*\|\s*`?[\w.-]+/i.test(tcMd);
  if (!(mdHasTitle && mdHasId)) {
    parts.push(
      "## Request meta (must match MD)",
      `Title: ${opts.item.title}`,
      `Code: ${opts.item.testCaseId}`,
      opts.item.module ? `Module: ${opts.item.module}` : "",
      ""
    );
  } else if (opts.item.module && !/\bmodule:\s*\S/i.test(tcMd)) {
    parts.push(`Module: ${opts.item.module}`, "");
  }

  if (opts.source?.trim()) {
    parts.push(
      `## Source under test${opts.primaryPath ? ` (${opts.primaryPath})` : ""}`,
      "```",
      slice(opts.source.trim(), "sut"),
      "```",
      ""
    );
  }
  if (opts.related?.trim()) {
    parts.push("## Related sources", slice(opts.related.trim(), "related"), "");
  }
  const repairCtx = (opts.item.repairContext || "").trim();
  if (repairCtx) {
    parts.push(
      "## Repair context (verify failed — rewrite the unit test)",
      "Fix the failing test against the same SUT. Do not invent new BRs.",
      slice(repairCtx, "repair"),
      ""
    );
  }
  const existing = opts.item.existingFiles || [];
  if (existing.length) {
    parts.push("## Existing test file(s) to repair");
    for (const f of existing.slice(0, 3)) {
      parts.push(`### ${f.path}`, "```", slice(f.content || "", "existing-test"), "```", "");
    }
  }
  if (!opts.source?.trim()) {
    parts.push(
      "WARNING: No SUT excerpt resolved. Search the workspace for production code matching the TC MD, then generate a focused unit test.",
      ""
    );
  }
  return {
    prompt: parts.filter((l) => l !== undefined && l !== "").join("\n"),
    truncated,
  };
}

export class CursorAgentCliEngine implements UnitGenEngine {
  readonly name = "cursor-agent-cli";

  async generate(item: CodegenUnitItem, ctx: UnitGenEngineCtx): Promise<UnitGenEngineResult> {
    if (ctx.isCancelled?.()) {
      throw new Error("CANCELLED");
    }
    const { prompt, truncated } = buildUnitPrompt({
      item,
      projectRules: ctx.projectRules,
      conventions: ctx.conventions,
      tcMd: ctx.tcMd,
      tcMdPath: ctx.tcMdPath,
      primaryPath: ctx.primaryPath,
      source: ctx.source,
      related: ctx.related,
      suggestedPath: ctx.suggestedPath,
      gatePassed: true,
    });
    const relatedFiles = (ctx.related || "")
      .split(/^### /m)
      .map((s) => s.split("\n")[0]?.trim())
      .filter(Boolean) as string[];
    const debugRel = await writeUnitGenDebugDump({
      workspaceRoot: ctx.workspaceRoot,
      item,
      prompt,
      truncated,
      primaryPath: ctx.primaryPath,
      tcMdPath: ctx.tcMdPath,
      suggestedPath: ctx.suggestedPath,
      projectRulesChars: (ctx.projectRules || "").length,
      conventionsChars: (ctx.conventions || "").length,
      sourceChars: (ctx.source || "").length,
      relatedChars: (ctx.related || "").length,
      relatedFiles,
      alignmentScore: ctx.alignmentScore,
      candidatesTop3: ctx.candidatesTop3,
      gateDecision: "gen",
      domainGuard: "pass",
      resolvedSut: ctx.primaryPath || "unresolved",
      includePrompt: false,
    });
    if (debugRel) {
      ctx.onProgress?.(`debug dump → ${debugRel}`);
    }
    const cliStarted = Date.now();
    const timeoutMs = adaptiveUnitGenTimeoutMs(prompt);
    const raw = ctx.runPrompt
      ? await ctx.runPrompt(
          prompt,
          timeoutMs,
          (s) => ctx.onProgress?.(s)
        )
      : await runCursorAgentOneshot(
          prompt,
          ctx.workspaceRoot,
          timeoutMs,
          (s) => ctx.onProgress?.(s)
        );
    const cliTimeMs = Date.now() - cliStarted;
    if (ctx.isCancelled?.()) {
      throw new Error("CANCELLED");
    }
    const code = stripCodeFences(raw);
    if (!code.trim() || isUnitGenRefuseOutput(code)) {
      const hint = debugRel ? ` Xem debug: ${debugRel}` : "";
      const refuse = (code.match(/FAIL_[A-Z_]+/i) || [])[0] || "FAIL_SUT_MISMATCH";
      throw new Error(
        isUnitGenRefuseOutput(code)
          ? `${refuse} — model refused (SUT=${ctx.primaryPath}). ` +
              `SUT hiện tại không có nhánh khớp TC (sai lớp / thiếu enforce). ` +
              `Sửa path:/code: (hoặc layerHint: dto|validator) rồi Approve lại, rồi Gen.` +
              hint
          : "Empty unit test from AI CLI" + hint
      );
    }
    const safe = assertSafeAitestTargetRel(ctx.suggestedPath);
    if (!/\/unittest\//i.test(`/${safe}/`)) {
      throw new Error(`Path jail Unit: thiếu segment UnitTest (got ${safe})`);
    }
    assertUnitGenQuality({
      relPath: safe,
      code,
      tcText: ctx.tcMd,
      primaryPath: ctx.primaryPath,
      sutExcerpt: ctx.source,
    });
    const relatedFileCount = (ctx.related || "").split(/^### /m).filter(Boolean).length;
    const metrics = buildUnitGenPhaseMetrics({
      cliTimeMs,
      prompt,
      sutExcerpt: ctx.source,
      relatedExcerpt: ctx.related,
      relatedFileCount,
      truncated,
    });
    const file: CodegenFileDto = { path: safe, content: code, kind: "unit" };
    return {
      files: [file],
      sourceFileName: ctx.primaryPath,
      truncated,
      log: truncated ? "context_truncated" : undefined,
      metrics,
    };
  }
}

let registeredEngine: UnitGenEngine = new CursorAgentCliEngine();

export function getUnitGenEngine(): UnitGenEngine {
  return registeredEngine;
}

/** Tests / future SDK: swap engine without changing orchestrator. */
export function registerUnitGenEngine(engine: UnitGenEngine): void {
  registeredEngine = engine;
}
