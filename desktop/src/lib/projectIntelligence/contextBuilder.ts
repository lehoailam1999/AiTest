import { readTextFile } from "../../tauri/bridge";
import type { TestCase } from "../../api/types";
import type { AITestContextPacket } from "../contextPacket/types";
import { getLanguageAdapter } from "../languageAdapters/registry";
import type { LanguageConventions } from "../languageAdapters/types";
import { resolveDependencyClosure } from "./dependencyResolver";
import { buildProjectIndexCached } from "./projectIndex";
import {
  collectModuleRelatedPaths,
  extractPathsMentionedInTc,
  resolveMentionedPaths,
} from "./relatedFilesFromTc";
import { resolveSeedFromTestCaseWithAlternatives } from "./tcSeedResolver";
import { analyzeSourceUnderTest, findNearbyTestSamples } from "./sourceAnalysis";
import type { ContextBuildPolicy, SeedCandidate, UnitContextPacket } from "./types";
import { DEFAULT_CONTEXT_POLICY } from "./types";
import {
  FS_CONTEXT_BUDGET,
  TIER_PRIORITY,
  enforceContextBudget,
  filterNoisePaths,
  isClientAppMirrorNoise,
  type RankedFile,
} from "./contextBudget";

export {
  buildContextPacketFromIde,
  type BuildFromIdeInput,
  type BuildFromIdeResult,
} from "./ideContextBuilder";
export {
  IDE_CONTEXT_BUDGET,
  FS_CONTEXT_BUDGET,
  isClientAppMirrorNoise,
  filterNoisePaths,
  enforceContextBudget,
} from "./contextBudget";

function trimContent(content: string, max: number): string {
  if (content.length <= max) return content;
  return content.slice(0, max) + "\n/* …truncated… */";
}

