import type { ProjectMeta } from "../../api/types";
import {
  isTauri,
  readTextFile,
  runTestCommand,
  scanProject,
  type ProjectScan,
} from "../../tauri/bridge";
import { assertSafeInstallCommand } from "./assertSafeInstall";
import { parsePackageJsonDeps, resolveTestFramework } from "./resolveTestFramework";
import type { TestFrameworkResolution } from "./types";

async function tryRead(projectRoot: string, rel: string): Promise<string | null> {
  try {
    return await readTextFile(projectRoot, rel);
  } catch {
    return null;
  }
}

/** Absolute or root-relative path → relative path under project root. */
function toRelUnderRoot(projectRoot: string, absOrRel: string): string | null {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const p = absOrRel.replace(/\\/g, "/");
  if (!p) return null;
  const lowerRoot = root.toLowerCase();
  const lowerP = p.toLowerCase();
  if (lowerP.startsWith(lowerRoot + "/")) {
    return p.slice(root.length + 1);
  }
  if (lowerP === lowerRoot) return null;
  if (!p.includes(":") && !p.startsWith("/")) return p.replace(/^\.\//, "");
  return null;
}

async function resolvePackageJsonContent(
  projectRoot: string,
  scan: ProjectScan | null
): Promise<string | null> {
  const rootPkg = await tryRead(projectRoot, "package.json");
  if (rootPkg) {
    const { deps } = parsePackageJsonDeps(rootPkg);
    if (["vitest", "jest", "@jest/core", "mocha"].some((k) => deps.has(k))) {
      return rootPkg;
    }
  }

  for (const m of scan?.modules ?? []) {
    const relDir = toRelUnderRoot(projectRoot, m.path);
    if (relDir == null && m.path.replace(/\\/g, "/") !== projectRoot.replace(/\\/g, "/")) {
      continue;
    }
    const candidate =
      relDir && relDir.length > 0 ? `${relDir}/package.json` : "package.json";
    const content = await tryRead(projectRoot, candidate);
    if (!content) continue;
    const { deps } = parsePackageJsonDeps(content);
    if (["vitest", "jest", "@jest/core", "mocha"].some((k) => deps.has(k))) {
      return content;
    }
  }

  return rootPkg;
}

async function resolveCsprojContent(
  projectRoot: string,
  scan: ProjectScan | null
): Promise<{ content: string | null; preferred: string | null }> {
  const candidates = [
    ...(scan?.testProjects ?? []),
    ...(scan?.csprojFiles ?? []),
  ];
  for (const abs of candidates) {
    const rel = toRelUnderRoot(projectRoot, abs);
    if (!rel) continue;
    const content = await tryRead(projectRoot, rel);
    if (content) return { content, preferred: abs };
  }
  return { content: null, preferred: scan?.testProjects?.[0] ?? scan?.csprojFiles?.[0] ?? null };
}

/** Probe project root and resolve framework (present / missing / unknown). */
export async function probeTestFramework(input: {
  projectRoot: string;
  meta?: ProjectMeta | null;
  scan?: ProjectScan | null;
  /** Language of file/TC under test — tránh Jest từ ClientApp khi test C#. */
  preferredLanguage?: string | null;
  sourceFile?: string | null;
}): Promise<{ resolution: TestFrameworkResolution; scan: ProjectScan | null }> {
  if (!isTauri()) {
    return {
      scan: input.scan ?? null,
      resolution: resolveTestFramework({
        meta: input.meta,
        scan: input.scan,
        preferredLanguage: input.preferredLanguage,
        sourceFile: input.sourceFile,
      }),
    };
  }

  let scan = input.scan ?? null;
  try {
    scan = await scanProject(input.projectRoot);
  } catch {
    /* keep previous */
  }

  const packageJsonContent = await resolvePackageJsonContent(input.projectRoot, scan);
  const requirementsContent =
    (await tryRead(input.projectRoot, "requirements.txt")) ||
    (await tryRead(input.projectRoot, "pyproject.toml"));
  const { content: csprojContent, preferred } = await resolveCsprojContent(
    input.projectRoot,
    scan
  );

  const resolution = resolveTestFramework({
    meta: input.meta,
    scan,
    packageJsonContent,
    requirementsContent,
    csprojContent,
    preferredCsproj: preferred,
    preferredLanguage: input.preferredLanguage,
    sourceFile: input.sourceFile,
    rootFileNames: [
      ...(scan?.solutionFiles ?? []),
      ...(scan?.csprojFiles ?? []),
      ...(packageJsonContent ? ["package.json"] : []),
      ...(requirementsContent ? ["requirements.txt"] : []),
    ],
  });

  return { resolution, scan };
}

/** Run allowlisted install command in project root. */
export async function installTestFramework(
  projectRoot: string,
  installCommand: string
): Promise<{ ok: boolean; log: string; command: string }> {
  const cmd = assertSafeInstallCommand(installCommand);
  const result = await runTestCommand(projectRoot, cmd);
  return {
    ok: result.success || result.exitCode === 0,
    log: result.log,
    command: result.command,
  };
}

export { resolveTestFramework } from "./resolveTestFramework";
export type {
  EnsureStatus,
  TestFrameworkResolution,
  TestFrameworkId,
  PackageManager,
} from "./types";
