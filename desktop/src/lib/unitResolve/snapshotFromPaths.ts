/**
 * Minimal CodeIndexSnapshot from path list (tests / path-index bridge).
 */
import type { CodeIndexSnapshot } from "../codeIndex/types";

export function snapshotFromPaths(paths: string[]): CodeIndexSnapshot {
  const now = new Date().toISOString();
  const files: CodeIndexSnapshot["files"] = {};
  const symbolsByFile: CodeIndexSnapshot["symbolsByFile"] = {};
  const symbolIndex: CodeIndexSnapshot["symbolIndex"] = {};
  for (const p of paths) {
    const pathRel = p.replace(/\\/g, "/");
    const stem =
      pathRel.split("/").pop()?.replace(/\.[^.]+$/, "") || "Unknown";
    files[pathRel] = {
      pathRel,
      language: pathRel.endsWith(".cs") ? "cs" : "ts",
      contentHash: "t",
      byteSize: 1,
      symbolCount: 1,
      importCount: 0,
      indexedAt: now,
    };
    symbolsByFile[pathRel] = [
      { name: stem, kind: "class", line: 1, exported: true },
    ];
    const k = stem.toLowerCase();
    symbolIndex[k] = [...(symbolIndex[k] || []), pathRel];
  }
  return {
    meta: {
      schema: "aitest-code-index-v1",
      createdAt: now,
      updatedAt: now,
      fileCount: paths.length,
      symbolCount: paths.length,
      edgeCount: 0,
      parser: "lightweight-ts-js-cs-v1",
    },
    files,
    symbolsByFile,
    importsByFile: {},
    exportsByFile: {},
    symbolIndex,
    dependencyGraph: {},
  };
}
