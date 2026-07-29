/**
 * Step 1 — Shared “Mở mã nguồn”:
 * pick/scan folder → localPath → BE workspace session → sync meta (không upload source).
 * Dùng chung cho mọi loại test (unit / api / integration…).
 */

import { projects, workspaceApi } from "../../api";
import { assertApiReadyForSync } from "../../api/health";
import type { Project } from "../../api/types";
import { isTauri, pickProjectFolder, scanProject, type ProjectScan } from "../../tauri/bridge";
import { workspace } from "../../workspace";
import { ensureWorkspaceOpen } from "./client";

export type BindSourceRootInput = {
  projectId: string;
  projectName: string;
  /** Absolute path; if omitted, opens Tauri folder dialog */
  rootPath?: string;
  /** Wait for BE index ready/error (default true) */
  waitForIndex?: boolean;
  /** Sync language/framework to API (default true when Tauri) */
  syncMeta?: boolean;
  /** Force full BE index refresh after open (Rescan) */
  refreshIndex?: boolean;
};

export type BindSourceRootResult = {
  scan: ProjectScan;
  rootPath: string;
  workspaceId: string | null;
  indexStatus: string | null;
  fileCount: number | null;
  syncedProject: Project | null;
  syncError: string | null;
  openError: string | null;
};

export type SyncSourceMetaInput = {
  projectId: string;
  scan: ProjectScan;
};

/**
 * Sync stack meta only (no source). Safe to call after bind or “Đồng bộ stack”.
 */
export async function syncSourceMeta(input: SyncSourceMetaInput): Promise<Project> {
  await assertApiReadyForSync();
  await projects.update(input.projectId, {
    language: input.scan.language ?? null,
    framework: (input.scan.frameworks ?? [])[0] ?? null,
  });
  return projects.get(input.projectId);
}

/**
 * Bind local source root for a project.
 * BE owns file read later via workspaceId — FE only stores path + opens session.
 */
export async function bindSourceRoot(
  input: BindSourceRootInput
): Promise<BindSourceRootResult> {
  if (!isTauri()) {
    throw new Error("Cần chạy Desktop (Tauri) để mở mã nguồn trên máy.");
  }

  let path = (input.rootPath || "").trim();
  if (!path) {
    const picked = await pickProjectFolder();
    if (!picked) {
      throw new Error("Đã hủy chọn thư mục.");
    }
    path = picked.trim();
  }

  const scan = await scanProject(path);
  const rootPath = scan.projectPath;
  workspace.setLocalPath(input.projectId, rootPath);
  workspace.addRecent(input.projectId, input.projectName, rootPath);

  let workspaceId: string | null = null;
  let indexStatus: string | null = null;
  let fileCount: number | null = null;
  let openError: string | null = null;

  try {
    await assertApiReadyForSync();
    workspaceId = await ensureWorkspaceOpen(input.projectId, rootPath);
    if (input.refreshIndex && workspaceId) {
      try {
        await workspaceApi.refresh(workspaceId, { full: true });
      } catch {
        /* open already succeeded */
      }
    }
    if (input.waitForIndex !== false && workspaceId) {
      for (let i = 0; i < 40; i++) {
        const st = await workspaceApi.status(workspaceId);
        indexStatus = st.status;
        fileCount = st.fileCount;
        if (st.status === "ready" || st.status === "error") break;
        await new Promise((r) => setTimeout(r, 250));
      }
    }
  } catch (e) {
    openError = e instanceof Error ? e.message : "Không mở được phiên mã nguồn trên server";
  }

  let syncedProject: Project | null = null;
  let syncError: string | null = null;
  const doSync = input.syncMeta !== false;
  if (doSync) {
    try {
      syncedProject = await syncSourceMeta({
        projectId: input.projectId,
        scan,
      });
    } catch (e) {
      syncError = e instanceof Error ? e.message : "Đồng bộ stack thất bại";
    }
  }

  return {
    scan,
    rootPath,
    workspaceId,
    indexStatus,
    fileCount,
    syncedProject,
    syncError,
    openError,
  };
}

/** Open folder dialog then bind. Returns null if user cancels. */
export async function pickAndBindSourceRoot(
  input: Omit<BindSourceRootInput, "rootPath">
): Promise<BindSourceRootResult | null> {
  if (!isTauri()) {
    throw new Error("Cần chạy Desktop (Tauri) để mở mã nguồn trên máy.");
  }
  const picked = await pickProjectFolder();
  if (!picked) return null;
  return bindSourceRoot({ ...input, rootPath: picked });
}
