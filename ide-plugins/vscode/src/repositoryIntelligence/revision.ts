import type {
  RepositoryRevision,
  RepositoryRevisionExpectation,
  UnitApproveReason,
} from "@aitest/ide-protocol";
import { hashParts, sha256 } from "./hash";
import type { RepositoryRuntime } from "./runtime";

function normalizeRoot(root: string): string {
  return root.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

export async function captureRepositoryRevision(
  runtime: RepositoryRuntime
): Promise<RepositoryRevision> {
  const root = runtime.workspaceRoot();
  if (!root) throw new Error("No workspace folder");
  const workspaceId = sha256(normalizeRoot(root));
  const dirtyDocs = await runtime.dirtyDocuments();
  const editorState = dirtyDocs
    .map((doc) => [doc.pathRel.replace(/\\/g, "/"), sha256(doc.text)] as const)
    .sort(([a], [b]) => a.localeCompare(b));

  try {
    const [head, status, diff] = await Promise.all([
      runtime.git(["rev-parse", "HEAD"]),
      runtime.git(["status", "--porcelain=v1", "-z", "--untracked-files=normal"]),
      runtime.git(["diff", "--no-ext-diff", "--binary", "HEAD"]),
    ]);
    const untrackedState: Array<readonly [string, ReturnType<typeof sha256>]> = [];
    for (const entry of status.split("\0").filter(Boolean)) {
      if (!entry.startsWith("?? ")) continue;
      const pathRel = entry.slice(3).replace(/\\/g, "/");
      const doc = await runtime.readDocument(pathRel, 1024 * 1024);
      if (doc) untrackedState.push([pathRel, sha256(doc.text)]);
    }
    const dirty = Boolean(status || editorState.length);
    return {
      workspaceId,
      vcs: "git",
      head: head.trim(),
      dirty,
      dirtyFingerprint: dirty
        ? hashParts([status, diff, untrackedState, editorState])
        : undefined,
      capturedAt: runtime.now().toISOString(),
    };
  } catch {
    const dirty = editorState.length > 0;
    return {
      workspaceId,
      vcs: "none",
      dirty,
      dirtyFingerprint: dirty ? hashParts(editorState) : undefined,
      capturedAt: runtime.now().toISOString(),
    };
  }
}

export function compareRepositoryRevision(
  actual: RepositoryRevision,
  expected: RepositoryRevisionExpectation | undefined
): UnitApproveReason[] {
  if (!expected) return [];
  const reasons: UnitApproveReason[] = [];
  if (expected.workspaceId !== actual.workspaceId) {
    reasons.push({
      code: "WORKSPACE_MISMATCH",
      message: "The request targets a different workspace.",
      retryable: false,
    });
  }
  if (expected.head !== undefined && expected.head !== actual.head) {
    reasons.push({
      code: "STALE_REPOSITORY",
      message: "Repository HEAD changed after the test case was prepared.",
      retryable: true,
    });
  }
  if (
    expected.dirtyFingerprint !== undefined &&
    expected.dirtyFingerprint !== actual.dirtyFingerprint
  ) {
    reasons.push({
      code: "STALE_EDITOR",
      message: "Workspace or editor contents changed after the test case was prepared.",
      retryable: true,
    });
  }
  return reasons;
}
