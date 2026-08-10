/**
 * Pure disk write for Approved TC markdown (no Tauri / IDE).
 * Used by Desktop sync + Node tests / scripts.
 */
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ApprovedTcMdFile } from "./approvedTcMarkdown";

export function writeApprovedTcMdFilesToDisk(
  projectRoot: string,
  files: ApprovedTcMdFile[]
): { written: string[]; errors: string[] } {
  const root = projectRoot.trim();
  const written: string[] = [];
  const errors: string[] = [];
  if (!root) {
    return { written, errors: ["projectRoot trống"] };
  }
  for (const f of files) {
    try {
      const rel = f.path.replace(/\\/g, "/").replace(/^\/+/, "");
      const abs = join(root, ...rel.split("/"));
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, f.content ?? "", "utf8");
      if (!existsSync(abs)) {
        errors.push(`${rel}: write claimed ok but file missing`);
        continue;
      }
      written.push(rel);
    } catch (e) {
      errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, errors };
}