export async function buildContextPacket(input: {
  purpose: "generate-unit" | "generate-tc";
  projectRoot: string;
  language: string;
  framework?: string;
  projectId?: string;
  testCase?: TestCase;
  allSourcePaths: string[];
  manualPrimaryPath?: string | null;
  policy?: ContextBuildPolicy;
  /** Alias VI→code theo dự án (project.meta.codeAliases) */
  codeAliases?: Record<string, string[]> | null;
  /** Requirement title — progressive Unit SUT grounding */
  requirementTitle?: string | null;
  /** Path related ép buộc (vd. từ AI rank) — đọc thêm local */
  forcedRelatedPaths?: string[] | null;
}): Promise<AITestContextPacket> {
  const langLower = (input.language || "").toLowerCase();
  const isCsharp =
    langLower.includes("c#") ||
    langLower.includes("csharp") ||
    langLower.includes(".net") ||
    !!input.manualPrimaryPath?.toLowerCase().endsWith(".cs");
  const policy =
    input.policy ??
    (isCsharp
      ? {
          ...DEFAULT_CONTEXT_POLICY,
          maxDependencyFiles: 12,
          maxBytesPerFile: 5_000,
          maxDependencyDepth: 2,
        }
      : DEFAULT_CONTEXT_POLICY);
  const truncated: string[] = [];
  const omittedPaths: string[] = [];
  const adapter = getLanguageAdapter(input.language);
  const conventions = adapter.conventions(input.language, input.framework);

  if (input.purpose === "generate-tc") {
    return buildTcOverviewPacket(input, policy, truncated, omittedPaths, conventions);
  }

  const index = buildProjectIndexCached(
    input.projectId || input.projectRoot,
    input.allSourcePaths
  );
  const tc = input.testCase;
  if (!tc) {
    return emptyPacket(input, truncated, omittedPaths, conventions);
  }

  const { best: autoSeed, candidates } = resolveSeedFromTestCaseWithAlternatives(tc, index, {
    projectAliases: input.codeAliases,
    requirementTitle: input.requirementTitle,
  });
  const seed =
    input.manualPrimaryPath && input.manualPrimaryPath.trim()
      ? {
          pathRel: input.manualPrimaryPath.replace(/\\/g, "/"),
          score: 100,
          reason: "Chọn thủ công",
        }
      : autoSeed;

  if (!seed) {
    return emptyPacket(input, truncated, omittedPaths, conventions, candidates);
  }

  const closure = await resolveDependencyClosure({
    projectRoot: input.projectRoot,
    seedPathRel: seed.pathRel,
    language: input.language,
    allPaths: input.allSourcePaths,
    policy,
  });

  const mentioned = resolveMentionedPaths(
    extractPathsMentionedInTc(tc),
    input.allSourcePaths
  );
  const forced = (input.forcedRelatedPaths ?? [])
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !isClientAppMirrorNoise(p, seed.pathRel));
  const moduleRelatedRaw = policy.broadLocalContext
    ? collectModuleRelatedPaths({
        seedPathRel: seed.pathRel,
        moduleName: tc.module,
        allPaths: input.allSourcePaths,
        maxFiles: policy.maxModuleRelatedFiles ?? 40,
      })
    : collectModuleRelatedPaths({
        seedPathRel: seed.pathRel,
        moduleName: tc.module,
        allPaths: input.allSourcePaths,
        maxFiles: Math.min(8, policy.maxModuleRelatedFiles ?? 8),
      });
  const moduleRelated = filterNoisePaths(moduleRelatedRaw, seed.pathRel);

  const seen = new Set(closure.map((c) => c.pathRel));
  const extraQueue: { pathRel: string; role: "dependency" | "overview" }[] = [];
  for (const p of [...forced, ...mentioned]) {
    if (!seen.has(p)) {
      seen.add(p);
      extraQueue.push({ pathRel: p, role: "dependency" });
    }
  }
  for (const p of moduleRelated) {
    if (!seen.has(p)) {
      seen.add(p);
      extraQueue.push({ pathRel: p, role: "overview" });
    }
  }

  const files: AITestContextPacket["files"] = [];
  const ranked: RankedFile[] = [];
  for (const item of closure) {
    if (item.role !== "primary" && isClientAppMirrorNoise(item.pathRel, seed.pathRel)) {
      omittedPaths.push(item.pathRel);
      continue;
    }
    try {
      const raw = await readTextFile(input.projectRoot, item.pathRel);
      const content = trimContent(raw, policy.maxBytesPerFile);
      if (raw.length > policy.maxBytesPerFile) truncated.push(item.pathRel);
      const tier = item.role === "primary" ? "primary" : "import";
      ranked.push({
        pathRel: item.pathRel,
        role: item.role,
        language: input.language,
        content,
        why:
          item.role === "primary"
            ? "Source under test"
            : "Import / dependency closure",
        tier,
        rankScore: TIER_PRIORITY[tier] - item.depth,
      });
    } catch {
      omittedPaths.push(item.pathRel);
    }
  }

  const extraCap = policy.broadLocalContext
    ? Math.min(policy.maxModuleRelatedFiles ?? 40, FS_CONTEXT_BUDGET.maxOverviewFiles + 4)
    : FS_CONTEXT_BUDGET.maxOverviewFiles;
  for (const item of extraQueue.slice(0, extraCap)) {
    if (isClientAppMirrorNoise(item.pathRel, seed.pathRel)) {
      omittedPaths.push(item.pathRel);
      continue;
    }
    try {
      const raw = await readTextFile(input.projectRoot, item.pathRel);
      const cap =
        item.role === "overview"
          ? Math.min(policy.maxBytesPerFile, FS_CONTEXT_BUDGET.maxOverviewChars)
          : policy.maxBytesPerFile;
      const content = trimContent(raw, cap);
      if (raw.length > cap) truncated.push(item.pathRel);
      ranked.push({
        pathRel: item.pathRel,
        role: item.role,
        language: input.language,
        content,
        why: item.role === "overview" ? "Same module overview" : "Related path from TC",
        tier: item.role === "overview" ? "overview" : "import",
        rankScore:
          item.role === "overview" ? TIER_PRIORITY.overview : TIER_PRIORITY.import - 5,
      });
    } catch {
      omittedPaths.push(item.pathRel);
    }
  }

  const budgeted = enforceContextBudget(ranked, FS_CONTEXT_BUDGET);
  truncated.push(...budgeted.truncated);
  omittedPaths.push(...budgeted.omittedPaths);
  files.push(...budgeted.files);

  const seedCandidates = candidates.map((c) => ({
    pathRel: c.pathRel,
    score: c.score,
    reason: c.reason,
  }));
  if (!seedCandidates.some((c) => c.pathRel === seed.pathRel)) {
    seedCandidates.unshift({
      pathRel: seed.pathRel,
      score: seed.score,
      reason: seed.reason,
    });
  }

  const primaryContent =
    files.find((f) => f.role === "primary")?.content ??
    files[0]?.content ??
    "";
  const { sourceUnderTest, unitStrategy, gaps } = analyzeSourceUnderTest({
    pathRel: seed.pathRel,
    content: primaryContent,
    language: input.language,
    testCaseTitle: tc.title,
  });

  const samplePaths = findNearbyTestSamples({
    seedPathRel: seed.pathRel,
    allPaths: input.allSourcePaths,
    testFilePattern: conventions.testFilePattern,
    max: 2,
  });
  const sampleSeen = new Set(files.map((f) => f.pathRel));
  for (const pathRel of samplePaths) {
    if (sampleSeen.has(pathRel)) continue;
    try {
      const raw = await readTextFile(input.projectRoot, pathRel);
      const content = trimContent(raw, Math.min(policy.maxBytesPerFile, 4500));
      if (raw.length > Math.min(policy.maxBytesPerFile, 4500)) truncated.push(pathRel);
      files.push({
        pathRel,
        role: "test-sample",
        language: input.language,
        content,
        why: "Existing test style reference",
      });
      sampleSeen.add(pathRel);
    } catch {
      omittedPaths.push(pathRel);
    }
  }

  const detectedFrom = ["language-adapter", "context-builder-p3-fs"];
  if (samplePaths.length) detectedFrom.push("existing-tests");
  if (conventions.testFramework) detectedFrom.push("conventions");

  return {
    packetVersion: 1,
    purpose: "generate-unit",
    meta: {
      language: input.language,
      framework: input.framework,
      projectId: input.projectId,
      testCaseId: tc.id,
      module: tc.module || undefined,
      testKind: "unit",
    },
    conventions: {
      testFramework: conventions.testFramework,
      testFilePattern: conventions.testFilePattern,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
    },
    testingStack: {
      testingFramework: conventions.testFramework,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
      detectedFrom,
      confidence: conventions.testFramework ? "medium" : "low",
    },
    sourceUnderTest,
    unitStrategy: {
      ...unitStrategy,
      forbidden: [
        ...(unitStrategy.forbidden ?? []),
        "Do not mirror ClientApp/src/app trees into tests",
      ],
    },
    files,
    diagnostics: {
      truncated,
      omittedPaths,
      seedReason: seed.reason,
      seedCandidates,
      mentionedPaths: mentioned,
      moduleRelatedCount: moduleRelated.length,
      gaps,
    },
  };
}

