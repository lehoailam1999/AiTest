/**
 * EX5.1 — helpers for E2E Files tab preview (POM / Spec).
 */
import type { E2EFileDto } from "../../api";

/** Prefer primary Spec, then Page Object, then first file. */
export function pickDefaultE2ePreviewPath(
  files: Array<Pick<E2EFileDto, "path" | "kind">>
): string | null {
  if (!files.length) return null;
  const byKind = (k: string) =>
    files.find((f) => (f.kind || "").toLowerCase() === k)?.path ?? null;
  return (
    byKind("spec") ||
    byKind("page") ||
    byKind("config") ||
    byKind("fixture") ||
    files[0]?.path ||
    null
  );
}

/** Strip leading ./ and normalize slashes for IDE pathRel. */
export function toIdePathRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}
