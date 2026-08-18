/**
 * UnitJobRunner — Desktop orchestrates Gen lifecycle only.
 * Extension + Cursor CLI own Unit code Gen (fail-closed; no API Gen fallback).
 * Page must call this for Unit Gen — not generateUnit.run
 * (API /generate-unit is legacy; Unit Repair also uses Extension CLI).
 */
import {
  UNIT_GEN_LIMITS,
  assertSafeAitestTargetRel,
  extractTcSourceMarkers,
  stemOfPath,
} from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { ensureCursorAgentReady } from "../aiCli/gate";
import {
  isIdeCodegenReady,
  tryExtensionGenerateUnitBatch,
  cancelExtensionCodegen,
} from "../ideProtocol";
import { getIdeRpcClientOrNull } from "../ideBridge/session";
import {
  ideReadFile,
  loadUnitProjectRules,
} from "../ideLocalCommands";
import { forcePacketPrimary } from "../contextPacket/forcePacketPrimary";
import type { AITestContextPacket } from "../contextPacket/types";
import {
  buildPacketFromUnitGrounding,
  isUnitGroundingFastPathEligible,
  parseUnitSourceGroundingContract,
} from "./groundingFastPath";
import { unitGroundingContractRelPath } from "../approvedTcSync/unitSourceGroundingContract";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  buildRequirementTcModule,
  uniquifyKeyForTestCase,
  uniquifyTestTargetRel,
} from "../testOutputLayout";
import { suggestUnitTestPath } from "../stackHints";
import type { CodeAliasMap } from "../projectIntelligence/viCodeAliases";
import { loadUnitEnrichProfileKnobs } from "../approvedTcSync/loadUnitEnrichProfile";
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

const GAP_FALLBACK_MARKER_RE = /AITEST_FALLBACK_GAP/i;