async function buildTcOverviewPacket(
  input: {
    projectRoot: string;
    language: string;
    framework?: string;
    projectId?: string;
    allSourcePaths: string[];
    policy?: ContextBuildPolicy;
  },
  policy: ContextBuildPolicy,
  truncated: string[],
  omittedPaths: string[],
  conventions: LanguageConventions
): Promise<AITestContextPacket> {
  const candidates = input.allSourcePaths
    .map((p) => p.replace(/\\/g, "/"))
    .filter((p) => !/\/(test|tests|spec|__tests__|node_modules|\.git)\//i.test(p))
    .filter((p) => !/\.(test|spec)\./i.test(p))
    .slice(0, policy.maxDependencyFiles + 15);

  const files: AITestContextPacket["files"] = [];
  const maxFiles = Math.min(28, policy.maxDependencyFiles + 18);

  for (const pathRel of candidates) {
    if (files.length >= maxFiles) {
      omittedPaths.push(pathRel);
      continue;
    }
    try {
      const raw = await readTextFile(input.projectRoot, pathRel);
      const cap = Math.min(policy.maxBytesPerFile, 3500);
      const content = trimContent(raw, cap);
      if (raw.length > cap) truncated.push(pathRel);
      files.push({
        pathRel,
        role: "overview",
        language: input.language,
        content,
      });
    } catch {
      omittedPaths.push(pathRel);
    }
  }

  return {
    packetVersion: 1,
    purpose: "generate-tc",
    meta: {
      language: input.language,
      framework: input.framework,
      projectId: input.projectId,
    },
    conventions: {
      testFramework: conventions.testFramework,
      testFilePattern: conventions.testFilePattern,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
    },
    testingStack: {
      testingFramework: conventions.testFramework,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
      detectedFrom: ["language-adapter"],
      confidence: conventions.testFramework ? "medium" : "low",
    },
    files,
    diagnostics: {
      truncated,
      omittedPaths,
      seedReason: "Overview scan (generate-tc)",
    },
  };
}

function emptyPacket(
  input: {
    language: string;
    framework?: string;
    projectId?: string;
  },
  truncated: string[],
  omittedPaths: string[],
  conventions: {
    testFramework?: string;
    testFilePattern?: string;
    mockFramework?: string;
    assertionLibrary?: string;
  },
  candidates: SeedCandidate[] = []
): AITestContextPacket {
  return {
    packetVersion: 1,
    purpose: "generate-unit",
    meta: {
      language: input.language,
      framework: input.framework,
      projectId: input.projectId,
      testKind: "unit",
    },
    conventions: {
      testFramework: conventions.testFramework,
      testFilePattern: conventions.testFilePattern,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
    },
    testingStack: {
      testingFramework: conventions.testFramework,
      mockFramework: conventions.mockFramework,
      assertionLibrary: conventions.assertionLibrary,
      detectedFrom: ["language-adapter"],
      confidence: "low",
    },
    files: [],
    diagnostics: {
      truncated,
      omittedPaths,
      seedCandidates: candidates.map((c) => ({
        pathRel: c.pathRel,
        score: c.score,
        reason: c.reason,
      })),
      gaps: ["No primary source resolved for this test case"],
    },
  };
}

/** @deprecated UI compat — map packet v1 → view cũ */
export function toUnitContextView(packet: AITestContextPacket): UnitContextPacket {
  const primary = packet.files.find((f) => f.role === "primary") ?? packet.files[0];
  const related = packet.files.map((f) => ({
    pathRel: f.pathRel,
    content: f.content,
    role:
      f.role === "overview" || f.role === "test-sample"
        ? ("dependency" as const)
        : f.role === "primary"
          ? ("primary" as const)
          : ("dependency" as const),
  }));
  const candidates = (packet.diagnostics.seedCandidates ?? []).map((c) => ({
    pathRel: c.pathRel,
    score: c.score,
    reason: c.reason,
  }));
  return {
    primaryPath: primary?.pathRel ?? "",
    primaryContent: primary?.content ?? "",
    related: related.filter((r) => r.role === "primary" || r.role === "dependency"),
    seed: packet.diagnostics.seedReason
      ? {
          pathRel: primary?.pathRel ?? "",
          score: candidates[0]?.score ?? 1,
          reason: packet.diagnostics.seedReason,
        }
      : null,
    candidates,
    mentionedPaths: packet.diagnostics.mentionedPaths ?? [],
    truncated: packet.diagnostics.truncated,
  };
}

export async function buildUnitContextPacket(input: {
  projectRoot: string;
  language: string;
  framework?: string;
  projectId?: string;
  testCase: TestCase;
  allSourcePaths: string[];
  manualPrimaryPath?: string | null;
  policy?: ContextBuildPolicy;
}): Promise<UnitContextPacket> {
  const packet = await buildContextPacket({
    purpose: "generate-unit",
    projectRoot: input.projectRoot,
    language: input.language,
    framework: input.framework,
    projectId: input.projectId,
    testCase: input.testCase,
    allSourcePaths: input.allSourcePaths,
    manualPrimaryPath: input.manualPrimaryPath,
    policy: input.policy,
  });
  return toUnitContextView(packet);
}
