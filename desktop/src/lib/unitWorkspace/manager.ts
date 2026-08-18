import { readTextFile } from "../../tauri/bridge";
import { stripCodeFences } from "../stripCodeFences";
import { manifestRelPath, newRunId, overlayRelPath } from "./paths";
import type {
  ManifestFileEntry,
  UnitTransformName,
  UnitWorkspaceManifest,
  WorkspacePreviewFile,
  WorkspaceFileOp,
} from "./types";
import { pushTimeline } from "./unitJobEvents";
import {
  coerceAitestApplyPath,
  isFlatAitestTarget,
  rewriteSutImports,
  testFileNameFromSource,
} from "../testOutputLayout";
import { assertStackMatchesPath } from "@aitest/ide-protocol";
import { readDraftText, writeDraftText } from "./draftStore";
import { resolvePackagePrefix } from "../resolvePackagePrefix";
import {
  ensureAitestJestTsconfigInWorkspace,
  looksLikeJestTsTest,
} from "./ensureAitestJestTsconfig";
import {
  csharpShortIdFromPath,
  ensureAitestDotnetInWorkspace,
  manifestHasAitestCsharpTests,
  sanitizeCsharpAitestCode,
} from "./ensureAitestDotnet";

function normalizeRel(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function ensureTargetHasFileName(
  rel: string,
  sourceFileName: string | undefined,
  kind: "unit" | "api"
): string {
  const norm = normalizeRel(rel).replace(/\/+$/, "");
  const last = norm.split("/").pop() || "";
  if (last.includes(".")) return norm;
  const fallback = testFileNameFromSource({
    sourceFileName: sourceFileName || undefined,
    kind,
  });
  return `${norm}/${fallback}`.replace(/\/+/g, "/");
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
  packageName?: string | null;
  jobId?: string;
  via?: UnitWorkspaceManifest["via"];
  commandId?: string;
  status?: UnitWorkspaceManifest["status"];
}): Promise<UnitWorkspaceManifest> {
  const runId = newRunId(input.testCaseId);
  const jobId = input.jobId || runId;
  const packagePrefix =
    input.packagePrefix !== undefined && input.packagePrefix !== null
      ? input.packagePrefix.replace(/\\/g, "/").replace(/^\/+|\/+$/g, "")
      : await resolvePackagePrefix(input.projectRoot, input.sourceFileName);
  const timeline = pushTimeline([], "job.queued", `via=${input.via || "unknown"}`);
  const manifest: UnitWorkspaceManifest = {
    version: 1,
    runId,
    jobId,
    projectId: input.projectId,
    testCaseId: input.testCaseId,
    createdAt: new Date().toISOString(),
    status: input.status ?? "draft",
    files: [],
    provider: input.provider,
    sourceFileName: input.sourceFileName,
    artifactKind: input.artifactKind ?? "unit",
    packagePrefix,
    packageName: input.packageName?.trim() || undefined,
    via: input.via,
    commandId: input.commandId,
    timeline,
    transforms: [],
  };
  await saveManifest(input.projectRoot, manifest);
  return manifest;
}

export async function saveManifest(
  projectRoot: string,
  manifest: UnitWorkspaceManifest
): Promise<void> {
  const rel = manifestRelPath(manifest.runId, manifest.packagePrefix);
  await writeDraftText(projectRoot, rel, JSON.stringify(manifest, null, 2));
}

export async function loadManifest(
  projectRoot: string,
  runId: string,
  packagePrefix?: string | null
): Promise<UnitWorkspaceManifest | null> {
  try {
    const raw = await readDraftText(
      projectRoot,
      manifestRelPath(runId, packagePrefix)
    );
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
  const targetWithFile = ensureTargetHasFileName(
    normalizeRel(input.targetRel),
    srcName || input.manifest.sourceFileName,
    kind
  );
  const targetRel = coerceAitestApplyPath(targetWithFile, {
    kind,
    module: input.module,
    sourceFileName: srcName || input.manifest.sourceFileName,
    packagePrefix,
    // Generate may receive unsafe model paths — rebuild allowed when not yet flat AItest.
    preserveLayout: isFlatAitestTarget(targetWithFile),
  });
  if (!targetRel) {
    throw new Error("Đường dẫn file không hợp lệ");
  }

  let body = stripCodeFences(input.content);
  assertStackMatchesPath(targetRel, body);
  const transforms: UnitTransformName[] = [...(input.manifest.transforms || [])];
  let timeline = input.manifest.timeline || [];
  if (srcName) {
    body = rewriteSutImports(body, { testRel: targetRel, sourceRel: srcName });
    if (!transforms.includes("rewriteSutImports")) transforms.push("rewriteSutImports");
    timeline = pushTimeline(timeline, "job.transform", "rewriteSutImports");
  }
  const beforeJest = body;
  body = ensureJestReferencePreamble(body, targetRel);
  if (body !== beforeJest) {
    if (!transforms.includes("jestPreamble")) transforms.push("jestPreamble");
    timeline = pushTimeline(timeline, "job.transform", "jestPreamble");
  }
  if (/\.cs$/i.test(targetRel) && /(?:^|\/)AItest\//i.test(targetRel.replace(/\\/g, "/"))) {
    const shortId = csharpShortIdFromPath(targetRel);
    body = sanitizeCsharpAitestCode(body, shortId);
    if (!transforms.includes("csharpSanitize")) transforms.push("csharpSanitize");
    timeline = pushTimeline(timeline, "job.transform", "csharpSanitize");
  }
  const content = body;

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
  // Same content already in repo — still keep overlay for this run's preview, but
  // mark modify so Apply can no-op via writeTextFileIfChanged.
  await writeDraftText(input.projectRoot, workspaceRel, content);

  const entry: ManifestFileEntry = { op, targetRel, workspaceRel };
  const files = input.manifest.files.filter((f) => f.targetRel !== targetRel);
  files.push(entry);

  let manifest: UnitWorkspaceManifest = {
    ...input.manifest,
    status: "generated",
    files,
    packagePrefix,
    transforms,
    timeline,
  };

  if (looksLikeJestTsTest(targetRel, content)) {
    // Shared jest/tsconfig: only first differing run copies into overlay + disk.
    manifest = await ensureAitestJestTsconfigInWorkspace({
      projectRoot: input.projectRoot,
      manifest,
      targetRel,
    });
  }

  if (manifestHasAitestCsharpTests(manifest)) {
    manifest = await ensureAitestDotnetInWorkspace({
      projectRoot: input.projectRoot,
      manifest,
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
      const content = await readDraftText(projectRoot, entry.workspaceRel);
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
