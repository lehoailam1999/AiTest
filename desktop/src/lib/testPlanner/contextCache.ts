/**
 * Phase 1 — in-memory Context Cache for UnitImplementationPlan.
 * Index snapshot on disk remains SoT; this only caches plan results per session.
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";
import {
  buildUnitImplementationPlan,
  type BuildUnitImplementationPlanInput,
} from "./buildUnitImplementationPlan";
import type { UnitImplementationPlan } from "./types";

type CacheEntry = {
  plan: UnitImplementationPlan;
  builtAt: number;
};

const store = new Map<string, CacheEntry>();

export function planCacheKey(
  projectRoot: string,
  snapshot: CodeIndexSnapshot,
  testCaseId: string
): string {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  const stamp = `${snapshot.meta.schema}|${snapshot.meta.updatedAt}|${snapshot.meta.fileCount}`;
  const tc = (testCaseId || "").trim().toLowerCase() || "_";
  return `${root}::${stamp}::${tc}`;
}

export function clearUnitPlanCache(projectRoot?: string): void {
  if (!projectRoot) {
    store.clear();
    return;
  }
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
  for (const k of [...store.keys()]) {
    if (k.startsWith(root + "::")) store.delete(k);
  }
}

/** Test helper — number of cached plans. */
export function unitPlanCacheSize(): number {
  return store.size;
}

/**
 * Get cached plan or build + store.
 * Pass `forceRebuild` after index sync or TC edit.
 */
export async function getOrBuildUnitImplementationPlan(
  input: BuildUnitImplementationPlanInput & {
    projectRoot: string;
    testCaseId: string;
    forceRebuild?: boolean;
  }
): Promise<{ plan: UnitImplementationPlan; cacheHit: boolean }> {
  const key = planCacheKey(
    input.projectRoot,
    input.snapshot,
    input.testCaseId
  );
  if (!input.forceRebuild) {
    const hit = store.get(key);
    if (hit) return { plan: hit.plan, cacheHit: true };
  }
  const plan = await buildUnitImplementationPlan(input);
  store.set(key, { plan, builtAt: Date.now() });
  return { plan, cacheHit: false };
}
