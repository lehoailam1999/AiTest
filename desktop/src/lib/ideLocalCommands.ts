/**
 * IDE-local interactive commands for Generate Unit / API.
 * Desktop owns filesystem read; Backend only receives ephemeral contextPacket.
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
};

export type BuildGenerateContextResult = {
  packet: AITestContextPacket;
  /** Compact view for UI panels */
  view: UnitContextPacket;
  /** Ready for POST generate-* */
  packetForApi: AITestContextPacket;
  primaryPath: string;
  primaryContent: string;
};

/**
 * buildUnitContext — IDE-local closure + testing hints → contextPacket.
 * Does not call Backend; does not persist source.
 */
export async function buildGenerateContext(
  input: BuildGenerateContextInput
): Promise<BuildGenerateContextResult> {
  const policy = input.broadLocalContext ? BROAD_CONTEXT_POLICY : DEFAULT_CONTEXT_POLICY;
  const packet = await buildContextPacket({
    purpose: input.purpose ?? "generate-unit",
    projectRoot: input.projectRoot,
    language: input.language,
    framework: input.framework,
    projectId: input.projectId,
    testCase: input.testCase,
    allSourcePaths: input.allSourcePaths,
    manualPrimaryPath: input.manualPrimaryPath,
    policy,
    codeAliases: input.codeAliases,
    forcedRelatedPaths: input.forcedRelatedPaths,
  });

  const primary = primaryFile(packet);
  const view = toUnitContextView(packet);
  return {
    packet,
    view,
    packetForApi: packetForApi(packet),
    primaryPath: primary?.pathRel ?? view.primaryPath ?? "",
    primaryContent: primary?.content ?? view.primaryContent ?? "",
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
}): IdeLocalGenerateBody {
  const primary = primaryFile(input.packet);
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
  };
}
