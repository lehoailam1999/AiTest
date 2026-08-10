/**
 * UnitJobRunner — Desktop orchestrates Gen lifecycle only.
 * Extension + Cursor CLI own Unit code Gen (fail-closed; no API Gen fallback).
 * Page must call this for Unit Gen — not generateUnit.run
 * (API /generate-unit is legacy; Unit Repair also uses Extension CLI).
 */
import {
  UNIT_GEN_LIMITS,
  assertSafeAitestTargetRel,
  decideUnitSutGate,
  extractTcSourceMarkers,
  isInterfaceLikePrimaryPath,
  stemOfPath,
  type UnitDomainGuardRule,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import {
  isIdeCodegenReady,
  tryExtensionGenerateUnitBatch,
  cancelExtensionCodegen,
} from "../ideProtocol";
import { getIdeRpcClientOrNull } from "../ideBridge/session";
import {
  buildGenerateContext,
  ideListSourceFiles,
  ideReadFile,
  loadUnitProjectRules,
} from "../ideLocalCommands";
import { forcePacketPrimary } from "../contextPacket/forcePacketPrimary";
import { primaryFile } from "../contextPacket/serialize";
import type { AITestContextPacket } from "../contextPacket/types";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  buildRequirementTcModule,
  uniquifyTestTargetRel,
} from "../testOutputLayout";
import { sourceExtensionsForLanguage, suggestUnitTestPath } from "../stackHints";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";
import { recordUnitJobMetric } from "../unitJobMetrics";
import { syncWorkspaceRun } from "./auditSync";
import { assertTcReadyForUnitGen } from "./assertTcReadyForUnitGen";
import { decideUnitLanguageGate } from "./unitGenGates";
import {
  addArtifactToWorkspace,
  createUnitWorkspaceRun,
  saveManifest,
} from "./manager";
import { pushTimeline } from "./unitJobEvents";
import type { UnitWorkspaceManifest } from "./types";
import {
  canTransitionUnitJob,
  UNIT_JOB_TRANSITIONS,
} from "./unitJobState";

