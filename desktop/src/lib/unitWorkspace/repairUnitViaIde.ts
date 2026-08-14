/**
 * Unit Repair via Extension → Cursor AI CLI (same engine as Gen).
 * AITest orchestrates only — no API /generate-unit UUTGS path for Unit Repair.
 */
import { ensureCursorAgentReady } from "../aiCli/gate";
import type { CodegenUnitItem } from "@aitest/ide-protocol";
import type { UnitWorkspaceManifest } from "./types";
import { tryExtensionGenerateUnitBatch } from "../ideProtocol/phaseBGen";
import { addArtifactToWorkspace } from "./manager";
import { loadUnitProjectRules } from "../ideLocalCommands";

export type UnitIdeRepairInput = {
  projectRoot: string;
  projectId: string;
  testCaseId: string;
  title: string;
  module?: string | null;
  /** Failing test path under AItest/ */
  targetRel: string;
  /** Current failing test content */
  failingTestContent: string;
  repairContext: string;
  /** SUT primary from packet / markers */
  primaryPath?: string | null;
  primaryContent?: string | null;
  packagePrefix?: string | null;
  testData?: string | null;
  steps?: string | null;
  expectedOutcome?: string | null;
  contextPacket?: unknown;
  codeAliases?: Record<string, string[]> | null;
};

export type UnitIdeRepairResult =
  | { ok: true; code: string; manifest: UnitWorkspaceManifest }
  | { ok: false; error: string; cta?: "connect_ide" };

/**
 * Repair one Unit staging file via IDE Extension CLI.
 */
export async function repairUnitViaIdeExtension(opts: {
  input: UnitIdeRepairInput;
  manifest: UnitWorkspaceManifest;
}): Promise<UnitIdeRepairResult> {
  const { input, manifest } = opts;
  let projectRules = "";
  try {
    projectRules = await loadUnitProjectRules(input.projectRoot);
  } catch {
    projectRules = "";
  }

  const item: CodegenUnitItem = {
    testCaseId: input.testCaseId,
    title: input.title,
    module: input.module || undefined,
    suggestedPath: input.targetRel,
    testData: input.testData || undefined,
    steps: input.steps || undefined,
    expectedOutcome: input.expectedOutcome || undefined,
    contextPacket: input.contextPacket,
    repairContext: input.repairContext,
    existingFiles: [
      {
        path: input.targetRel,
        content: input.failingTestContent,
        kind: "unit",
      },
    ],
  };

  let agentExecutable: string | undefined;
  try {
    const cli = await ensureCursorAgentReady();
    agentExecutable = cli.executablePath?.trim() || undefined;
  } catch (e) {
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  }

  const result = await tryExtensionGenerateUnitBatch({
    projectId: input.projectId,
    projectRoot: input.projectRoot,
    projectRules,
    projectRulesSource: projectRules ? "unit-conventions" : "none",
    packagePrefix: input.packagePrefix || undefined,
    items: [item],
    codeAliases: input.codeAliases,
    agentExecutable,
  });

  if (!result) {
    return {
      ok: false,
      error:
        "IDE chưa Connect — Repair Unit cần Extension + AI CLI (không dùng API /generate-unit).",
      cta: "connect_ide",
    };
  }

  const per = result.perTc?.find((p) => p.testCaseId === input.testCaseId);
  const file =
    result.files?.find((f) =>
      (f.path || "").replace(/\\/g, "/").endsWith(input.targetRel.replace(/\\/g, "/"))
    ) || result.files?.[0];

  if (!per?.genOk || !file?.content?.trim()) {
    return {
      ok: false,
      error:
        per?.error ||
        result.workspaceTree?.generatedFiles?.find((g) => g.error)?.error ||
        "Extension Repair không trả về code test.",
    };
  }

  const added = await addArtifactToWorkspace({
    projectRoot: input.projectRoot,
    manifest: {
      ...manifest,
      repairAttempts: (manifest.repairAttempts ?? 0) + 1,
    },
    targetRel: input.targetRel,
    content: file.content,
  });

  return { ok: true, code: file.content, manifest: added.manifest };
}