function buildGapCompanionMarkdown(input: {
  tc: TestCase;
  sourceFileName: string;
  failReason: string;
  mode: "strict_spec" | "always_generate";
}): string {
  const tcCode = input.tc.testCaseId || input.tc.id;
  return [
    `# Unit Gen Gap Note — ${tcCode}`,
    "",
    `- mode: ${input.mode}`,
    `- source: ${input.sourceFileName || "unknown-sut"}`,
    `- fallbackFrom: ${tcCode}`,
    `- reason: ${input.failReason || "FEATURE_GAP"}`,
    "",
    "## TODO",
    `- Backend behavior missing/incomplete for TC «${input.tc.title}».`,
    "- Keep test as gap fallback (`test.skip` / trait Gap) until source implements expected behavior.",
    "",
  ].join("\n");
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
    // Consume-only: Desktop never soft-bypasses a missing/stale Approve decision.
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

  let agentExecutable: string | undefined;

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
  // Profile disk aliases win over potentially stale API project meta.
  const enrichProfile = await loadUnitEnrichProfileKnobs(projectRoot).catch(
    () => null
  );
  let codeAliases =
    enrichProfile?.codeAliases &&
    Object.keys(enrichProfile.codeAliases).length
      ? enrichProfile.codeAliases
      : deps.codeAliases || null;
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
  let targetPath = uniquifyTestTargetRel(feHint.relativePath, uniquifyKeyForTestCase(tc));
  let contextPacket: unknown = undefined;
  let sutSourceFile = "";
  let contextSource = "unknown";

  try {
    const mdMarkersEarly = extractTcSourceMarkers(
      [approvedTcMd, tc.testData].filter(Boolean).join("\n")
    );
    let groundingContract = null as ReturnType<
      typeof parseUnitSourceGroundingContract
    >;
    if (gate.ok && gate.mdPath) {
      try {
        const { readTextFile } = await import("../../tauri/bridge");
        const gRel = unitGroundingContractRelPath(gate.mdPath);
        const raw = await readTextFile(projectRoot, gRel);
        groundingContract = parseUnitSourceGroundingContract(raw);
      } catch {
        groundingContract = null;
      }
    }

    let primaryRel = "";

    const groundingEligible = isUnitGroundingFastPathEligible(
      groundingContract,
      mdMarkersEarly
    );
    if (groundingContract?.authoritative === true && !groundingEligible) {
      const message =
        "STALE_APPROVE_DECISION — grounding contract/markers invalid; Re-Approve required";
      manifest = {
        ...manifest,
        status: "gen_failed",
        failReason: message,
        timeline: pushTimeline(
          manifest.timeline || [],
          "job.gen.failed",
          message
        ),
      };
      await persist(projectRoot, manifest);
      return {
        ok: false,
        error: message,
        code: "stale_approve_decision",
      };
    }
    if (groundingEligible && groundingContract) {
      const built = await buildPacketFromUnitGrounding({
        projectRoot,
        projectId,
        testCaseId: tc.id,
        language: deps.language || "",
        framework: deps.framework === "auto" ? "" : deps.framework || "",
        module: tc.module,
        contract: groundingContract,
        readFile: ideReadFile,
        targetProperty:
          [approvedTcMd, tc.testData]
            .filter(Boolean)
            .join("\n")
            .match(/^\s*target\.property\s*:\s*(\S+)/im)?.[1] || null,
      });
      if (built) {
        contextPacket = built.packet;
        contextSource = "grounding-contract";
        primaryRel = built.primaryPath;
        sutSourceFile = primaryRel;
        deps.onProgress?.(
          `grounding fast-path → ${primaryRel} (skip index retrieve/plan)`
        );
        const className =
          groundingContract.primary.typeName || stemOfPath(primaryRel) || "";
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
        targetPath = uniquifyTestTargetRel(grounded.relativePath, uniquifyKeyForTestCase(tc));
      } else if (groundingContract?.authoritative === true) {
        const message =
          "STALE_APPROVE_DECISION — source missing or content hash changed; Re-Approve required";
        manifest = {
          ...manifest,
          status: "gen_failed",
          failReason: message,
          timeline: pushTimeline(
            manifest.timeline || [],
            "job.gen.failed",
            message
          ),
        };
        await persist(projectRoot, manifest);
        return {
          ok: false,
          error: message,
          code: "stale_approve_decision",
        };
      }
    }

    if (!contextPacket) {
      const message =
        "MISSING_APPROVE_DECISION — Unit Gen requires an authoritative IDE Approve decision; Re-Approve required";
      manifest = {
        ...manifest,
        status: "gen_failed",
        failReason: message,
        timeline: pushTimeline(
          manifest.timeline || [],
          "job.gen.failed",
          message
        ),
      };
      await persist(projectRoot, manifest);
      return {
        ok: false,
        error: message,
        code: "missing_approve_decision",
        manifest,
      };
    }

    // Force packet primary from Approve Decision before Gen.
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

    // Consume-only: never re-resolve/reclassify when Decision is authoritative.
    if (contextSource === "grounding-contract") {
      deps.onProgress?.(
        "grounding Decision authoritative — skip Gen replan/reclassify gate"
      );
    } else {
      const message =
        "MISSING_APPROVE_DECISION — Gen no longer re-resolves SUT; Re-Approve required";
      manifest = {
        ...manifest,
        status: "gen_failed",
        failReason: message,
        timeline: pushTimeline(
          manifest.timeline || [],
          "job.gen.failed",
          message
        ),
      };
      await persist(projectRoot, manifest);
      return {
        ok: false,
        error: message,
        code: "missing_approve_decision",
        manifest,
      };
    }
  } catch {
    /* Grounding load/build errors fall through; missing packet fails closed below. */
  }

  // Probe CLI only after deterministic grounding/gates pass. Invalid TC/SUT
  // now fails immediately instead of paying version + auth subprocess latency.
  try {
    const cli = await ensureCursorAgentReady();
    agentExecutable = cli.executablePath?.trim() || undefined;
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    manifest = {
      ...manifest,
      status: "gen_failed",
      failReason: msg,
      timeline: pushTimeline(
        manifest.timeline || [],
        "job.gen.failed",
        "ai_cli_not_ready"
      ),
    };
    await persist(projectRoot, manifest);
    recordUnitJobMetric({
      projectId,
      contextSource,
      runnerUsed: "IDE_EXTENSION",
      ideConnected: isIdeCodegenReady(),
      jobId,
      via: "ide-extension",
      durationMs: Date.now() - started,
      failReason: "ai_cli_not_ready",
      ok: false,
    });
    return { ok: false, error: msg, code: "ai_cli_not_ready", manifest };
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
      agentExecutable,
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
  const fallbackGapUsed = GAP_FALLBACK_MARKER_RE.test(draft?.content || "");

  if (
    !(ide.status === "COMPLETED" || ide.status === "PARTIAL") ||
    !draft?.content?.trim()
  ) {
    const msg =
      ide.error ||
      (ide.perTc || []).map((p) => p.error).filter(Boolean).join("; ") ||
      "IDE Unit Gen failed";
    const refuse =
      (msg.match(
        /\b(MISSING_APPROVE_DECISION|STALE_APPROVE_DECISION|INVALID_APPROVE_DECISION|FAIL_(DOMAIN_GUARD|FEATURE_GAP|SUT_MISMATCH))\b/i
      ) || [])[0];
    const failCode = refuse
      ? refuse.toUpperCase().replace(/^FAIL_/, "").toLowerCase()
      : "gen_failed";
    const codeMap: Record<string, string> = {
      missing_approve_decision: "missing_decision",
      stale_approve_decision: "stale_decision",
      invalid_approve_decision: "invalid_decision",
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
        uniquifyKeyForTestCase(tc)
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
  if (fallbackGapUsed) {
    const gapRel = writeRel.replace(/\.[^.\/\\]+$/, ".gap.md");
    try {
      const gapAdded = await addArtifactToWorkspace({
        projectRoot,
        manifest,
        targetRel: gapRel,
        content: buildGapCompanionMarkdown({
          tc,
          sourceFileName: sourceForRewrite,
          failReason: "FEATURE_GAP fallback in always_generate mode",
          mode: "always_generate",
        }),
        module: layoutModule,
      });
      manifest = {
        ...gapAdded.manifest,
        status: "gen_with_gap",
        failReason: "gen_with_gap: FEATURE_GAP fallback",
        timeline: pushTimeline(
          gapAdded.manifest.timeline || [],
          "job.gen.completed",
          "fallback companion gap file"
        ),
      };
      await persist(projectRoot, manifest);
    } catch {
      manifest = {
        ...manifest,
        status: "gen_with_gap",
        failReason: "gen_with_gap: FEATURE_GAP fallback",
      };
      await persist(projectRoot, manifest);
    }
  }
  syncWorkspaceRun(manifest, {
    module: layoutModule,
    status: fallbackGapUsed ? "gen_with_gap" : "generated",
  });
  const perMetrics =
    (ide.perTc || []).find((p) => p.testCaseId === (tc.testCaseId || tc.id))
      ?.metrics ||
    (ide.perTc || []).find((p) => p.metrics)?.metrics;
  recordUnitJobMetric({
    projectId,
    contextSource: contextSource || "implementation-plan",
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
