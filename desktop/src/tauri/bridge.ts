import { invoke } from "@tauri-apps/api/tauri";

export type TreeNode = {
  name: string;
  path: string;
  isDir: boolean;
  children: TreeNode[];
};

export type ScanModule = {
  name: string;
  path: string;
  language?: string | null;
  frameworks: string[];
  stacks: string[];
  markers: string[];
};

export type ProjectScan = {
  projectPath: string;
  name: string;
  solutionFiles: string[];
  csprojFiles: string[];
  testProjects: string[];
  /** SDK version on the machine (`dotnet --version`), not project TFM. */
  dotnetVersion?: string | null;
  /** Detected from project markers (C#, TypeScript, Python, …). */
  language?: string | null;
  /** Target frameworks / runtimes detected (e.g. net8.0, Node). */
  frameworks: string[];
  /** Test frameworks (xUnit, Jest, pytest, …). */
  testFrameworks: string[];
  /** Tech stacks inferred from markers. */
  stacks: string[];
  /** Top-level folders with detected stack. */
  modules: ScanModule[];
  warning?: string | null;
  tree: TreeNode[];
};

export type TestRunResult = {
  exitCode: number;
  success: boolean;
  passed: number;
  failed: number;
  skipped: number;
  total: number;
  durationMs: number;
  log: string;
  trxPath?: string | null;
  trxFileName?: string | null;
  command: string;
  filter?: string | null;
  startedAt: string;
  finishedAt: string;
};

export function isTauri(): boolean {
  return typeof window !== "undefined" && "__TAURI__" in window;
}

function ensureTauri() {
  if (!isTauri()) {
    throw new Error(
      "Tính năng này cần chạy trong ứng dụng Desktop (Tauri). Dùng `npm run dev` thay vì mở trên trình duyệt."
    );
  }
}

/** Normalize snake_case (legacy) or camelCase Tauri payloads. */
function normalizeTree(nodes: unknown): TreeNode[] {
  if (!Array.isArray(nodes)) return [];
  return nodes.map((raw) => {
    const n = raw as Record<string, unknown>;
    return {
      name: String(n.name ?? ""),
      path: String(n.path ?? ""),
      isDir: Boolean(n.isDir ?? n.is_dir),
      children: normalizeTree(n.children),
    };
  });
}

function normalizeScan(raw: Record<string, unknown>): ProjectScan {
  const asStringList = (v: unknown): string[] =>
    Array.isArray(v) ? v.map((x) => String(x)) : [];
  const modulesRaw = raw.modules;
  const modules: ScanModule[] = Array.isArray(modulesRaw)
    ? modulesRaw.map((m) => {
        const row = (m ?? {}) as Record<string, unknown>;
        return {
          name: String(row.name ?? ""),
          path: String(row.path ?? ""),
          language: (row.language ?? null) as string | null,
          frameworks: asStringList(row.frameworks),
          stacks: asStringList(row.stacks),
          markers: asStringList(row.markers),
        };
      })
    : [];
  return {
    projectPath: String(raw.projectPath ?? raw.project_path ?? ""),
    name: String(raw.name ?? "Project"),
    solutionFiles: asStringList(raw.solutionFiles ?? raw.solution_files),
    csprojFiles: asStringList(raw.csprojFiles ?? raw.csproj_files),
    testProjects: asStringList(raw.testProjects ?? raw.test_projects),
    dotnetVersion: (raw.dotnetVersion ?? raw.dotnet_version ?? null) as string | null,
    language: (raw.language ?? null) as string | null,
    frameworks: asStringList(raw.frameworks),
    testFrameworks: asStringList(raw.testFrameworks ?? raw.test_frameworks),
    stacks: asStringList(raw.stacks),
    modules,
    warning: (raw.warning ?? null) as string | null,
    tree: normalizeTree(raw.tree),
  };
}

function normalizeRun(raw: Record<string, unknown>): TestRunResult {
  return {
    exitCode: Number(raw.exitCode ?? raw.exit_code ?? 0),
    success: Boolean(raw.success),
    passed: Number(raw.passed ?? 0),
    failed: Number(raw.failed ?? 0),
    skipped: Number(raw.skipped ?? 0),
    total: Number(raw.total ?? 0),
    durationMs: Number(raw.durationMs ?? raw.duration_ms ?? 0),
    log: String(raw.log ?? ""),
    trxPath: (raw.trxPath ?? raw.trx_path ?? null) as string | null,
    trxFileName: (raw.trxFileName ?? raw.trx_file_name ?? null) as string | null,
    command: String(raw.command ?? ""),
    filter: (raw.filter ?? null) as string | null,
    startedAt: String(raw.startedAt ?? raw.started_at ?? ""),
    finishedAt: String(raw.finishedAt ?? raw.finished_at ?? ""),
  };
}

export async function pickProjectFolder(): Promise<string | null> {
  ensureTauri();
  const res = await invoke<string | null>("pick_project_folder");
  return res ?? null;
}

export async function scanProject(projectPath: string): Promise<ProjectScan> {
  ensureTauri();
  const raw = await invoke<Record<string, unknown>>("scan_project", { projectPath });
  return normalizeScan(raw ?? {});
}

