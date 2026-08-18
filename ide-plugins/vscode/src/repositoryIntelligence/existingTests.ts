import type {
  ExistingTestEvidence,
  GroundedSymbol,
  SourceRange,
} from "@aitest/ide-protocol";
import { sha256 } from "./hash";
import type { RepoDocument, RepositoryRuntime } from "./runtime";

const TEST_PATH = /(^|[\\/])(tests?|spec|specs|__tests__)([\\/]|$)|\.(test|spec|tests)\.[cm]?[jt]sx?$|tests?\.cs$|test[a-z0-9_]*\.py$/i;

function isTestPath(pathRel: string): boolean {
  return TEST_PATH.test(pathRel.replace(/\\/g, "/"));
}

function frameworkOf(doc: RepoDocument): ExistingTestEvidence["framework"] {
  const text = doc.text;
  if (/from\s+["']vitest["']|\bvi\.(fn|mock)\b/.test(text)) return "vitest";
  if (/@jest\/globals|jest\.(fn|mock)\b/.test(text)) return "jest";
  if (/\[Fact\]|\[Theory\]|using\s+Xunit/.test(text)) return "xunit";
  if (/\[Test\]|using\s+NUnit/.test(text)) return "nunit";
  if (/import\s+pytest|def\s+test_/.test(text)) return "pytest";
  if (/org\.junit|@Test\b/.test(text)) return "junit";
  return undefined;
}

/**
 * Existing tests are discovered from real references to the primary symbol so a
 * later codegen step can extend instead of duplicating coverage.
 */
export async function findExistingTests(
  primary: GroundedSymbol,
  runtime: RepositoryRuntime,
  limits: { maxExistingTests: number; maxReferences: number; maxFileBytes: number }
): Promise<readonly ExistingTestEvidence[]> {
  if (limits.maxExistingTests <= 0) return [];
  let references: { pathRel: string; range?: SourceRange }[] = [];
  try {
    const result = await runtime.references({
      symbolId: primary.symbolId,
      maxResults: limits.maxReferences,
    });
    references = result.refs.map((ref) => ({
      pathRel: ref.file.replace(/\\/g, "/"),
      range: ref.range
        ? {
            start: { line: ref.range.start, character: ref.range.startCharacter || 0 },
            end: { line: ref.range.end, character: ref.range.endCharacter || 0 },
          }
        : undefined,
    }));
  } catch {
    references = [];
  }

  const grouped = new Map<string, SourceRange[]>();
  for (const reference of references) {
    if (!isTestPath(reference.pathRel)) continue;
    if (reference.pathRel.toLowerCase() === primary.pathRel.toLowerCase()) continue;
    const ranges = grouped.get(reference.pathRel) || [];
    if (reference.range) ranges.push(reference.range);
    grouped.set(reference.pathRel, ranges);
    if (grouped.size >= limits.maxExistingTests) break;
  }

  const out: ExistingTestEvidence[] = [];
  for (const [pathRel, referenceRanges] of grouped) {
    const doc = await runtime.readDocument(pathRel, limits.maxFileBytes);
    if (!doc?.text) continue;
    out.push({
      pathRel,
      fileHash: sha256(doc.text),
      framework: frameworkOf(doc),
      relationship: "references_primary",
      referenceRanges,
    });
  }
  return out;
}
