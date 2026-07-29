/**
 * EX3 — E2E staging under `.ai-test/workspace/{runId}/` → Apply `AItest/E2ETest/…` → cleanup.
 * Choice: staging-first + Apply confirm (sandbox may write AItest for heal; FE rolls back then Apply).
 */
import { readTextFile, writeTextFile, deleteTextFile, isTauri } from "../../tauri/bridge";
import {
  overlayRelPath,
  workspaceRunDir,
  aiTestDir,
} from "../unitWorkspace/paths";
import { cleanupWorkspaceRunAfterApply } from "../unitWorkspace/cleanup";
import type { StagingBackup } from "../unitWorkspace/types";
import {
  assertSafeAitestTargetRel,
  coerceAitestApplyPath,
} from "../testOutputLayout";
import { audit } from "../../api";
import type { E2EFileDto } from "../../api";

export type E2eStagedFile = {
  targetRel: string;
  workspaceRel: string;
  content: string;
  kind: string;
};

export type E2eStagingSession = {
  runId: string;
  projectId: string;
  testCaseId: string;
  module?: string | null;
  packagePrefix?: string | null;
  files: E2eStagedFile[];
  backups: StagingBackup[];
  primarySpecPath?: string;
};

function norm(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function assertE2eTarget(targetRel: string): string {
  const p = assertSafeAitestTargetRel(targetRel);
  const low = p.toLowerCase().split("/");
  if (!low.includes("e2etest")) {
    throw new Error(`Path jail E2E: chỉ ghi dưới AItest/E2ETest/ (got ${p})`);
  }
  return p;
}

export function newE2eRunId(testCaseId: string): string {
  const short = testCaseId.replace(/-/g, "").slice(0, 8);
  return `e2e-${short}-${Date.now()}`;
}

/** Coerce + jail generated paths into staging entries. */
export function buildE2eStagedFiles(
  files: E2EFileDto[],
  opts: {
    runId: string;
    module?: string | null;
    packagePrefix?: string | null;
  }
): E2eStagedFile[] {
  return files.map((f) => {
    const coerced = coerceAitestApplyPath(norm(f.path), {
      kind: "e2e",
      module: opts.module,
      packagePrefix: opts.packagePrefix,
    });
    const targetRel = assertE2eTarget(coerced);
    return {
      targetRel,
      workspaceRel: overlayRelPath(opts.runId, targetRel, opts.packagePrefix),
      content: f.content,
      kind: f.kind,
    };
  });
}

export async function writeE2eOverlay(
  projectRoot: string,
  session: E2eStagingSession
): Promise<void> {
  if (!isTauri()) {
    throw new Error("Staging E2E cần Desktop (Tauri).");
  }
  for (const f of session.files) {
    await writeTextFile(projectRoot, f.workspaceRel, f.content);
  }
  const manifestRel = `${workspaceRunDir(session.runId, session.packagePrefix)}/manifest.e2e.json`;
  await writeTextFile(
    projectRoot,
    manifestRel,
    JSON.stringify(
      {
        version: 1,
        runId: session.runId,
        projectId: session.projectId,
        testCaseId: session.testCaseId,
        module: session.module,
        status: "generated",
        files: session.files.map((f) => ({
          targetRel: f.targetRel,
          workspaceRel: f.workspaceRel,
          kind: f.kind,
        })),
        primarySpecPath: session.primarySpecPath,
        createdAt: new Date().toISOString(),
      },
      null,
      2
    )
  );
}

async function fileExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

/** Snapshot AItest targets before Headless writes. */
export async function captureE2eBackups(
  projectRoot: string,
  files: E2eStagedFile[]
): Promise<StagingBackup[]> {
  const backups: StagingBackup[] = [];
  for (const f of files) {
    const exists = await fileExists(projectRoot, f.targetRel);
    let previousContent: string | null = null;
    if (exists) {
      try {
        previousContent = await readTextFile(projectRoot, f.targetRel);
      } catch {
        previousContent = "";
      }
    }
    backups.push({ targetRel: f.targetRel, previousContent });
  }
  return backups;
}

/** Restore AItest targets after Headless (sandbox writeFile) — staging remains. */
export async function rollbackE2eTargets(
  projectRoot: string,
  backups: StagingBackup[]
): Promise<void> {
  for (const b of backups) {
    if (b.previousContent === null) {
      try {
        await deleteTextFile(projectRoot, b.targetRel);
      } catch {
        /* ignore */
      }
    } else {
      await writeTextFile(projectRoot, b.targetRel, b.previousContent);
    }
  }
}

/** Update overlay contents after heal (sandbox returned new files). */
export async function refreshE2eOverlayFromFiles(
  projectRoot: string,
  session: E2eStagingSession,
  files: E2EFileDto[]
): Promise<E2eStagingSession> {
  const nextFiles = buildE2eStagedFiles(files, {
    runId: session.runId,
    module: session.module,
    packagePrefix: session.packagePrefix,
  });
  const next: E2eStagingSession = { ...session, files: nextFiles };
  await writeE2eOverlay(projectRoot, next);
  return next;
}

export type ApplyE2eResult = {
  appliedPaths: string[];
  stagingCleaned: boolean;
};

/**
 * EX3 Apply — copy overlay → AItest/E2ETest (path jail) → cleanup staging.
 */
export async function applyE2eStaging(
  projectRoot: string,
  session: E2eStagingSession
): Promise<ApplyE2eResult> {
  if (!isTauri()) {
    throw new Error("Apply E2E cần Desktop (Tauri).");
  }
  if (!session.files.length) {
    throw new Error("Không có file trong staging.");
  }

  const applied: string[] = [];
  const backups = await captureE2eBackups(projectRoot, session.files);

  try {
    for (const f of session.files) {
      const targetRel = assertE2eTarget(f.targetRel);
      const content = await readTextFile(projectRoot, f.workspaceRel);
      await writeTextFile(projectRoot, targetRel, content);
      applied.push(targetRel);
    }

    // Audit apply
    void audit
      .postApplyAudit({
        projectId: session.projectId,
        localRunId: session.runId,
        testType: "e2e",
        testCaseId: session.testCaseId,
        filesApplied: applied,
        success: true,
      })
      .catch(() => undefined);

    void audit
      .upsertWorkspaceRun({
        projectId: session.projectId,
        localRunId: session.runId,
        testType: "e2e",
        testCaseId: session.testCaseId,
        module: session.module ?? undefined,
        status: "applied",
        contextSource: "e2e-console",
      })
      .catch(() => undefined);

    let stagingCleaned = false;
    try {
      await cleanupWorkspaceRunAfterApply(
        projectRoot,
        session.runId,
        session.packagePrefix
      );
      stagingCleaned = true;
    } catch {
      /* Apply OK — staging cleanup best-effort */
    }

    return { appliedPaths: applied, stagingCleaned };
  } catch (e) {
    for (const rel of applied) {
      const b = backups.find((x) => x.targetRel === rel);
      if (!b) continue;
      if (b.previousContent === null) {
        try {
          await deleteTextFile(projectRoot, rel);
        } catch {
          /* ignore */
        }
      } else {
        await writeTextFile(projectRoot, rel, b.previousContent);
      }
    }
    throw e;
  }
}

export function stagingDirHint(runId: string, packagePrefix?: string | null): string {
  return workspaceRunDir(runId, packagePrefix);
}

export function e2eAiTestDir(packagePrefix?: string | null): string {
  return aiTestDir(packagePrefix);
}
