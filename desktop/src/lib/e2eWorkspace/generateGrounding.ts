import type { E2EFileDto } from "../../api/index.js";
import { deriveFeaturePathFromTc } from "./deriveFeaturePathFromTc.js";
import { isUsableFeaturePath } from "./assertTcReadyForE2eGen.js";
import {
  CONVENTION_PATHS,
  loadProjectProfile,
  readConventionExcerpt,
} from "../projectProfile/index.js";
import type { ProfileIo, ProjectProfile } from "../projectProfile/types.js";

export function lookupModuleMapPath(
  moduleKey: string | null | undefined,
  moduleMap?: Record<string, string> | null
): string | undefined {
  const key = (moduleKey || "").trim();
  const map = moduleMap || {};
  if (!key || !Object.keys(map).length) return undefined;

  const exact = (map[key] || "").trim();
  if (isUsableFeaturePath(exact)) return exact;

  const norm = (s: string) =>
    s
      .normalize("NFD")
      .replace(/[\u0300-\u036f]/g, "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim();
  const keyN = norm(key);
  if (!keyN) return undefined;

  for (const [mk, path] of Object.entries(map)) {
    if (norm(mk) === keyN && isUsableFeaturePath(path)) return path.trim();
  }

  const keyTokens = new Set(keyN.split(/\s+/).filter((t) => t.length >= 3));
  if (!keyTokens.size) return undefined;
  let best: { path: string; score: number } | undefined;
  for (const [mk, path] of Object.entries(map)) {
    if (!isUsableFeaturePath(path)) continue;
    const blob = `${norm(mk)} ${norm(path)}`;
    const tokens = new Set(blob.split(/\s+/).filter((t) => t.length >= 3));
    let score = 0;
    for (const t of keyTokens) if (tokens.has(t)) score += 1;
    // Path segment overlap (evidence ↔ /admin/evidence)
    for (const seg of norm(path).split(/[\s/]+/)) {
      if (seg.length >= 4 && keyN.includes(seg)) score += 1.5;
      if (seg.length >= 4 && [...keyTokens].some((t) => t.includes(seg) || seg.includes(t))) {
        score += 1;
      }
    }
    if (!best || score > best.score) best = { path: path.trim(), score };
  }
  return best && best.score >= 2 ? best.path : undefined;
}

export function resolveFeaturePathSeed(opts: {
  explicitFeaturePath?: string;
  testCase?: {
    title?: string | null;
    precondition?: string | null;
    testData?: string | null;
    steps?: string | null;
    module?: string | null;
  };
  moduleMap?: Record<string, string>;
  phase5FeaturePathHint?: string;
  /** Requirement Studio title — secondary moduleMap key */
  requirementTitle?: string | null;
}): string | undefined {
  const tc = opts.testCase || {};
  const tcMarkerPath =
    deriveFeaturePathFromTc({
      title: tc.title || undefined,
      precondition: tc.precondition || undefined,
      testData: tc.testData || undefined,
      steps: tc.steps || undefined,
    }) || undefined;
  // Unusable TC markers (VN slug, localhost origin) must not poison — fall through to moduleMap.
  const usableMarker = isUsableFeaturePath(tcMarkerPath) ? tcMarkerPath : undefined;
  const moduleMapPath =
    lookupModuleMapPath(tc.module, opts.moduleMap) ||
    lookupModuleMapPath(opts.requirementTitle, opts.moduleMap) ||
    lookupModuleMapPath(tc.title, opts.moduleMap);
  const picked =
    (isUsableFeaturePath(opts.explicitFeaturePath) ? opts.explicitFeaturePath!.trim() : undefined) ||
    usableMarker ||
    (isUsableFeaturePath(moduleMapPath) ? moduleMapPath : undefined) ||
    (isUsableFeaturePath(opts.phase5FeaturePathHint) ? opts.phase5FeaturePathHint!.trim() : undefined) ||
    undefined;
  return picked && isUsableFeaturePath(picked) ? picked : undefined;
}

export function buildGenerateE2eRunBody(input: {
  projectId: string;
  testCaseId: string;
  targetUrl: string;
  domSnapshot?: string;
  sourceFileName?: string;
  sourceCode?: string;
  relatedSources?: { path: string; content: string }[];
  module?: string;
  requirementTitle?: string;
  projectRoot: string;
  storageStateRel?: string;
  seedCommand?: string;
  teardownCommand?: string;
  existingFiles?: E2EFileDto[];
  testData?: string;
  executionContext?: string;
  featurePath?: string;
  locatorContract: string;
  pomScaffold?: string;
  projectRules?: string;
  skipAuthSeed?: boolean;
  planner?: Record<string, unknown>;
  indexVersion?: string;
}): Record<string, unknown> {
  const normalizedRules = (input.projectRules || "").trim();
  return {
    projectId: input.projectId,
    testCaseId: input.testCaseId,
    targetUrl: input.targetUrl,
    domSnapshot: input.domSnapshot || undefined,
    sourceFileName: input.sourceFileName,
    sourceCode: input.sourceCode,
    relatedSources: input.relatedSources,
    module: input.module,
    requirementTitle: input.requirementTitle || undefined,
    projectRoot: input.projectRoot,
    storageStateRel: input.storageStateRel,
    seedCommand: input.seedCommand,
    teardownCommand: input.teardownCommand,
    existingFiles: input.existingFiles,
    testData: input.testData || undefined,
    executionContext: input.executionContext || undefined,
    featurePath: input.featurePath || undefined,
    locatorContract: input.locatorContract,
    pomScaffold: input.pomScaffold || undefined,
    // Sprint 2.4: always send explicit projectRules for new profile-driven flow.
    // Empty string means "intentionally no project rules" (do not fallback to legacy meta).
    projectRules: normalizedRules,
    projectRulesSource: normalizedRules ? "e2e-conventions" : "none",
    skipAuthSeed: input.skipAuthSeed,
    skipAutoInspect: true,
    ...(input.planner ? { planner: input.planner } : {}),
    ...(input.indexVersion ? { indexVersion: input.indexVersion } : {}),
  };
}

export type GenerateGroundingLoadMeta = {
  profileSource: "project-profile" | "none";
  rulesSource: "e2e-conventions" | "none";
  moduleMapCount: number;
  projectRulesChars: number;
};

export async function loadGenerateGroundingProfile(
  projectRoot: string,
  io: ProfileIo
): Promise<{
  projectProfile: ProjectProfile | null;
  projectRules: string;
  meta: GenerateGroundingLoadMeta;
}> {
  const projectProfile = await loadProjectProfile(projectRoot, io).catch(() => null);
  const projectRules = await readConventionExcerpt(
    projectRoot,
    CONVENTION_PATHS.e2eConventions,
    io,
    2500
  ).catch(() => "");
  return {
    projectProfile,
    projectRules,
    meta: {
      profileSource: projectProfile ? "project-profile" : "none",
      rulesSource: projectRules.trim() ? "e2e-conventions" : "none",
      moduleMapCount: Object.keys(projectProfile?.moduleMap || {}).length,
      projectRulesChars: projectRules.length,
    },
  };
}