/** Optional unit gate knobs from `.ai-test/project.profile.json` (loose; schema may lag). */
async function loadUnitProfileGateKnobs(projectRoot: string): Promise<{
  domainGuards: UnitDomainGuardRule[];
  requireMarkers: boolean | null;
  unitScope: "backend" | "frontend" | "any";
  minAlignment: number;
}> {
  try {
    const { readTextFile } = await import("../../tauri/bridge");
    const raw = await readTextFile(projectRoot, ".ai-test/project.profile.json");
    const j = JSON.parse(raw) as {
      unit?: {
        domainGuards?: UnitDomainGuardRule[];
        requireMarkers?: boolean | string[];
        scope?: "backend" | "frontend" | "any";
        minAlignment?: number;
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
    return { domainGuards, requireMarkers, unitScope, minAlignment };
  } catch {
    return {
      domainGuards: [],
      requireMarkers: true,
      unitScope: "backend",
      minAlignment: 50,
    };
  }
}

function refuseCodeToDesktop(code: string | undefined): string {
  const map: Record<string, string> = {
    FAIL_NEEDS_MARKER: "needs_marker",
    FAIL_DOMAIN_GUARD: "domain_guard",
    FAIL_FEATURE_GAP: "feature_gap",
    FAIL_SUT_MISMATCH: "sut_mismatch",
  };
  return map[(code || "").toUpperCase()] || "sut_mismatch";
}

export { canTransitionUnitJob, UNIT_JOB_TRANSITIONS };
export type UnitJobRunnerDeps = {
  language?: string | null;
  framework?: string | null;
  broadLocalContext: boolean;
  sourceFiles: string[];
  codeAliases?: CodeAliasMap | null;
  requirementTitle?: string | null;
  onProgress?: (msg: string) => void;
};

export type UnitJobGenOk = {
  ok: true;
  runId: string;
  packagePrefix?: string;
  manifest: UnitWorkspaceManifest;
  writeRel: string;
  code: string;
  via: "ide-extension";
};

export type UnitJobGenFail = {
  ok: false;
  error: string;
  code?: string;
  cta?: "connect_ide" | "sync_md";
  manifest?: UnitWorkspaceManifest;
};

function isTransportError(e: unknown): boolean {
  const msg = (e instanceof Error ? e.message : String(e)).toLowerCase();
  return /websocket|ws\b|econnreset|econnrefused|disconnect|not connected|timed out|timeout|socket/.test(
    msg
  );
}

function newJobId(tcId: string): string {
  return `ujob-${tcId.slice(0, 8)}-${Date.now().toString(36)}`;
}

async function persist(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<UnitWorkspaceManifest> {
  await saveManifest(projectRoot, manifest);
  return manifest;
}

/**
 * Primary Unit Gen path — IDE Extension only (fail-closed).
 */
export async function startUnitIdeGenJob(opts: {
  projectRoot: string;
  projectId: string;
  tc: TestCase;
  deps: UnitJobRunnerDeps;
}): Promise<UnitJobGenOk | UnitJobGenFail> {
  const { projectRoot, projectId, tc, deps } = opts;
  const started = Date.now();
  const jobId = newJobId(tc.id);

  const gate = await assertTcReadyForUnitGen({ projectRoot, tc });
  if (!gate.ok) {
    recordUnitJobMetric({
      projectId,
      contextSource: "unknown",
      runnerUsed: "IDE_EXTENSION",
      ideConnected: isIdeCodegenReady(),
      jobId,
      via: "ide-extension",
      durationMs: Date.now() - started,
      failReason: gate.code,
      ok: false,
    });
    return {
      ok: false,
      error: gate.message,
      code: gate.code,
      cta: gate.cta,
    };
  }

  const langGate = decideUnitLanguageGate({
    language: deps.language,
    sourcePaths: deps.sourceFiles,
  });
  if (!langGate.ok) {
    recordUnitJobMetric({
      projectId,
      contextSource: "unknown",
      runnerUsed: "IDE_EXTENSION",
      ideConnected: isIdeCodegenReady(),
      jobId,
      via: "ide-extension",
      durationMs: Date.now() - started,
      failReason: langGate.code,
      ok: false,
    });
    return {
      ok: false,
      error: langGate.message,
      code: langGate.code,
    };
  }

  const packagePrefix = await resolvePackagePrefix(projectRoot, "");
  let manifest = await createUnitWorkspaceRun({
    projectRoot,
    projectId,
    testCaseId: tc.id,
    provider: "ide-extension",
    artifactKind: "unit",
    packagePrefix,
    jobId,
    via: "ide-extension",
    status: "generating",
  });
  manifest = {
    ...manifest,
    timeline: pushTimeline(manifest.timeline || [], "job.gen.started", gate.mdPath),
  };
  await persist(projectRoot, manifest);

  const unitProjectRules = await loadUnitProjectRules(
    projectRoot,
    UNIT_GEN_LIMITS.maxConventionsChars
  ).catch(() => "");
  let codeAliases = deps.codeAliases || null;
  if (!codeAliases || !Object.keys(codeAliases).length) {
    try {
      const { readTextFile } = await import("../../tauri/bridge");
      const raw = await readTextFile(projectRoot, ".ai-test/code-aliases.json");
      const parsed = JSON.parse(raw) as Record<string, string[]>;
      if (parsed && typeof parsed === "object") codeAliases = parsed;
    } catch {
      /* optional */
    }
  }
  let approvedTcMd = "";
  if (gate.ok && gate.mdPath) {
    try {
      const { readTextFile } = await import("../../tauri/bridge");
      approvedTcMd = (await readTextFile(projectRoot, gate.mdPath)).trim();
    } catch {
      approvedTcMd = "";
    }
  }
  const mdGrounding = approvedTcMd
    ? (await import("../approvedTcSync/approvedTcMarkdown")).parseApprovedTcGrounding(
        approvedTcMd
      )
    : null;
  const reqTitle =
    (deps.requirementTitle || "").trim() ||
    (mdGrounding?.requirement || "").trim() ||
    null;
  const feHint = suggestUnitTestPath({
    language: deps.language || "",
    framework: deps.framework === "auto" ? "" : deps.framework || "",
    sourceFileName: "Sut.ts",
    className: "",
    module: tc.module || undefined,
    requirementTitle: reqTitle,
    testCaseTitle: tc.title,
    packagePrefix,
  });
  let targetPath = uniquifyTestTargetRel(feHint.relativePath, tc.id);
  let contextPacket: unknown = undefined;
  let sutSourceFile = "";

  try {
    const paths =
      deps.sourceFiles.length > 0
        ? deps.sourceFiles
        : await ideListSourceFiles(
            projectRoot,
            sourceExtensionsForLanguage(deps.language || "")
          );
    const ctx = await buildGenerateContext({
      projectRoot,
      projectId,
      language: deps.language || "",
      framework: deps.framework === "auto" ? "" : deps.framework || "",
      testCase: tc,
      allSourcePaths: paths,
      manualPrimaryPath: null,
      forcedRelatedPaths: null,
      broadLocalContext: deps.broadLocalContext,
      codeAliases,
      approvedTcMd: approvedTcMd || null,
      requirementTitle: reqTitle,
      preferIndexContext: true,
      syncIndexIfMissing: true,
    });
    const impl = ctx.implementationPlan;
    if (impl && impl.status !== "ready") {
      const msg =
        `Implementation Planner: ${impl.status} cho «${tc.testCaseId || tc.title}». ` +
        `Thêm path: và code: vào Test Data (hoặc .ai-test/code-aliases.json) trỏ đúng production unit, Approve lại, rồi Gen.`;
      manifest = {
        ...manifest,
        status: "gen_failed",
        timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
      };
      await persist(projectRoot, manifest);
      recordUnitJobMetric({
        projectId,
        contextSource: ctx.contextSource || "implementation-plan",
        runnerUsed: "IDE_EXTENSION",
        ideConnected: true,
        jobId,
        via: "ide-extension",
        durationMs: Date.now() - started,
        failReason: "needs_marker",
        ok: false,
      });
      return { ok: false, error: msg, code: "needs_marker", manifest };
    }
    contextPacket = ctx.packetForApi;
    let primaryRel = (ctx.primaryPath || "").replace(/\\/g, "/");
    // P0/P1: prefer planner entry / marker path — never I* for suggestedPath
    const markerPaths = extractTcSourceMarkers(
      [approvedTcMd, tc.testData].filter(Boolean).join("\n")
    ).paths;
    if (impl?.entry?.pathRel) {
      primaryRel = impl.entry.pathRel.replace(/\\/g, "/");
    } else if (markerPaths[0]) {
      primaryRel = markerPaths[0].replace(/\\/g, "/");
    }
    if (primaryRel && isInterfaceLikePrimaryPath(primaryRel) && impl?.entry?.pathRel) {
      primaryRel = impl.entry.pathRel.replace(/\\/g, "/");
    }
    if (primaryRel) {
      sutSourceFile = primaryRel;
      let className =
        impl?.entry?.symbol ||
        ctx.packet.sourceUnderTest?.symbol ||
        stemOfPath(primaryRel) ||
        "";
      if (/^I[A-Z]/.test(className) && impl?.entry?.symbol && !/^I[A-Z]/.test(impl.entry.symbol)) {
        className = impl.entry.symbol;
      } else if (/^I[A-Z]/.test(className)) {
        className = stemOfPath(primaryRel);
      }
      const grounded = suggestUnitTestPath({
        language: deps.language || "",
        framework: deps.framework === "auto" ? "" : deps.framework || "",
        sourceFileName: primaryRel,
        className,
        module: tc.module || undefined,
        requirementTitle: reqTitle,
        testCaseTitle: tc.title,
        packagePrefix,
      });
      targetPath = uniquifyTestTargetRel(grounded.relativePath, tc.id);
    }

    // Force packet primary = planner/marker impl BEFORE gate (path+excerpt must agree).
    if (contextPacket && primaryRel) {
      contextPacket = await forcePacketPrimary({
        packet: contextPacket as AITestContextPacket,
        primaryRel,
        projectRoot,
        readFile: ideReadFile,
      });
      const forced = (contextPacket as AITestContextPacket).files.find(
        (f) => f.role === "primary"
      );
      if (forced?.pathRel) {
        primaryRel = forced.pathRel;
        sutSourceFile = forced.pathRel;
      }
    }

    // Phase 5 — Desktop hard-gate before Extension Gen (always; unresolved → no CLI).
    const packet = contextPacket as AITestContextPacket | undefined;
    const primary = packet
      ? packet.files.find((f) => f.role === "primary") || primaryFile(packet)
      : undefined;
    const primaryPath = (primaryRel || primary?.pathRel || "").replace(/\\/g, "/");
    const excerpt = (primary?.content || "").trim();
    const knobs = await loadUnitProfileGateKnobs(projectRoot);
    const tcBlob = [
      approvedTcMd,
      tc.title,
      tc.module,
      tc.testData,
      tc.steps,
      tc.expectedResult,
    ]
      .filter(Boolean)
      .join("\n");
    const sutGate = decideUnitSutGate({
      tcText: tcBlob,
      primaryPath: primaryPath || null,
      sourceExcerpt: excerpt || null,
      codeAliases,
      moduleText: [tc.module, tc.title, (approvedTcMd || "").slice(0, 1500)]
        .filter(Boolean)
        .join("\n"),
      domainGuards: knobs.domainGuards,
      // Phase 5 default: path:+code: required unless profile explicitly disables
      requireMarkers: knobs.requireMarkers !== false,
      unitScope: knobs.unitScope,
      minAlignment: knobs.minAlignment,
    });
    if (sutGate.decision === "block") {
      const code = sutGate.code || "FAIL_NEEDS_MARKER";
      const msg =
        `${code} — ${sutGate.reason}. ` +
        `Thêm path:/code: đúng domain, Approve lại, rồi Gen.`;
      // Strip poisoned packet so we never ship wrong primary to Extension.
      contextPacket = undefined;
      sutSourceFile = "";
      manifest = {
        ...manifest,
        status: "gen_failed",
        failReason: msg,
        timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
      };
      await persist(projectRoot, manifest);
      recordUnitJobMetric({
        projectId,
        contextSource: ctx.contextSource || "desktop-sut-gate",
        runnerUsed: "IDE_EXTENSION",
        ideConnected: true,
        jobId,
        via: "ide-extension",
        durationMs: Date.now() - started,
        failReason: refuseCodeToDesktop(code),
        ok: false,
      });
      return {
        ok: false,
        error: msg,
        code: refuseCodeToDesktop(code),
        manifest,
      };
    }
  } catch {
    /* Extension resolves SUT from disk + TC MD — still blocked by Extension Phase 5 gate */
  }

  deps.onProgress?.("IDE Unit Gen…");

  let ide = null as Awaited<ReturnType<typeof tryExtensionGenerateUnitBatch>>;
  try {
    ide = await tryExtensionGenerateUnitBatch({
      projectId,
      projectRoot,
      packagePrefix,
      projectRules: unitProjectRules,
      projectRulesSource: unitProjectRules ? "unit-conventions" : "none",
      codeAliases,
      items: [
        {
          testCaseId: tc.testCaseId || tc.id,
          title: tc.title,
          module: tc.module || undefined,
          suggestedPath: targetPath,
          steps: tc.steps || undefined,
          expectedOutcome: tc.expectedResult || undefined,
          testData: tc.testData || undefined,
          contextPacket,
        },
      ],
      handlers: {
        onProgress: (p) => {
          const msg = p.message || p.phase || "";
          deps.onProgress?.(msg);
          const event =
            /context_truncated/i.test(msg)
              ? ("job.gen.context_truncated" as const)
              : ("job.gen.progress" as const);
          void (async () => {
            const m = {
              ...manifest,
              timeline: pushTimeline(manifest.timeline || [], event, msg),
            };
            manifest = m;
            await persist(projectRoot, m).catch(() => {});
          })();
        },
      },
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const transport = isTransportError(e);
    manifest = {
      ...manifest,
      status: "gen_failed",
      failReason: msg,
      timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
    };
    await persist(projectRoot, manifest);
    recordUnitJobMetric({
      projectId,
      contextSource: "ide-extension",
      runnerUsed: "IDE_EXTENSION",
      ideConnected: true,
      jobId,
      via: "ide-extension",
      durationMs: Date.now() - started,
      failReason: transport ? "transport" : "gen_failed",
      ok: false,
    });
    return {
      ok: false,
      error: msg,
      code: transport ? "transport" : "gen_failed",
      manifest,
    };
  }

  if (!ide) {
    const msg =
      "IDE bridge không phản hồi. Kiểm tra Connect IDE (Dự án) rồi Gen lại.";
    manifest = {
      ...manifest,
      status: "gen_failed",
      failReason: msg,
      timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
    };
    await persist(projectRoot, manifest);
    return { ok: false, error: msg, code: "no_ide", cta: "connect_ide", manifest };
  }

  manifest = {
    ...manifest,
    commandId: ide.commandId,
  };

  if (ide.status === "CANCELLED") {
    const msg = "Gen bị huỷ (codegen.cancel)";
    manifest = {
      ...manifest,
      status: "discarded",
      failReason: msg,
      timeline: pushTimeline(manifest.timeline || [], "job.cancelled", msg),
    };
    await persist(projectRoot, manifest);
    return { ok: false, error: msg, code: "cancelled", manifest };
  }

  const draft =
    ide.files?.find((f) => (f.content || "").trim()) || ide.files?.[0];
  const ideSut =
    (ide.perTc || []).find((p) => p.testCaseId === (tc.testCaseId || tc.id))
      ?.sourceFileName ||
    (ide.perTc || []).find((p) => p.sourceFileName)?.sourceFileName ||
    "";
  const sourceForRewrite = (ideSut || sutSourceFile || "").replace(/\\/g, "/");

  if (
    !(ide.status === "COMPLETED" || ide.status === "PARTIAL") ||
    !draft?.content?.trim()
  ) {
    const msg =
      ide.error ||
      (ide.perTc || []).map((p) => p.error).filter(Boolean).join("; ") ||
      "IDE Unit Gen failed";
    const refuse = (msg.match(/FAIL_(NEEDS_MARKER|DOMAIN_GUARD|FEATURE_GAP|SUT_MISMATCH)/i) ||
      [])[0];
    const failCode = refuse
      ? refuse.toUpperCase().replace(/^FAIL_/, "").toLowerCase()
      : "gen_failed";
    // Map to stable Desktop codes: needs_marker | domain_guard | feature_gap | sut_mismatch | gen_failed
    const codeMap: Record<string, string> = {
      needs_marker: "needs_marker",
      domain_guard: "domain_guard",
      feature_gap: "feature_gap",
      sut_mismatch: "sut_mismatch",
    };
    const code = codeMap[failCode] || "gen_failed";
    manifest = {
      ...manifest,
      status: "gen_failed",
      failReason: msg,
      sourceFileName: sourceForRewrite || undefined,
      timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
    };
    await persist(projectRoot, manifest);
    recordUnitJobMetric({
      projectId,
      contextSource: "ide-extension",
      runnerUsed: "IDE_EXTENSION",
      ideConnected: true,
      jobId,
      via: "ide-extension",
      commandId: ide.commandId,
      durationMs: Date.now() - started,
      failReason: code,
      ok: false,
    });
    return { ok: false, error: msg, code, manifest };
  }

  if (!sourceForRewrite || sourceForRewrite === "unknown-sut") {
    const msg =
      "Thiếu sourceFileName sau Gen — Extension phải trả SUT path. Không stage.";
    manifest = {
      ...manifest,
      status: "gen_failed",
      failReason: msg,
      timeline: pushTimeline(manifest.timeline || [], "job.gen.failed", msg),
    };
    await persist(projectRoot, manifest);
    return { ok: false, error: msg, code: "no_sut", manifest };
  }

  const layoutModule = buildRequirementTcModule(reqTitle, tc.title, tc.module);
  const writeRel = (() => {
    try {
      return uniquifyTestTargetRel(
        assertSafeAitestTargetRel(draft.path || targetPath),
        tc.id
      );
    } catch {
      return targetPath;
    }
  })();

  manifest = {
    ...manifest,
    sourceFileName: sourceForRewrite,
    status: "generating",
    timeline: pushTimeline(
      manifest.timeline || [],
      "job.gen.completed",
      writeRel
    ),
  };
  await persist(projectRoot, manifest);

  const added = await addArtifactToWorkspace({
    projectRoot,
    manifest,
    targetRel: writeRel,
    content: draft.content,
    module: layoutModule,
  });
  manifest = added.manifest;
  syncWorkspaceRun(manifest, { module: layoutModule, status: "generated" });
  const perMetrics =
    (ide.perTc || []).find((p) => p.testCaseId === (tc.testCaseId || tc.id))
      ?.metrics ||
    (ide.perTc || []).find((p) => p.metrics)?.metrics;
  recordUnitJobMetric({
    projectId,
    contextSource: "implementation-plan",
    runnerUsed: "IDE_EXTENSION",
    ideConnected: true,
    jobId,
    via: "ide-extension",
    commandId: ide.commandId,
    durationMs: Date.now() - started,
    ok: true,
    contextSize: perMetrics?.contextSize ?? null,
    retrievedFiles: perMetrics?.retrievedFiles ?? null,
    promptTokens: perMetrics?.promptTokens ?? null,
    promptChars: perMetrics?.promptChars ?? null,
    cliTimeMs: perMetrics?.cliTimeMs ?? null,
  });

  return {
    ok: true,
    runId: manifest.runId,
    packagePrefix: manifest.packagePrefix,
    manifest,
    writeRel,
    code: draft.content,
    via: "ide-extension",
  };
}

/** Map codegen.cancel → discarded / gen_failed on an in-flight job. */
export async function cancelUnitGenJob(opts: {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
  reason?: string;
}): Promise<UnitWorkspaceManifest> {
  const commandId = opts.manifest.commandId;
  if (commandId) {
    try {
      await cancelExtensionCodegen(commandId);
    } catch {
      /* best-effort */
    }
  }
  const reason = opts.reason || "cancelled by user";
  const next: UnitWorkspaceManifest = {
    ...opts.manifest,
    status: opts.manifest.status === "generating" ? "discarded" : "gen_failed",
    failReason: reason,
    timeline: pushTimeline(
      opts.manifest.timeline || [],
      "job.cancelled",
      reason
    ),
  };
  await saveManifest(opts.projectRoot, next);
  return next;
}

export function appendJobTimeline(
  manifest: UnitWorkspaceManifest,
  event: Parameters<typeof pushTimeline>[1],
  detail?: string
): UnitWorkspaceManifest {
  return {
    ...manifest,
    timeline: pushTimeline(manifest.timeline || [], event, detail),
  };
}

/** Valid status transitions (subset used by orchestrator). */
export function isIdeConnectedForUnit(): boolean {
  return Boolean(getIdeRpcClientOrNull()?.isConnected);
}
