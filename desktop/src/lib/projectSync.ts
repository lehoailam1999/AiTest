import type { Project, ProjectMeta } from "../api/types";
import type { ProjectScan } from "../tauri/bridge";

/** Mirror BE synthesize_project_auto_rules — keep short & stack-focused. */
export function synthesizeProjectAutoRules(
  meta: ProjectMeta,
  language?: string | null
): string {
  const lines: string[] = ["QUY TẮC DỰ ÁN (auto — từ stack scan):"];
  const lang = (language || meta.scanLanguage || "").trim();
  const frameworks = meta.frameworks ?? [];
  const testFws = meta.testFrameworks ?? [];
  const stacks = meta.stacks ?? [];
  const modules = meta.modules ?? [];

  if (lang) lines.push(`- Ngôn ngữ chính (scan): ${lang}.`);
  if (frameworks.length) {
    lines.push(`- Framework ứng dụng: ${frameworks.filter(Boolean).slice(0, 8).join(", ")}.`);
  }
  if (testFws.length) {
    lines.push(
      `- Test framework phát hiện: ${testFws.filter(Boolean).slice(0, 8).join(", ")}. Ưu tiên khi sinh / verify code test.`
    );
  }
  if (stacks.length) {
    lines.push(`- Stack markers: ${stacks.filter(Boolean).slice(0, 10).join(", ")}.`);
  }
  const moduleNames = modules
    .map((m) => (typeof m === "string" ? m : m?.name))
    .filter((n): n is string => Boolean(n && String(n).trim()))
    .slice(0, 12);
  if (moduleNames.length) {
    lines.push(`- Module/package gợi ý: ${moduleNames.join(", ")}.`);
  }
  const e2e = meta.e2e;
  if (e2e?.targetUrl) {
    lines.push(`- E2E targetUrl mặc định: ${e2e.targetUrl}.`);
  }
  if (e2e?.useStorageState === true) {
    lines.push("- E2E: ưu tiên storageState (không lặp login UI trên feature Spec).");
  } else if (e2e?.useStorageState === false) {
    lines.push("- E2E: không dùng storageState — auth qua ensureAuthenticated / UI khi cần.");
  }
  lines.push(
    "- Layout artifact: Unit → AItest/UnitTest/{Requirement}/{TC}/ ; E2E → AItest/E2ETest/{Requirement}/{TC}/pages|specs/."
  );
  lines.push("- Chỉ bám tài liệu job (TC) hoặc source/DOM (codegen) — không copy domain mẫu.");

  if (lines.length <= 3 && !lang && !frameworks.length && !testFws.length) {
    return "";
  }
  return lines.join("\n");
}

function seedAiRules(
  meta: ProjectMeta,
  language?: string | null
): NonNullable<ProjectMeta["aiRules"]> {
  const prev = meta.aiRules ?? {};
  const locked = Boolean(prev.lockProjectAuto);
  const auto = synthesizeProjectAutoRules(
    { ...meta, scanLanguage: language || meta.scanLanguage },
    language
  );
  const next = { ...prev };
  if (auto && (!locked || !String(prev.projectAuto || "").trim())) {
    next.projectAuto = auto;
  }
  return next;
}

export function buildProjectMetaFromScan(
  scan: ProjectScan,
  existingMeta?: ProjectMeta | null,
  languageOverride?: string | null
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
    aiRules: seedAiRules(base, language),
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
