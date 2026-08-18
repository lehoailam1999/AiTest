import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  parseGroundingCompanion,
  validateApprovedGroundingDecision,
  type ApprovedGroundingDecision,
  type CodeAliasMap,
} from "@aitest/ide-protocol";

export type UnitGroundingContract = ApprovedGroundingDecision;

export async function loadUnitGroundingContract(
  workspaceRoot: string,
  tcMdPath: string
): Promise<UnitGroundingContract | null> {
  const rel = tcMdPath.replace(/\\/g, "/");
  const jsonRel = rel.replace(/\.md$/i, ".grounding.json");
  const abs = path.join(workspaceRoot, jsonRel);
  try {
    // The file holds the v2 decision; consume its v1 projection.
    return parseGroundingCompanion(await fs.readFile(abs, "utf8"));
  } catch {
    return null;
  }
}

export function groundingRelatedPaths(contract: UnitGroundingContract | null): string[] {
  if (!contract) return [];
  const related = (contract.related || []).map((r) => r.pathRel).filter(Boolean);
  const deps = (contract.deps || []).filter(Boolean);
  return [...related, ...deps];
}

/** True when companion contract can authoritatively pin primary without disk re-rank. */
export function isAuthoritativeUnitGrounding(
  contract: UnitGroundingContract | null | undefined,
  markers?: { paths?: string[]; codes?: string[] }
): boolean {
  return validateApprovedGroundingDecision(contract, markers).ok;
}

function extractMarker(blob: string, key: string): string {
  const re = new RegExp(`^${key.replace(/\./g, "\\.")}\\s*:\\s*(.+)$`, "im");
  return (blob.match(re)?.[1] || "").trim();
}

/**
 * Apply optional code-aliases.fields + emit resolved target.property for Gen prompt.
 */
export function resolveTestDataForGen(
  tcMd: string,
  codeAliases?: CodeAliasMap | null
): { md: string; resolvedProperty?: string } {
  const fieldLabel =
    extractMarker(tcMd, "target.field") || extractMarker(tcMd, "target.property");
  const existingProp = extractMarker(tcMd, "target.property");
  if (existingProp && /^[A-Za-z_][\w]*$/.test(existingProp)) {
    return { md: tcMd, resolvedProperty: existingProp };
  }
  const fields = (codeAliases as { fields?: Record<string, string | string[]> } | null)
    ?.fields;
  if (!fieldLabel || !fields) return { md: tcMd };

  const aliases = fields[fieldLabel] || fields[fieldLabel.toLowerCase()];
  const prop = Array.isArray(aliases) ? aliases[0] : aliases;
  if (!prop || !/^[A-Za-z_][\w]*$/.test(String(prop))) return { md: tcMd };

  const lines = tcMd.split("\n");
  let inserted = false;
  const out = lines.map((line) => {
    if (/^target\.property:/i.test(line)) {
      inserted = true;
      return `target.property: ${prop}`;
    }
    return line;
  });
  if (!inserted) {
    const idx = out.findIndex((l) => /^target\.field:/i.test(l));
    if (idx >= 0) out.splice(idx + 1, 0, `target.property: ${prop}`);
    else out.push(`target.property: ${prop}`);
  }
  return { md: out.join("\n"), resolvedProperty: String(prop) };
}

export function inferDtoCandidatePaths(
  primaryPath: string,
  candidates: string[]
): string[] {
  const base = path.basename(primaryPath).replace(/\.[^.]+$/, "");
  const dtoStems = new Set<string>();
  let s = base
    .replace(/CommandHandler$/i, "")
    .replace(/Handler$/i, "")
    .replace(/Command$/i, "")
    .replace(/Service$/i, "");
  dtoStems.add(`${s}Dto`);
  const m = s.match(/^(.+?)(Create|Update|Delete|Add|Assign|Attach)(.*)$/i);
  if (m?.[1]) {
    dtoStems.add(`${m[1]}Dto`);
    dtoStems.add(`${m[1]}${m[2]}Dto`);
  }
  const lows = [...dtoStems].map((x) => x.toLowerCase());
  return candidates.filter((p) => {
    const b = path.basename(p).replace(/\.[^.]+$/, "").toLowerCase();
    return lows.some((stem) => b === stem || b.includes(stem) || stem.includes(b));
  });
}

export function plainRelatedExcerpt(relatedBlocks: string): string {
  return (relatedBlocks || "")
    .replace(/^###\s+[^\n]+\n```[^\n]*\n?/gm, "")
    .replace(/\n```/g, "")
    .trim();
}
