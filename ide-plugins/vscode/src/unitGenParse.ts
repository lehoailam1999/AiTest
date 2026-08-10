/**
 * Pure helpers for Extension Unit Gen (testable without vscode).
 */
import * as path from "node:path";
import {
  isInterfaceLikePrimaryPath,
  promoteImplementationPrimary,
} from "@aitest/ide-protocol";

export function stripCodeFences(raw: string): string {
  const text = (raw || "").trim();
  if (!text) return "";
  const fence = text.match(/```(?:[\w.+-]*)\s*\n([\s\S]*?)```/);
  if (fence?.[1]) return fence[1].trim();
  return text;
}

function normRel(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Absolute or rooted path → repo-relative under workspace root. */
export function toRepoRelativePath(root: string, pathRel: string): string {
  const r = (root || "").replace(/\\/g, "/").replace(/\/+$/, "");
  let p = (pathRel || "").replace(/\\/g, "/");
  if (!p) return p;
  if (r) {
    const rl = r.toLowerCase();
    const pl = p.toLowerCase();
    if (pl === rl) return "";
    if (pl.startsWith(rl + "/")) p = p.slice(r.length).replace(/^\/+/, "");
  }
  if (path.isAbsolute(pathRel) || /^[a-z]:\//i.test(p)) {
    try {
      p = path.relative(root, pathRel).replace(/\\/g, "/");
    } catch {
      /* keep */
    }
  }
  return normRel(p);
}

export function excerptFromContextPacket(packet: unknown): {
  primaryPath?: string;
  source?: string;
  related?: string;
} {
  if (!packet || typeof packet !== "object") return {};
  const p = packet as Record<string, unknown>;
  const files = Array.isArray(p.files) ? p.files : [];
  const typed = files.filter((f): f is Record<string, unknown> => !!f && typeof f === "object");
  let primary =
    typed.find((f) => String(f.role || "") === "primary") || typed[0];
  // Prefer concrete impl over I* when packet still ships interface as primary
  if (primary) {
    const primPath = String(primary.pathRel || primary.path || "");
    if (isInterfaceLikePrimaryPath(primPath)) {
      const pool = typed.map((f) => String(f.pathRel || f.path || "")).filter(Boolean);
      const promoted = promoteImplementationPrimary(primPath, pool);
      if (promoted && promoted !== primPath) {
        const alt = typed.find(
          (f) =>
            String(f.pathRel || f.path || "").replace(/\\/g, "/").toLowerCase() ===
            promoted.replace(/\\/g, "/").toLowerCase()
        );
        if (alt) primary = alt;
      }
    }
  }
  const related = typed.filter((f) => f !== primary).slice(0, 3);
  const primaryPath = primary
    ? String(primary.pathRel || primary.path || "").replace(/\\/g, "/")
    : undefined;
  const source = primary ? String(primary.content || "").slice(0, 14_000) : undefined;
  const relatedBlocks = related
    .map((f) => {
      const rel = String(f.pathRel || f.path || "");
      const body = String(f.content || "").slice(0, 2500);
      return rel && body ? `### ${rel}\n\`\`\`\n${body}\n\`\`\`` : "";
    })
    .filter(Boolean)
    .join("\n\n");
  return { primaryPath, source, related: relatedBlocks || undefined };
}
