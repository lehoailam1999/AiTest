/**
 * Ensure context packet primary matches planner/marker implementation —
 * never ship I* interface as role=primary when impl path is known.
 */
import {
  UNIT_GEN_LIMITS,
  isInterfaceLikePrimaryPath,
  promoteImplementationPrimary,
  stemOfPath,
} from "@aitest/ide-protocol";
import type { AITestContextPacket, ContextPacketFile } from "./types";

function toRepoRel(projectRoot: string, p: string): string {
  let r = (p || "").replace(/\\/g, "/");
  if (!r) return "";
  const root = (projectRoot || "").replace(/\\/g, "/").replace(/\/+$/, "");
  if (root) {
    const rl = root.toLowerCase();
    const pl = r.toLowerCase();
    if (pl === rl) return "";
    if (pl.startsWith(rl + "/")) r = r.slice(root.length).replace(/^\/+/, "");
  }
  if (/^[a-z]:\//i.test(r)) {
    const idx = r.toLowerCase().indexOf("/src/");
    if (idx >= 0) r = r.slice(idx + 1);
  }
  return r.replace(/^\/+/, "");
}

export type ForcePacketPrimaryOpts = {
  packet: AITestContextPacket;
  primaryRel: string;
  projectRoot: string;
  /** Read production file when packet lacks impl content */
  readFile?: (projectRoot: string, pathRel: string) => Promise<string>;
  maxPrimaryChars?: number;
};

/**
 * Rewrite packet so files[0] / role=primary is `primaryRel` (repo-relative).
 * Demotes other files to dependency; strips absolute paths.
 */
export async function forcePacketPrimary(
  opts: ForcePacketPrimaryOpts
): Promise<AITestContextPacket> {
  const { packet, projectRoot } = opts;
  let want = toRepoRel(projectRoot, opts.primaryRel);
  if (!want) return packet;

  const pool = [
    want,
    ...packet.files.map((f) => toRepoRel(projectRoot, f.pathRel)),
  ].filter(Boolean);
  if (isInterfaceLikePrimaryPath(want)) {
    const promoted = promoteImplementationPrimary(want, pool);
    if (promoted && promoted !== want) want = promoted;
  }

  const maxChars = opts.maxPrimaryChars ?? 14_000;
  let content =
    packet.files.find(
      (f) => toRepoRel(projectRoot, f.pathRel).toLowerCase() === want.toLowerCase()
    )?.content || "";
  if (!content.trim() && opts.readFile) {
    try {
      content = await opts.readFile(projectRoot, want);
    } catch {
      /* keep */
    }
  }
  if (content.length > maxChars) {
    content = content.slice(0, maxChars) + "\n/* …truncated… */";
  }

  const rest: ContextPacketFile[] = packet.files
    .map((f) => ({
      ...f,
      pathRel: toRepoRel(projectRoot, f.pathRel),
      role: "dependency" as const,
    }))
    .filter((f) => f.pathRel && f.pathRel.toLowerCase() !== want.toLowerCase())
    .slice(0, UNIT_GEN_LIMITS.maxRelatedFiles);

  const primary: ContextPacketFile = {
    pathRel: want,
    role: "primary",
    content,
    why: "forced-marker-or-planner-primary",
  };

  let symbol = packet.sourceUnderTest?.symbol;
  if (!symbol || isInterfaceLikePrimaryPath(`${symbol}.cs`)) {
    symbol = stemOfPath(want);
  }

  return {
    ...packet,
    sourceUnderTest: {
      ...packet.sourceUnderTest,
      pathRel: want,
      symbol,
    },
    files: [primary, ...rest],
  };
}
