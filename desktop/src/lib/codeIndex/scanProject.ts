import {
  shouldIndexPath,
  CODE_INDEX_EXTENSIONS,
  toProjectRelativePath,
} from "./constants";
import type { CodeIndexIo } from "./types";

export type ScanProjectOptions = {
  /** Override extensions (default Phase 1 TS/JS). */
  extensions?: string[];
};

/**
 * List indexable source paths under projectRoot.
 * Relies on Tauri `list_source_files` (already skips node_modules/dist/…) + local filter.
 */
export async function scanProjectFiles(
  projectRoot: string,
  io: CodeIndexIo,
  opts?: ScanProjectOptions
): Promise<string[]> {
  const exts = opts?.extensions ?? [...CODE_INDEX_EXTENSIONS];
  const listed = await io.listFiles(projectRoot, exts);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of listed) {
    const pathRel = toProjectRelativePath(projectRoot, raw);
    if (!shouldIndexPath(pathRel)) continue;
    if (seen.has(pathRel)) continue;
    seen.add(pathRel);
    out.push(pathRel);
  }
  out.sort((a, b) => a.localeCompare(b));
  return out;
}
