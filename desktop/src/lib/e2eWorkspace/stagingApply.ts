/**
 * EX3 — E2E staging under `.ai-test/workspace/{runId}/` → Apply `AItest/E2ETest/…` → cleanup.
 * Choice: staging-first + Apply confirm (sandbox may write AItest for heal; FE rolls back then Apply).
 */
import { readTextFile, writeTextFile, deleteTextFile, deleteDir, isTauri } from "../../tauri/bridge";
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
  compiledAitestArtifactRels,
  emptyAitestParentRels,
} from "../testOutputLayout";
import { audit } from "../../api";
import type { E2EFileDto } from "../../api";
import { ideApplyFiles, isIdeCodegenReady, rememberCodegenResult } from "../ideProtocol";

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

/**
 * Write overlay under a fixed runId. If `previous` has a different runId, delete that
 * staging folder first — prevents orphan `.ai-test/staging/e2e-*` trees that accumulate
 * every TC during batch generate (Unit uses one runId per job; E2E must match).
 */
export async function writeE2eOverlayReplacingPrevious(
  projectRoot: string,
  session: E2eStagingSession,
  previous: E2eStagingSession | null | undefined
): Promise<void> {
  if (
    previous &&
    previous.runId &&
    previous.runId !== session.runId
  ) {
    try {
      await cleanupWorkspaceRunAfterApply(
        projectRoot,
        previous.runId,
        previous.packagePrefix
      );
    } catch {
      /* best-effort */
    }
  }
  await writeE2eOverlay(projectRoot, session);
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
      // Unit-like: keep AI layout; do not rebuild from basename (duplicate folders).
      preserveLayout: true,
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
  if (!isTauri() && !isIdeCodegenReady()) {
    throw new Error("Apply E2E cần Desktop (Tauri) hoặc IDE Extension bridge.");
  }
  if (!session.files.length) {
    throw new Error("Không có file trong staging.");
  }

  const applied: string[] = [];
  const backups = await captureE2eBackups(projectRoot, session.files);

  try {
    // Phase A: prefer IDE Extension apply when bridge is connected.
    if (isIdeCodegenReady()) {
      const files: { path: string; content: string; kind: string }[] = [];
      for (const f of session.files) {
        const targetRel = assertE2eTarget(f.targetRel);
        const content = await readTextFile(projectRoot, f.workspaceRel);
        files.push({ path: targetRel, content, kind: f.kind || "spec" });
      }
      const ideResult = await ideApplyFiles({
        projectId: session.projectId,
        projectRoot,
        layout: "e2e",
        files,
        packagePrefix: session.packagePrefix || undefined,
      });
      rememberCodegenResult(ideResult);
      for (const g of ideResult.workspaceTree.generatedFiles) {
        if (g.status === "CREATED" || g.status === "UPDATED") applied.push(g.path);
        if (g.status === "REJECTED_JAIL" || g.status === "ERROR") {
          throw new Error(g.error || `IDE Apply failed: ${g.path}`);
        }
      }
    } else {
      for (const f of session.files) {
        const targetRel = assertE2eTarget(f.targetRel);
        const content = await readTextFile(projectRoot, f.workspaceRel);
        await writeTextFile(projectRoot, targetRel, content);
        applied.push(targetRel);
      }
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

function matchStagedPath(filePath: string, staged: E2eStagedFile): boolean {
  const a = norm(filePath);
  const b = norm(staged.targetRel);
  if (a === b) return true;
  const aBase = a.split("/").pop() || "";
  const bBase = b.split("/").pop() || "";
  return !!aBase && aBase === bBase && (a.endsWith(b) || b.endsWith(a));
}

/**
 * Edit one generated E2E file: memory DTO path + staging overlay + AItest source.
 */
export async function updateE2eStagedFileContent(
  projectRoot: string,
  session: E2eStagingSession,
  filePath: string,
  content: string
): Promise<{ session: E2eStagingSession; syncedTarget: string | null }> {
  if (!isTauri()) throw new Error("Sửa file E2E cần Desktop (Tauri).");

  const nextFiles = session.files.map((f) =>
    matchStagedPath(filePath, f) ? { ...f, content } : f
  );
  const hit = nextFiles.find((f) => matchStagedPath(filePath, f));
  if (!hit) throw new Error(`File không có trong staging: ${filePath}`);

  assertE2eTarget(hit.targetRel);
  await writeTextFile(projectRoot, hit.workspaceRel, content);
  await writeTextFile(projectRoot, hit.targetRel, content);

  const next: E2eStagingSession = { ...session, files: nextFiles };
  await writeE2eOverlay(projectRoot, next);
  return { session: next, syncedTarget: hit.targetRel };
}

/**
 * Delete one generated E2E file from staging overlay and AItest/ source.
 */
export async function deleteE2eStagedFile(
  projectRoot: string,
  session: E2eStagingSession,
  filePath: string
): Promise<{ session: E2eStagingSession; syncedTarget: string | null }> {
  if (!isTauri()) throw new Error("Xóa file E2E cần Desktop (Tauri).");

  const hit = session.files.find((f) => matchStagedPath(filePath, f));
  if (!hit) throw new Error(`File không có trong staging: ${filePath}`);
  assertE2eTarget(hit.targetRel);

  try {
    await deleteTextFile(projectRoot, hit.workspaceRel);
  } catch {
    /* overlay may already be gone */
  }

  try {
    await deleteTextFile(projectRoot, hit.targetRel);
  } catch {
    /* missing is ok — still drop from session so Apply cannot resurrect */
  }
  for (const extra of compiledAitestArtifactRels(hit.targetRel)) {
    try {
      await deleteTextFile(projectRoot, extra);
    } catch {
      /* compiled artifact may not exist */
    }
  }
  for (const dir of emptyAitestParentRels(hit.targetRel)) {
    try {
      await deleteDir(projectRoot, dir, { emptyOnly: true });
    } catch {
      /* sibling files remain */
    }
  }

  const next: E2eStagingSession = {
    ...session,
    files: session.files.filter((f) => !matchStagedPath(filePath, f)),
  };
  await writeE2eOverlay(projectRoot, next);
  return { session: next, syncedTarget: hit.targetRel };
}