export function listCsFiles(projectRoot: string): Promise<string[]> {
  /** @deprecated Prefer workspaceApi.files — generate flow uses BE Workspace Manager */
  ensureTauri();
  return invoke<string[]>("list_cs_files", { projectRoot });
}

/**
 * @deprecated Prefer `workspaceApi.files` / `listWorkspaceSourceFiles`.
 * Kept for legacy Workspace Host tree helpers; generate unit no longer calls this.
 */
export function listSourceFiles(
  projectRoot: string,
  extensions?: string[]
): Promise<string[]> {
  ensureTauri();
  return invoke<string[]>("list_source_files", {
    projectRoot,
    extensions: extensions ?? null,
  });
}

/**
 * Read a UTF-8 text file under projectRoot (IDE-local generate context).
 * Prefer this over BE workspace read for contextPacket building.
 */
export function readTextFile(projectRoot: string, filePath: string): Promise<string> {
  ensureTauri();
  return invoke<string>("read_text_file", { projectRoot, filePath });
}

/** Raw JSON of ~/.aitest/ide-bridge.json from IDE plugin (P1). */
export function readIdeBridgeDiscovery(): Promise<string | null> {
  ensureTauri();
  return invoke<string | null>("read_ide_bridge_discovery");
}

export function readAllIdeBridgeDiscoveries(): Promise<string[]> {
  if (!isTauri()) return Promise.resolve([]);
  return invoke<string[]>("read_all_ide_bridge_discoveries");
}

export type IdeExtensionStatus = {
  bridgeOnline: boolean;
  extensionInstalled: boolean;
  extensionPath?: string | null;
};

export async function checkIdeExtensionStatus(): Promise<IdeExtensionStatus> {
  if (!isTauri()) return { bridgeOnline: false, extensionInstalled: false };
  return invoke<IdeExtensionStatus>("check_ide_extension_status");
}

export type IdeExtensionInstallResult = {
  message: string;
  /** Folder-copy installs only load on the next IDE window reload. */
  needsReload: boolean;
  activatedViaCli: string[];
  copiedInto: string[];
  skipped: string[];
};

export async function installIdeExtensionNative(): Promise<IdeExtensionInstallResult> {
  ensureTauri();
  return invoke<IdeExtensionInstallResult>("install_ide_extension_native");
}

export function writeTextFile(
  projectRoot: string,
  relativePath: string,
  content: string
): Promise<string> {
  ensureTauri();
  return invoke<string>("write_text_file", { projectRoot, relativePath, content });
}

/** Tool-internal Unit draft storage (OS temp), never written into the SUT source tree. */
export function readUnitDraftText(
  projectRoot: string,
  draftPath: string
): Promise<string> {
  ensureTauri();
  return invoke<string>("read_unit_draft_text", { projectRoot, draftPath });
}

export function writeUnitDraftText(
  projectRoot: string,
  draftPath: string,
  content: string
): Promise<void> {
  ensureTauri();
  return invoke<void>("write_unit_draft_text", {
    projectRoot,
    draftPath,
    content,
  });
}

export function deleteUnitDraftDir(
  projectRoot: string,
  draftPath: string
): Promise<void> {
  ensureTauri();
  return invoke<void>("delete_unit_draft_dir", { projectRoot, draftPath });
}

export function deleteTextFile(projectRoot: string, relativePath: string): Promise<void> {
  ensureTauri();
  return invoke<void>("delete_text_file", { projectRoot, relativePath });
}

/** Remove staging dir under `.ai-test/` (path-jailed in Tauri). */
export function deleteDir(
  projectRoot: string,
  relativePath: string,
  opts?: { emptyOnly?: boolean }
): Promise<void> {
  ensureTauri();
  return invoke<void>("delete_dir", {
    projectRoot,
    relativePath,
    emptyOnly: opts?.emptyOnly ?? false,
  });
}

export async function runDotnetTest(
  projectRoot: string,
  filter?: string
): Promise<TestRunResult> {
  ensureTauri();
  const raw = await invoke<Record<string, unknown>>("run_dotnet_test", {
    projectRoot,
    filter: filter ?? null,
  });
  return normalizeRun(raw ?? {});
}

export async function runTestCommand(
  projectRoot: string,
  command: string
): Promise<TestRunResult> {
  ensureTauri();
  const raw = await invoke<Record<string, unknown>>("run_test_command", {
    projectRoot,
    command,
  });
  return normalizeRun(raw ?? {});
}

/** EX4.4 — open file/folder in OS (Explorer / default app). */
export async function openPathInOs(path: string): Promise<void> {
  ensureTauri();
  await invoke<void>("open_path_in_os", { path });
}

/** Open a docs URL in the OS browser — `target="_blank"` is a no-op in the webview. */
export async function openExternalUrl(url: string): Promise<void> {
  if (!isTauri()) {
    window.open(url, "_blank", "noopener,noreferrer");
    return;
  }
  const { open } = await import("@tauri-apps/api/shell");
  await open(url);
}

export async function pickExecutableFile(): Promise<string | null> {
  ensureTauri();
  const res = await invoke<string | null>("pick_executable_file");
  return res ?? null;
}
