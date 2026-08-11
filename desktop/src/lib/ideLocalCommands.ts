/**
 * Desktop-local context for Generate Unit / API (not an IDE plugin).
 *
 * Flow (AI CLI unchanged):
 *   Desktop đọc FS / Code Index → contextPacket
 *   → POST /generate-unit → Backend gọi AI CLI (Cursor/agy) sinh code
 *
 * Backend chỉ nhận packet ephemeral; không thay runner AI CLI.
 */
import type { TestCase } from "../api/types";
import type { AITestContextPacket } from "./contextPacket/types";
import { packetForApi, primaryFile } from "./contextPacket/serialize";
import {
  buildContextPacket,
  toUnitContextView,
} from "./projectIntelligence/contextBuilder";
import { buildProjectIndexCached } from "./projectIntelligence/projectIndex";
import {
  BROAD_CONTEXT_POLICY,
  DEFAULT_CONTEXT_POLICY,
  type UnitContextPacket,
} from "./projectIntelligence/types";
import { isTauri, listSourceFiles, readTextFile } from "../tauri/bridge";

export type IdeSearchHit = {
  pathRel: string;
  score: number;
  reason: string;
};

/** list — all source paths under project root (Tauri). */
export async function ideListSourceFiles(
  projectRoot: string,
  extensions?: string[]
): Promise<string[]> {
  if (!isTauri()) return [];
  const raw = await listSourceFiles(projectRoot, extensions);
  return raw.map((p) => p.replace(/\\/g, "/"));
}

/** read — one file relative to project root. */
export async function ideReadFile(projectRoot: string, pathRel: string): Promise<string> {
  if (!isTauri()) {
    throw new Error("ideReadFile cần Desktop (Tauri)");
  }
  return readTextFile(projectRoot, pathRel.replace(/\\/g, "/"));
}

/** search — by stem / basename / path substring on local index. */
export function ideSearchByName(
  allSourcePaths: string[],
  query: string,
  opts?: { projectId?: string; limit?: number }
): IdeSearchHit[] {
  const projectId = opts?.projectId;
  const limit = opts?.limit ?? 30;
  const q = (query || "").trim().toLowerCase();
  if (q.length < 2) return [];
  const index = buildProjectIndexCached(projectId || "local", allSourcePaths);
  const out: IdeSearchHit[] = [];
  const seen = new Set<string>();

  const stemHits = index.byStem.get(q) ?? [];
  for (const f of stemHits) {
    if (seen.has(f.pathRel)) continue;
    seen.add(f.pathRel);
    out.push({ pathRel: f.pathRel, score: 100, reason: "stem" });
  }

  const base = index.byBaseName.get(q);
  if (base && !seen.has(base.pathRel)) {
    seen.add(base.pathRel);
    out.push({ pathRel: base.pathRel, score: 90, reason: "basename" });
  }

  const tokenHits = index.byToken.get(q) ?? [];
  for (const f of tokenHits) {
    if (out.length >= limit) break;
    if (seen.has(f.pathRel)) continue;
    seen.add(f.pathRel);
    out.push({ pathRel: f.pathRel, score: 80, reason: "token" });
  }

  for (const f of index.files) {
    if (out.length >= limit) break;
    if (seen.has(f.pathRel)) continue;
    if (f.pathRel.toLowerCase().includes(q) || f.stem.toLowerCase().includes(q)) {
      seen.add(f.pathRel);
      out.push({ pathRel: f.pathRel, score: 50, reason: "path" });
    }
  }
  return out.slice(0, limit);
}

export type BuildGenerateContextInput = {
  projectRoot: string;
  projectId?: string;
  language: string;
  framework?: string;
  testCase: TestCase;
  allSourcePaths: string[];
  /** Manual primary override */
  manualPrimaryPath?: string | null;
  /** Extra related paths (manual multi-select) */
  forcedRelatedPaths?: string[] | null;
  codeAliases?: Record<string, string[]> | null;
  broadLocalContext?: boolean;
  purpose?: "generate-unit" | "generate-tc";
  /**
   * Prefer Phase 4 index→retrieve→packet when `.ai-test/index.db` exists (or sync).
   * Default true on Tauri Desktop. Legacy projectIntelligence is fallback only.
   */
  preferIndexContext?: boolean;
  /** Sync code index if missing (default true when preferIndexContext) */
  syncIndexIfMissing?: boolean;
  /**
   * Approved TC markdown from `.ai-test/test-cases/` (SoT on disk).
   * Merged into resolve/alignment so path:/code: markers work even when DB Test Data lags.
   */
  approvedTcMd?: string | null;
  /** Requirement title for progressive SUT grounding */
  requirementTitle?: string | null;
};

