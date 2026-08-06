/** Phase 1 paths + language filters. */

/** Persist path under project root (JSON document; Sprint 1b → real SQLite). */
export const CODE_INDEX_REL_PATH = ".ai-test/index.db";

export const CODE_INDEX_SCHEMA = "aitest-code-index-v1" as const;

export const CODE_INDEX_PARSER = "lightweight-ts-js-v1";

/** Extensions indexed in Phase 1 (TS/JS first). */
export const CODE_INDEX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx"] as const;

/** Dir name segments to skip when filtering list paths (defense in depth). */
export const CODE_INDEX_SKIP_DIR_SEGMENTS = new Set(
  [
    "node_modules",
    "dist",
    "build",
    "out",
    ".git",
    ".svn",
    "coverage",
    ".next",
    ".nuxt",
    ".turbo",
    "vendor",
    "__pycache__",
    ".venv",
    "venv",
    "target",
    "bin",
    "obj",
    ".ai-test",
  ].map((s) => s.toLowerCase())
);

export function normalizeRelPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function shouldIndexPath(pathRel: string): boolean {
  const norm = normalizeRelPath(pathRel);
  if (!norm || norm.startsWith(".")) return false;
  const parts = norm.split("/");
  for (const part of parts.slice(0, -1)) {
    if (CODE_INDEX_SKIP_DIR_SEGMENTS.has(part.toLowerCase())) return false;
    if (part.startsWith(".") && part !== ".") return false;
  }
  const lower = norm.toLowerCase();
  return CODE_INDEX_EXTENSIONS.some((ext) => lower.endsWith(ext));
}

export function languageFromPath(pathRel: string): "ts" | "tsx" | "js" | "jsx" | null {
  const lower = normalizeRelPath(pathRel).toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "js";
  return null;
}
