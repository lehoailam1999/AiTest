import { sutDomainConflict } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { isUnsuitableUnitPrimary } from "../retrieval/rankScore";
import type { CodeAliasMap } from "./viCodeAliases";

/** Same TC blob shape as buildGenerateContext domain gate. */
export function tcBlobForUnitScope(tc: TestCase, extraMd?: string | null): string {
  return [
    extraMd,
    tc.title,
    tc.module,
    tc.testData,
    tc.precondition,
    tc.steps,
    tc.expectedResult,
  ]
    .filter(Boolean)
    .join("\n");
}

/**
 * Path-only Unit scope gate (no file contents).
 * Shared by Local FS UI resolve and FE AI scope — must match Gen fail-closed intent.
 */
export function isAcceptableUnitScopePath(opts: {
  pathRel: string;
  tcText: string;
  codeAliases?: CodeAliasMap | null;
}): boolean {
  const p = (opts.pathRel || "").replace(/\\/g, "/").trim();
  if (!p) return false;
  if (isUnsuitableUnitPrimary(p)) return false;
  if (
    sutDomainConflict({
      tcText: opts.tcText,
      primaryPath: p,
      codeAliases: opts.codeAliases,
    }).conflict
  ) {
    return false;
  }
  return true;
}

export function pickFirstAcceptableUnitScopePath(
  paths: Iterable<string>,
  opts: { tcText: string; codeAliases?: CodeAliasMap | null }
): string | null {
  for (const raw of paths) {
    const p = (raw || "").replace(/\\/g, "/");
    if (isAcceptableUnitScopePath({ pathRel: p, tcText: opts.tcText, codeAliases: opts.codeAliases })) {
      return p;
    }
  }
  return null;
}
