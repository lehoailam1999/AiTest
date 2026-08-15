/** Phase 1 paths + language filters. */

/** Persist path under project root (JSON document; Sprint 1b → real SQLite). */
export const CODE_INDEX_REL_PATH = ".ai-test/index.db";

export const CODE_INDEX_SCHEMA = "aitest-code-index-v1" as const;

export const CODE_INDEX_PARSER = "lightweight-ts-js-cs-v1";

/** Extensions indexed (TS/JS + lightweight C# for .NET Approve). */
export const CODE_INDEX_EXTENSIONS = [".ts", ".tsx", ".js", ".jsx", ".cs"] as const;

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

/** Normalize scanner/index paths to repository-relative; reject absolute paths outside root. */
export function toProjectRelativePath(projectRoot: string, pathLike: string): string {
  const root = projectRoot.replace(/\\/g, "/").replace(/\/+$/, "");
  const raw = String(pathLike || "").replace(/\\/g, "/").trim();
  if (!raw) return "";
  const rawLow = raw.toLowerCase();
  const rootLow = root.toLowerCase();
  if (rawLow === rootLow) return "";
  if (rawLow.startsWith(`${rootLow}/`)) {
    return normalizeRelPath(raw.slice(root.length + 1));
  }
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("/")) return "";
  return normalizeRelPath(raw);
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

export function languageFromPath(
  pathRel: string
): "ts" | "tsx" | "js" | "jsx" | "cs" | null {
  const lower = normalizeRelPath(pathRel).toLowerCase();
  if (lower.endsWith(".tsx")) return "tsx";
  if (lower.endsWith(".ts")) return "ts";
  if (lower.endsWith(".jsx")) return "jsx";
  if (lower.endsWith(".js")) return "js";
  if (lower.endsWith(".cs")) return "cs";
  return null;
}
