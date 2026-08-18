import { deleteTextFile, readTextFile } from "../../tauri/bridge";
import { writeTextFileIfChanged } from "./contentDedup";
import {
  assertSafeAitestTargetRel,
  compiledAitestArtifactRels,
} from "../testOutputLayout";

const REGISTRY_FILE = ".ai-test/unit-artifact-ownership.json";

export type UnitArtifactOwnershipRegistry = {
  version: 1;
  files: Record<string, string[]>;
};

export type FailedUnitOwner = {
  /** Stable TestCase key used by UnitWorkspaceManifest.testCaseId. */
  testCaseId: string;
  packagePrefix?: string | null;
};

function normRel(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^\/+/, "");
}

function normOwner(value: string): string {
  return value.trim().toLowerCase();
}

function registryRel(packagePrefix?: string | null): string {
  const prefix = normRel(packagePrefix || "").replace(/\/+$/, "");
  return prefix ? `${prefix}/${REGISTRY_FILE}` : REGISTRY_FILE;
}

/** Only executable Unit test source is owned; configs/scaffolds are never auto-deleted. */
export function isOwnedUnitTestCodePath(targetRel: string): boolean {
  const path = normRel(targetRel);
  if (!/(?:^|\/)AItest\/UnitTest\//i.test(path)) return false;
  if (/\.(?:csproj|fsproj|vbproj|sln|json|ya?ml|config\.[cm]?[jt]s)$/i.test(path)) {
    return false;
  }
  return (
    /\.(?:cs|fs|vb|java|kt|kts|py|go|php|rb|rs)$/i.test(path) ||
    /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(path)
  );
}

export function emptyOwnershipRegistry(): UnitArtifactOwnershipRegistry {
  return { version: 1, files: {} };
}

export function addSuccessfulOwnership(
  registry: UnitArtifactOwnershipRegistry,
  testCaseId: string,
  targetPaths: readonly string[]
): UnitArtifactOwnershipRegistry {
  const owner = testCaseId.trim();
  if (!owner) return registry;
  const files: Record<string, string[]> = { ...registry.files };
  for (const rawPath of targetPaths) {
    const path = normRel(rawPath);
    if (!isOwnedUnitTestCodePath(path)) continue;
    const current = files[path] || [];
    if (!current.some((item) => normOwner(item) === normOwner(owner))) {
      files[path] = [...current, owner];
    }
  }
  return { version: 1, files };
}

export type FailedOwnershipPlan = {
  registry: UnitArtifactOwnershipRegistry;
  deletePaths: string[];
};

/**
 * Remove failed TC owners. A file is deleted only when no successful/shared
 * owner remains, preventing one failed TC from deleting another TC's code.
 */
export function planFailedOwnershipCleanup(
  registry: UnitArtifactOwnershipRegistry,
  failedTestCaseIds: readonly string[]
): FailedOwnershipPlan {
  const failed = new Set(failedTestCaseIds.map(normOwner).filter(Boolean));
  const files: Record<string, string[]> = {};
  const deletePaths: string[] = [];
  for (const [rawPath, owners] of Object.entries(registry.files)) {
    const path = normRel(rawPath);
    const remaining = owners.filter((owner) => !failed.has(normOwner(owner)));
    if (remaining.length > 0) {
      files[path] = remaining;
    } else if (owners.some((owner) => failed.has(normOwner(owner)))) {
      if (isOwnedUnitTestCodePath(path)) deletePaths.push(path);
    } else {
      files[path] = owners;
    }
  }
  return {
    registry: { version: 1, files },
    deletePaths: [...new Set(deletePaths)],
  };
}

export async function loadUnitArtifactOwnership(
  projectRoot: string,
  packagePrefix?: string | null
): Promise<UnitArtifactOwnershipRegistry> {
  try {
    const parsed = JSON.parse(
      await readTextFile(projectRoot, registryRel(packagePrefix))
    ) as Partial<UnitArtifactOwnershipRegistry>;
    if (parsed.version !== 1 || !parsed.files || typeof parsed.files !== "object") {
      return emptyOwnershipRegistry();
    }
    const files: Record<string, string[]> = {};
    for (const [path, owners] of Object.entries(parsed.files)) {
      if (!Array.isArray(owners) || !isOwnedUnitTestCodePath(path)) continue;
      files[normRel(path)] = owners.map(String).filter(Boolean);
    }
    return { version: 1, files };
  } catch {
    return emptyOwnershipRegistry();
  }
}

export async function saveUnitArtifactOwnership(
  projectRoot: string,
  registry: UnitArtifactOwnershipRegistry,
  packagePrefix?: string | null
): Promise<void> {
  await writeTextFileIfChanged(
    projectRoot,
    registryRel(packagePrefix),
    `${JSON.stringify(registry, null, 2)}\n`
  );
}

/**
 * Delete orphaned source tests for failed TCs and persist successful ownership.
 * A failed deletion remains in the registry so the next Apply retries it.
 */
export async function reconcileUnitArtifactOwnership(input: {
  projectRoot: string;
  successful: Array<{
    testCaseId: string;
    packagePrefix?: string | null;
    targetPaths: string[];
  }>;
  failed: FailedUnitOwner[];
}): Promise<{ deletedPaths: string[]; deleteErrors: string[] }> {
  const deletedPaths: string[] = [];
  const deleteErrors: string[] = [];
  const packageKeys = new Set<string>();
  for (const item of [...input.successful, ...input.failed]) {
    packageKeys.add(normRel(item.packagePrefix || "").replace(/\/+$/, ""));
  }

  for (const packageKey of packageKeys) {
    const packagePrefix = packageKey || undefined;
    let registry = await loadUnitArtifactOwnership(input.projectRoot, packagePrefix);
    for (const item of input.successful) {
      if (normRel(item.packagePrefix || "").replace(/\/+$/, "") !== packageKey) continue;
      registry = addSuccessfulOwnership(registry, item.testCaseId, item.targetPaths);
    }

    const failedIds = input.failed
      .filter(
        (item) =>
          normRel(item.packagePrefix || "").replace(/\/+$/, "") === packageKey
      )
      .map((item) => item.testCaseId);
    const plan = planFailedOwnershipCleanup(registry, failedIds);
    const retryFiles: Record<string, string[]> = {};
    for (const path of plan.deletePaths) {
      try {
        assertSafeAitestTargetRel(path);
        await deleteTextFile(input.projectRoot, path);
        for (const compiledRel of compiledAitestArtifactRels(path)) {
          await deleteTextFile(input.projectRoot, compiledRel);
        }
        deletedPaths.push(path);
      } catch (error) {
        deleteErrors.push(
          `${path}: ${error instanceof Error ? error.message : String(error)}`
        );
        retryFiles[path] = registry.files[path] || failedIds;
      }
    }
    registry = {
      version: 1,
      files: { ...plan.registry.files, ...retryFiles },
    };
    await saveUnitArtifactOwnership(input.projectRoot, registry, packagePrefix);
  }

  return { deletedPaths, deleteErrors };
}
