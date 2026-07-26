import { readTextFile, writeTextFile } from "../../tauri/bridge";
import { manifestRelPath, newRunId, overlayRelPath } from "./paths";
import type {
  ManifestFileEntry,
  UnitWorkspaceManifest,
  WorkspacePreviewFile,
  WorkspaceFileOp,
} from "./types";
import { coerceAitestApplyPath, rewriteSutImports } from "../testOutputLayout";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  ensureAitestJestTsconfigInWorkspace,
  looksLikeJestTsTest,
} from "./ensureAitestJestTsconfig";

function normalizeRel(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

async function fileExists(projectRoot: string, rel: string): Promise<boolean> {
  try {
    await readTextFile(projectRoot, rel);
    return true;
  } catch {
    return false;
  }
}

export async function createUnitWorkspaceRun(input: {
  projectRoot: string;
  projectId: string;
  testCaseId: string;
  provider?: string;
  sourceFileName?: string;
  artifactKind?: "unit" | "api";
  packagePrefix?: string | null;
}): Promise<UnitWorkspaceManifest> {
  const runId = newRunId(input.testCaseId);
  const packagePrefix =
    input.packagePrefix !== undefined && input.packagePrefix !== null
      ? input.packagePrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
      : await resolvePackagePrefix(input.projectRoot, input.sourceFileName);
  const manifest: UnitWorkspaceManifest = {
    version: 1,
    runId,
    projectId: input.projectId,
    testCaseId: input.testCaseId,
    createdAt: new Date().toISOString(),
    status: "draft",
    files: [],
    provider: input.provider,
    sourceFileName: input.sourceFileName,
    artifactKind: input.artifactKind ?? "unit",
    packagePrefix,
  };
  await saveManifest(input.projectRoot, manifest);
  return manifest;
}

export async function saveManifest(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<void> {
  const rel = manifestRelPath(manifest.runId, manifest.packagePrefix);
  await writeTextFile(projectRoot, rel, JSON.stringify(manifest, null, 2));
}

export async function loadManifest(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<UnitWorkspaceManifest | null> {
  try {
    const raw = await readTextFile(projectRoot, manifestRelPath(runId, packagePrefix));
    const parsed = JSON.parse(raw) as UnitWorkspaceManifest;
    if (parsed?.version !== 1 || !parsed.runId) return null;
    return parsed;
  } catch {
    return null;
  }
}

export async function addArtifactToWorkspace(input: {
  projectRoot: string;
  manifest: UnitWorkspaceManifest;
  targetRel: string;
  content: string;
  forceOp?: WorkspaceFileOp;
  module?: string | null;
}): Promise<{ manifest: UnitWorkspaceManifest; entry: ManifestFileEntry; baseContent: string | null }> {
  const kind = input.manifest.artifactKind === "api" ? "api" : "unit";
  const srcName = input.manifest.sourceFileName?.trim() || "";
  const packagePrefix =
    input.manifest.packagePrefix ??
    (await resolvePackagePrefix(input.projectRoot, srcName || input.targetRel));
  const targetRel = coerceAitestApplyPath(normalizeRel(input.targetRel), {
    kind,
    module: input.module,
    sourceFileName: srcName || input.manifest.sourceFileName,
    packagePrefix,
  });
  if (!targetRel) {
    throw new Error("Đường dẫn file không hợp lệ");
  }

  let body = input.content;
  if (srcName) {
    body = rewriteSutImports(body, { testRel: targetRel, sourceRel: srcName });
  }
  const content = ensureJestReferencePreamble(body, targetRel);

  let op: WorkspaceFileOp = input.forceOp ?? "new";
  let baseContent: string | null = null;
  const exists = await fileExists(input.projectRoot, targetRel);
  if (exists && op === "new") {
    op = "modify";
    try {
      baseContent = await readTextFile(input.projectRoot, targetRel);
    } catch {
      baseContent = null;
    }
  }

  const workspaceRel = overlayRelPath(input.manifest.runId, targetRel, packagePrefix);
  await writeTextFile(input.projectRoot, workspaceRel, content);

  const entry: ManifestFileEntry = { op, targetRel, workspaceRel };
  const files = input.manifest.files.filter((f) => f.targetRel !== targetRel);
  files.push(entry);

  let manifest: UnitWorkspaceManifest = {
    ...input.manifest,
    status: "generated",
    files,
    packagePrefix,
  };

  if (looksLikeJestTsTest(targetRel, content)) {
    manifest = await ensureAitestJestTsconfigInWorkspace({
      projectRoot: input.projectRoot,
      manifest,
      targetRel,
    });
  }

  await saveManifest(input.projectRoot, manifest);
  return { manifest, entry, baseContent };
}

/** Desktop safety net if API has not injected /// <reference types="jest" /> yet. */
function ensureJestReferencePreamble(code: string, targetRel: string): string {
  if (!looksLikeJestTsTest(targetRel, code)) return code;
  if (/\/\/\/\s*<reference\s+types=["']jest["']\s*\/>/.test(code)) return code;
  if (/from\s+['"]@jest\/globals['']/.test(code)) return code;
  return `/// <reference types="jest" />\n${code.replace(/^\uFEFF?/, "")}`;
}

export async function loadWorkspacePreviews(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<WorkspacePreviewFile[]> {
  const out: WorkspacePreviewFile[] = [];
  for (const entry of manifest.files) {
    try {
      const content = await readTextFile(projectRoot, entry.workspaceRel);
      let baseContent: string | null | undefined;
      if (entry.op === "modify") {
        try {
          baseContent = await readTextFile(projectRoot, entry.targetRel);
        } catch {
          baseContent = null;
        }
      }
      out.push({ entry, content, baseContent });
    } catch {
      /* skip missing overlay */
    }
  }
  return out;
}

export function groupFilesByOp(manifest: UnitWorkspaceManifest): {
  newFiles: ManifestFileEntry[];
  modifiedFiles: ManifestFileEntry[];
  deletedFiles: ManifestFileEntry[];
} {
  const newFiles: ManifestFileEntry[] = [];
  const modifiedFiles: ManifestFileEntry[] = [];
  const deletedFiles: ManifestFileEntry[] = [];
  for (const f of manifest.files) {
    if (f.op === "new") newFiles.push(f);
    else if (f.op === "modify") modifiedFiles.push(f);
    else deletedFiles.push(f);
  }
  return { newFiles, modifiedFiles, deletedFiles };
}