export type BuildGenerateContextResult = {
  packet: AITestContextPacket;
  /** Compact view for UI panels */
  view: UnitContextPacket;
  /** Ready for POST generate-* */
  packetForApi: AITestContextPacket;
  primaryPath: string;
  primaryContent: string;
  /** Phase 5 — TestPlan for AAA hint (optional; legacy callers ignore) */
  planner?: import("./testPlanner/types").TestPlan;
  /** Phase 1 — Unit Implementation Plan (entry + layers) */
  implementationPlan?: import("./testPlanner/types").UnitImplementationPlan | null;
  /** Phase 5 — code index schema stamp when index-backed */
  indexVersion?: string;
  /** How primary was resolved */
  contextSource?: string;
};

/**
 * Prefer Code Index + Implementation Planner when language is indexed
 * (TS/JS + C#). Empty language → false (mixed monorepo safety).
 * Java/Python/Go/… still legacy until index parsers exist.
 */
export function shouldPreferCodeIndex(language: string | null | undefined): boolean {
  const lang = (language || "").toLowerCase().trim();
  if (!lang) return false;
  if (/typescript|javascript|tsx|jsx|\bts\b|\bjs\b|node/.test(lang)) return true;
  if (/c#|csharp|dotnet|\.net/.test(lang)) return true;
  return false;
}

/**
 * buildUnitContext — prefer index-backed packet (TS/JS/C#); fallback IDE closure.
 * Does not call Backend; does not persist source.
 */
export async function buildGenerateContext(
  input: BuildGenerateContextInput
): Promise<BuildGenerateContextResult> {
  // Prefer disk MD markers over stale DB Test Data for resolve + domain checks.
  const approvedMd = (input.approvedTcMd || "").trim();
  const testCase: TestCase = approvedMd
    ? {
        ...input.testCase,
        // MD first — Approve SoT on disk wins over stale DB auto-markers
        testData: [approvedMd, input.testCase.testData].filter(Boolean).join("\n\n"),
      }
    : input.testCase;

  const preferIndex =
    input.preferIndexContext !== false && isTauri() && shouldPreferCodeIndex(input.language);

  if (preferIndex) {
    try {
      const { createTauriCodeIndexIo } = await import("./codeIndex/tauriIo");
      const { buildIndexBackedContext } = await import("./contextBuilder");
      const { isUnsuitableUnitPrimary } = await import("./retrieval/rankScore");
      const built = await buildIndexBackedContext({
        projectRoot: input.projectRoot,
        testCase,
        io: createTauriCodeIndexIo(),
        language: input.language,
        framework: input.framework,
        syncIfMissing: input.syncIndexIfMissing !== false,
        forceTestType: "Unit",
      });
      const impl = built.implementationPlan;

      // Phase 1 Context Strategy: planner not ready → empty packet (no legacy poison)
      if (impl && impl.status !== "ready") {
        const emptyPacket: AITestContextPacket = {
          ...built.packet,
          purpose: input.purpose ?? "generate-unit",
          files: [],
          meta: {
            ...built.packet.meta,
            projectId: input.projectId,
            language: input.language || built.packet.meta.language,
            framework: input.framework || built.packet.meta.framework,
          },
        };
        const view = toUnitContextView(emptyPacket);
        return {
          packet: emptyPacket,
          view: { ...view, primaryPath: "", primaryContent: "" },
          packetForApi: packetForApi(emptyPacket),
          primaryPath: "",
          primaryContent: "",
          planner: built.plan,
          implementationPlan: impl,
          indexVersion: built.snapshot.meta.schema,
          contextSource: "implementation-plan",
        };
      }

      const primaryPath = built.packet.files[0]?.pathRel || "";
      if (
        built.packet.files.length &&
        built.packet.files[0]?.content &&
        primaryPath &&
        !isUnsuitableUnitPrimary(primaryPath)
      ) {
        let packet: AITestContextPacket = {
          ...built.packet,
          purpose: input.purpose ?? "generate-unit",
          meta: {
            ...built.packet.meta,
            projectId: input.projectId,
            language: input.language || built.packet.meta.language,
            framework: input.framework || built.packet.meta.framework,
          },
        };
        const manual = (input.manualPrimaryPath || "").replace(/\\/g, "/");
        if (manual && packet.files[0]?.pathRel !== manual) {
          const hit = packet.files.find((f) => f.pathRel === manual);
          if (hit && !isUnsuitableUnitPrimary(hit.pathRel)) {
            packet = {
              ...packet,
              files: [
                { ...hit, role: "primary" },
                ...packet.files.filter((f) => f.pathRel !== manual).map((f) => ({
                  ...f,
                  role: f.role === "primary" ? "dependency" : f.role,
                })),
              ],
            };
          }
        }
        const primary = primaryFile(packet);
        const view = toUnitContextView(packet);
        return {
          packet,
          view,
          packetForApi: packetForApi(packet),
          primaryPath: primary?.pathRel ?? view.primaryPath ?? "",
          primaryContent: primary?.content ?? view.primaryContent ?? "",
          planner: built.plan,
          implementationPlan: impl,
          indexVersion: built.snapshot.meta.schema,
          contextSource: "implementation-plan",
        };
      }
    } catch {
      // fall through to legacy IDE context builder
    }
  }

  const policy = input.broadLocalContext ? BROAD_CONTEXT_POLICY : DEFAULT_CONTEXT_POLICY;
  const packet = await buildContextPacket({
    purpose: input.purpose ?? "generate-unit",
    projectRoot: input.projectRoot,
    language: input.language,
    framework: input.framework,
    projectId: input.projectId,
    testCase,
    allSourcePaths: input.allSourcePaths,
    manualPrimaryPath: input.manualPrimaryPath,
    policy,
    codeAliases: input.codeAliases,
    requirementTitle: input.requirementTitle,
    forcedRelatedPaths: input.forcedRelatedPaths,
  });

  const primary = primaryFile(packet);
  const view = toUnitContextView(packet);
  let planner: import("./testPlanner/types").TestPlan | undefined;
  try {
    const { planFromTestCase } = await import("./testPlanner/planFromTestCase");
    planner = planFromTestCase({ testCaseId: testCase.id });
  } catch {
    planner = undefined;
  }

  const primaryPath = primary?.pathRel ?? view.primaryPath ?? "";
  const primaryContent = primary?.content ?? view.primaryContent ?? "";
  if (primaryPath && primaryContent) {
    try {
      const { isUnsuitableUnitPrimary } = await import("./retrieval/rankScore");
      if (isUnsuitableUnitPrimary(primaryPath)) {
        const emptyPacket: AITestContextPacket = {
          ...packet,
          files: [],
        };
        return {
          packet: emptyPacket,
          view: { ...view, primaryPath: "", primaryContent: "" },
          packetForApi: packetForApi(emptyPacket),
          primaryPath: "",
          primaryContent: "",
          planner,
          contextSource: "project-intelligence",
        };
      }
      const { isPacketSutAcceptable, sutDomainConflict } = await import(
        "@aitest/ide-protocol"
      );
      const tcBlob = [
        approvedMd,
        testCase.title,
        testCase.module,
        testCase.testData,
        testCase.steps,
        testCase.expectedResult,
      ]
        .filter(Boolean)
        .join("\n");
      const domain = sutDomainConflict({
        tcText: tcBlob,
        primaryPath,
        codeAliases: input.codeAliases,
      });
      if (
        domain.conflict ||
        !isPacketSutAcceptable({
          tcText: tcBlob,
          primaryPath,
          sourceExcerpt: primaryContent,
          codeAliases: input.codeAliases,
        })
      ) {
        // Do not poison Extension with a wrong primary (domain mismatch / weak align).
        const emptyPacket: AITestContextPacket = {
          ...packet,
          files: [],
        };
        return {
          packet: emptyPacket,
          view: { ...view, primaryPath: "", primaryContent: "" },
          packetForApi: packetForApi(emptyPacket),
          primaryPath: "",
          primaryContent: "",
          planner,
          contextSource: "project-intelligence",
        };
      }
    } catch {
      /* keep packet if protocol unavailable */
    }
  }

  return {
    packet,
    view,
    packetForApi: packetForApi(packet),
    primaryPath,
    primaryContent,
    planner,
    contextSource: "project-intelligence",
  };
}

/**
 * Body helper: Desktop contextPacket (+ optional workspaceId for staging only).
 */
export type IdeLocalGenerateBody = {
  projectId: string;
  testCaseId: string;
  sourceFileName: string;
  sourceCode: string;
  contextPacket: Record<string, unknown>;
  framework: string;
  language?: string;
  className?: string;
  module?: string;
  /** Package root owning SUT (FS discovery). "" = repo-root AItest. */
  packagePrefix?: string | null;
  workspaceId?: string;
  openApiSpec?: string;
  /** P0 agent audit */
  agentConfidence?: number;
  agentEnough?: boolean;
  agentOverride?: boolean;
  contextSource?: string;
  /** Absolute local root — BE ProjectInspector (Step 2) */
  projectRoot?: string;
  /** Phase 5 — optional TestPlan (AAA hint); legacy API ignores if absent */
  planner?: import("./testPlanner/types").TestPlan;
  /** Phase 5 — mirror of packet files for clients that read contextFiles */
  contextFiles?: { path: string; content: string }[];
  /** Phase 5 — code index schema when index-backed */
  indexVersion?: string;
  /** Sprint 3 — unit conventions from .ai-test */
  projectRules?: string;
  projectRulesSource?: "unit-conventions" | "none";
};

export function buildIdeLocalGenerateBody(input: {
  projectId: string;
  testCaseId: string;
  packet: AITestContextPacket;
  sourceFileName: string;
  framework?: string;
  language?: string | null;
  className?: string;
  module?: string;
  /** Package root owning the source (from FS discovery). "" = repo root. */
  packagePrefix?: string | null;
  openApiSpec?: string;
  /** Optional — Apply/Verify staging; BE must prefer packet when present */
  workspaceId?: string | null;
  agentConfidence?: number;
  agentEnough?: boolean;
  agentOverride?: boolean;
  contextSource?: string;
  /** Absolute project root for stack inspect */
  projectRoot?: string | null;
  planner?: import("./testPlanner/types").TestPlan | null;
  indexVersion?: string | null;
  projectRules?: string | null;
  projectRulesSource?: "unit-conventions" | "none" | null;
}): IdeLocalGenerateBody {
  const primary = primaryFile(input.packet);
  const contextFiles = (input.packet.files || [])
    .filter((f) => f.pathRel && f.content != null)
    .map((f) => ({ path: f.pathRel, content: f.content }));
  return {
    projectId: input.projectId,
    testCaseId: input.testCaseId,
    sourceFileName: input.sourceFileName || primary?.pathRel || "",
    sourceCode: primary?.content || "",
    contextPacket: input.packet as unknown as Record<string, unknown>,
    framework: input.framework ?? "",
    language: input.language ?? undefined,
    className: input.className,
    module: input.module,
    ...(input.packagePrefix !== undefined && input.packagePrefix !== null
      ? { packagePrefix: input.packagePrefix }
      : {}),
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    ...(input.openApiSpec ? { openApiSpec: input.openApiSpec } : {}),
    ...(input.agentConfidence != null ? { agentConfidence: input.agentConfidence } : {}),
    ...(input.agentEnough != null ? { agentEnough: input.agentEnough } : {}),
    ...(input.agentOverride != null ? { agentOverride: input.agentOverride } : {}),
    ...(input.contextSource ? { contextSource: input.contextSource } : {}),
    ...(input.projectRoot ? { projectRoot: input.projectRoot } : {}),
    ...(input.planner ? { planner: input.planner } : {}),
    ...(contextFiles.length ? { contextFiles } : {}),
    ...(input.indexVersion ? { indexVersion: input.indexVersion } : {}),
    ...(input.projectRules != null ? { projectRules: input.projectRules } : {}),
    ...(input.projectRulesSource ? { projectRulesSource: input.projectRulesSource } : {}),
  };
}

export async function loadUnitProjectRules(projectRoot: string, maxChars = 8000): Promise<string> {
  const rel = ".ai-test/unit-conventions.md";
  const raw = await ideReadFile(projectRoot, rel).catch(() => "");
  const text = raw.trim();
  if (!text) return "";
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars) + "\n…[truncated]";
}
