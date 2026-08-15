/**
 * Gen fast-path: when Approve already emitted a HIGH .grounding.json that
 * matches MD markers, build the context packet from primary + deps without
 * re-running index retrieve / implementation-plan ranking.
 */
import {
  UNIT_GEN_LIMITS,
  primaryMatchesMarkers,
  stemOfPath,
} from "@aitest/ide-protocol";
import {
  UNIT_GROUNDING_CONTRACT_SCHEMA,
  type UnitSourceGroundingContract,
} from "../approvedTcSync/unitSourceGroundingContract";
import {
  CONTEXT_PACKET_VERSION,
  type AITestContextPacket,
} from "../contextPacket/types";
import { hashContent } from "../codeIndex/hashContent";

export type TcSourceMarkers = {
  paths: string[];
  codes: string[];
  related: string[];
};

function normPath(p: string): string {
  return (p || "").replace(/\\/g, "/").replace(/^\.\//, "");
}

export function parseUnitSourceGroundingContract(
  raw: string
): UnitSourceGroundingContract | null {
  try {
    const parsed = JSON.parse(raw) as UnitSourceGroundingContract;
    if (!parsed || typeof parsed !== "object") return null;
    if (parsed.schema !== UNIT_GROUNDING_CONTRACT_SCHEMA) return null;
    const pathRel = normPath(parsed.primary?.pathRel || "");
    const code = String(parsed.primary?.code || "").trim();
    if (!pathRel || !code) return null;
    return {
      ...parsed,
      primary: {
        ...parsed.primary,
        pathRel,
        code,
        typeName: String(parsed.primary.typeName || code.split(".")[0] || "").trim(),
      },
    };
  } catch {
    return null;
  }
}

/**
 * Eligible when Approve contract is authoritative and agrees with MD markers.
 * Fall back to planner on LOW confidence, stale index, or marker mismatch.
 */
export function isUnitGroundingFastPathEligible(
  contract: UnitSourceGroundingContract | null | undefined,
  markers: TcSourceMarkers
): contract is UnitSourceGroundingContract {
  if (!contract) return false;
  if (contract.authoritative !== true) return false;
  if (contract.freshness !== "fresh") return false;
  if (!contract.primary.contentHash) return false;
  if (contract.confidence !== "HIGH" && contract.confidence !== "MEDIUM") return false;
  const primary = normPath(contract.primary.pathRel);
  if (!primary) return false;
  if (markers.paths.length + markers.codes.length === 0) return false;
  if (!primaryMatchesMarkers(primary, markers)) return false;
  const code = String(contract.primary.code || "").trim().toLowerCase();
  if (markers.codes.length && code) {
    const codeOk = markers.codes.some((c) => {
      const m = String(c || "").trim().toLowerCase();
      return m === code || code.startsWith(`${m}.`) || m.startsWith(`${code}.`);
    });
    if (!codeOk) return false;
  }
  return true;
}

export type BuildPacketFromGroundingOpts = {
  projectRoot: string;
  projectId: string;
  testCaseId: string;
  language?: string;
  framework?: string;
  module?: string | null;
  contract: UnitSourceGroundingContract;
  readFile: (projectRoot: string, pathRel: string) => Promise<string>;
  maxPrimaryChars?: number;
  maxDepChars?: number;
  maxDeps?: number;
  /** Prefer dependencies whose symbols/body contain the bound BE property. */
  targetProperty?: string | null;
};

export async function buildPacketFromUnitGrounding(
  opts: BuildPacketFromGroundingOpts
): Promise<{ packet: AITestContextPacket; primaryPath: string } | null> {
  const primaryRel = normPath(opts.contract.primary.pathRel);
  if (!primaryRel) return null;

  const maxPrimary = opts.maxPrimaryChars ?? 14_000;
  const maxDep = opts.maxDepChars ?? UNIT_GEN_LIMITS.maxExcerptChars;
  const maxDeps = opts.maxDeps ?? UNIT_GEN_LIMITS.maxRelatedFiles;

  let primaryContent = "";
  try {
    primaryContent = await opts.readFile(opts.projectRoot, primaryRel);
  } catch {
    return null;
  }
  if (!primaryContent.trim()) return null;
  if (await hashContent(primaryContent) !== opts.contract.primary.contentHash) {
    return null;
  }
  if (primaryContent.length > maxPrimary) {
    primaryContent = primaryContent.slice(0, maxPrimary) + "\n/* …truncated… */";
  }

  const depCandidates = [
    ...(opts.contract.deps || []),
    ...(opts.contract.related || []).map((r) => r.pathRel),
  ]
    .map(normPath)
    .filter((p) => p && p.toLowerCase() !== primaryRel.toLowerCase());

  const seen = new Set<string>();
  const uniqueCandidates: string[] = [];
  for (const rel of depCandidates) {
    const key = rel.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    uniqueCandidates.push(rel);
  }
  // Bounded parallel reads: avoid one filesystem round-trip per related source.
  const loaded = await Promise.all(
    uniqueCandidates.slice(0, Math.max(maxDeps * 2, maxDeps)).map(async (rel) => {
      try {
        let content = await opts.readFile(opts.projectRoot, rel);
        if (!content.trim()) return null;
        if (content.length > maxDep) {
          content = content.slice(0, maxDep) + "\n/* …truncated… */";
        }
        return { rel, content };
      } catch {
        return null;
      }
    })
  );
  const targetProperty = String(opts.targetProperty || "").trim().toLowerCase();
  const ranked = loaded
    .filter((item): item is { rel: string; content: string } => Boolean(item))
    .sort((a, b) => {
      if (!targetProperty) return 0;
      const ah = a.content.toLowerCase().includes(targetProperty) ? 1 : 0;
      const bh = b.content.toLowerCase().includes(targetProperty) ? 1 : 0;
      return bh - ah;
    })
    .slice(0, maxDeps);
  const deps: AITestContextPacket["files"] = ranked.map(({ rel, content }) => ({
    pathRel: rel,
    role: "dependency",
    content,
    why:
      targetProperty && content.toLowerCase().includes(targetProperty)
        ? "grounding-contract-target-property"
        : "grounding-contract-deps",
  }));

  const symbol =
    opts.contract.primary.typeName ||
    opts.contract.primary.code.split(".")[0] ||
    stemOfPath(primaryRel);

  const packet: AITestContextPacket = {
    packetVersion: CONTEXT_PACKET_VERSION,
    purpose: "generate-unit",
    meta: {
      language: opts.language,
      framework: opts.framework,
      projectId: opts.projectId,
      testCaseId: opts.testCaseId,
      module: opts.module || undefined,
      testKind: "unit",
    },
    sourceUnderTest: {
      pathRel: primaryRel,
      symbol,
      methods: opts.contract.primary.methodName
        ? [opts.contract.primary.methodName]
        : undefined,
    },
    files: [
      {
        pathRel: primaryRel,
        role: "primary",
        content: primaryContent,
        why: "grounding-contract-primary",
      },
      ...deps,
    ],
    diagnostics: {
      truncated: [],
      omittedPaths: [],
      seedReason: "grounding-contract-fast-path",
      seedCandidates: [
        {
          pathRel: primaryRel,
          score: typeof opts.contract.score === "number" ? opts.contract.score : 1,
          reason: `grounding confidence=${opts.contract.confidence || "unknown"}`,
        },
      ],
    },
  };

  return { packet, primaryPath: primaryRel };
}
