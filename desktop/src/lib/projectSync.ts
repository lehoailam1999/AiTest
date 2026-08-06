import type { Project, ProjectMeta } from "../api/types";
import type { ProjectScan } from "../tauri/bridge";

function seedAiRules(
  meta: ProjectMeta,
  projectAutoSeed?: string | null
): NonNullable<ProjectMeta["aiRules"]> {
  const prev = meta.aiRules ?? {};
  const locked = Boolean(prev.lockProjectAuto);
  const seeded = (projectAutoSeed || "").trim();
  const auto = seeded;
  const next = { ...prev };
  if (auto && (!locked || !String(prev.projectAuto || "").trim())) {
    next.projectAuto = auto;
  }
  return next;
}

export function buildProjectAutoFromProfileConventions(input: {
  e2eConventions?: string | null;
  unitConventions?: string | null;
}): string {
  const e2e = (input.e2eConventions || "").trim();
  const unit = (input.unitConventions || "").trim();
  const blocks: string[] = [];
  if (e2e) blocks.push(`## E2E profile conventions\n${e2e}`);
  if (unit) blocks.push(`## Unit profile conventions\n${unit}`);
  if (!blocks.length) return "";
  return `QUY TẮC DỰ ÁN (auto — project profile)\n\n${blocks.join("\n\n")}`;
}

export function buildProjectMetaFromScan(
  scan: ProjectScan,
  existingMeta?: ProjectMeta | null,
  languageOverride?: string | null,
  options?: { projectAutoSeed?: string | null }
): ProjectMeta {
  const frameworks = scan.frameworks ?? [];
  const syncedAt = new Date().toISOString();
  const prev = existingMeta ?? null;
  const language = languageOverride ?? scan.language ?? prev?.scanLanguage ?? null;

  const base: ProjectMeta = {
    frameworks,
    testFrameworks: scan.testFrameworks ?? [],
    stacks: scan.stacks ?? [],
    solutionCount: (scan.solutionFiles ?? []).length,
    csprojCount: (scan.csprojFiles ?? []).length,
    testProjectCount: (scan.testProjects ?? []).length,
    sdkVersion: scan.dotnetVersion ?? null,
    scanName: scan.name,
    scanLanguage: language ?? undefined,
    modules: (scan.modules ?? []).map((m) => ({
      name: m.name,
      language: m.language,
      frameworks: m.frameworks,
      stacks: m.stacks,
    })),
    syncedAt,
    // Preserve user settings across stack re-scan (EX4.3)
    codeAliases: prev?.codeAliases,
    e2e: prev?.e2e,
    aiRules: prev?.aiRules,
  };

  return {
    ...base,
    aiRules: seedAiRules(base, options?.projectAutoSeed),
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
