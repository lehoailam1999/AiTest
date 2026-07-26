import type { Project, ProjectMeta } from "../api/types";
import type { ProjectScan } from "../tauri/bridge";

export function buildProjectMetaFromScan(
  scan: ProjectScan,
  _existingMeta?: ProjectMeta | null
): ProjectMeta {
  const frameworks = scan.frameworks ?? [];
  const syncedAt = new Date().toISOString();

  return {
    frameworks,
    testFrameworks: scan.testFrameworks ?? [],
    stacks: scan.stacks ?? [],
    solutionCount: (scan.solutionFiles ?? []).length,
    csprojCount: (scan.csprojFiles ?? []).length,
    testProjectCount: (scan.testProjects ?? []).length,
    sdkVersion: scan.dotnetVersion ?? null,
    scanName: scan.name,
    modules: (scan.modules ?? []).map((m) => ({
      name: m.name,
      language: m.language,
      frameworks: m.frameworks,
      stacks: m.stacks,
    })),
    syncedAt,
  };
}

export function projectImportSummary(project: Project): string {
  const meta = project.meta;
  if (!meta?.syncedAt) {
    return "Chưa import";
  }
  const parts: string[] = [];
  if (project.language) parts.push(project.language);
  if (project.framework) parts.push(project.framework);
  const stack = parts.length > 0 ? parts.join(" · ") : "—";
  return stack;
}

export function formatSyncedAt(iso?: string | null): string {
  if (!iso) return "Chưa đồng bộ";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "Chưa đồng bộ";
  return d.toLocaleString("vi-VN");
}

/** API may return meta as object; tolerate legacy string payloads. */
export function normalizeProjectMeta(meta: ProjectMeta | string | null | undefined): ProjectMeta | null {
  if (!meta) return null;
  if (typeof meta === "string") {
    try {
      const parsed = JSON.parse(meta) as ProjectMeta;
      return typeof parsed === "object" && parsed !== null ? parsed : null;
    } catch {
      return null;
    }
  }
  return meta;
}

export function metaSyncedAt(meta: ProjectMeta | null | undefined): string | null {
  if (!meta) return null;
  return meta.syncedAt ?? null;
}

/** Throws if server project has no persisted sync timestamp. */
export function assertProjectSynced(project: Project, projectId: string): void {
  if (project.id !== projectId) {
    throw new Error(`Phản hồi server không khớp dự án (expected ${projectId}).`);
  }
  const meta = normalizeProjectMeta(project.meta);
  const syncedAt = metaSyncedAt(meta ?? undefined);
  if (!syncedAt) {
    const hint =
      project.meta == null
        ? "Server trả meta = null (API có thể chưa hỗ trợ lưu meta — hãy restart API Python trên port 5000)."
        : typeof project.meta === "string"
          ? "Server trả meta dạng chuỗi không parse được."
          : "meta không có syncedAt.";
    throw new Error(
      `Server chưa xác nhận đồng bộ (${hint}) Hãy đăng nhập lại và thử sync lần nữa.`
    );
  }
}
