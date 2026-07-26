/**
 * FE helpers — Backend Workspace Manager (scan/search/read).
 * React không list/read disk trực tiếp cho generate flow.
 * Generate gửi workspaceId + paths; BE đọc disk. FE chỉ read qua API cho preview UI.
 */

import { workspaceApi, type WorkspaceFileMeta } from "../../api";
import { workspace } from "../../workspace";

export function getActiveWorkspaceId(projectId: string | undefined): string | null {
  if (!projectId) return null;
  return workspace.getWorkspaceId(projectId);
}

export async function ensureWorkspaceOpen(
  projectId: string,
  rootPath: string
): Promise<string> {
  const existing = workspace.getWorkspaceId(projectId);
  if (existing) {
    try {
      const st = await workspaceApi.status(existing);
      if (st.status === "ready" || st.status === "indexing") {
        return existing;
      }
    } catch {
      workspace.clearWorkspaceId(projectId);
      /* reopen below */
    }
  }
  const session = await workspaceApi.open({ projectId, rootPath });
  workspace.setWorkspaceId(projectId, session.workspaceId);
  for (let i = 0; i < 60; i++) {
    const st = await workspaceApi.status(session.workspaceId);
    if (st.status === "ready" || st.status === "error") break;
    await new Promise((r) => setTimeout(r, 200));
  }
  return session.workspaceId;
}

export async function listWorkspaceSourceFiles(
  workspaceId: string,
  opts?: { ext?: string; limit?: number }
): Promise<string[]> {
  const limit = opts?.limit ?? 2000;
  const ext = opts?.ext;
  const paths: string[] = [];
  let cursor = 0;
  while (paths.length < limit) {
    const page = await workspaceApi.files(workspaceId, {
      ext,
      limit: 500,
      cursor,
    });
    for (const item of page.items) {
      paths.push(item.relativePath);
    }
    cursor += page.items.length;
    if (cursor >= page.totalCount || page.items.length === 0) break;
  }
  return paths;
}

export async function searchWorkspaceFiles(
  workspaceId: string,
  query: string,
  by: "name" | "ext" | "token" | "keyword" = "name",
  limit = 80
): Promise<WorkspaceFileMeta[]> {
  const res = await workspaceApi.search(workspaceId, { by, query, limit });
  return res.items;
}

export async function readWorkspaceFiles(
  workspaceId: string,
  paths: string[],
  maxBytesPerFile = 400_000
): Promise<Array<{ path: string; content: string; error?: string }>> {
  if (!paths.length) return [];
  const res = await workspaceApi.read(workspaceId, { paths, maxBytesPerFile });
  return (res.files || []).map((f) => ({
    path: f.relativePath,
    content: f.content || "",
    error: f.error || undefined,
  }));
}

export async function resolveWorkspaceScope(
  workspaceId: string,
  testCaseId: string,
  useAiTokens = true
) {
  return workspaceApi.resolveScope(workspaceId, { testCaseId, useAiTokens });
}
