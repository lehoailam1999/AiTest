/**
 * Phase C — sync Approved TC markdown into project `.ai-test/test-cases/`.
 * Renderer-safe: chỉ dùng Tauri writeTextFile (+ IDE). Không import node:fs.
 */
import { parseBridgeDiscoveryJson } from "@aitest/ide-protocol";
import type { TestCase } from "../../api/types";
import { isTauri, readIdeBridgeDiscovery, writeTextFile } from "../../tauri/bridge";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "../ideBridge/session";
import { newCodegenCommandId } from "../ideProtocol/codegenCommands";
import {
  buildApprovedTcMarkdownFiles,
  type ApprovedTcMdFile,
} from "./approvedTcMarkdown";

export type SyncApprovedTcMdResult = {
  ok: boolean;
  via: "ide" | "tauri" | "skipped";
  files: ApprovedTcMdFile[];
  written: string[];
  errors: string[];
  message?: string;
  projectRoot?: string;
  warning?: string;
};

function normPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/\/+$/, "").toLowerCase();
}

function samePath(a: string, b: string): boolean {
  return normPath(a) === normPath(b);
}

/** Chỉ nhận diện repo tool AITest — không match path chứa "aitest" ở chỗ khác. */
function looksLikeAitestToolRepo(root: string): boolean {
  const n = normPath(root);
  return n.endsWith("/xlab/aitest") || n.includes("/aitest/ide-plugins");
}

async function readIdeWorkspaceRoot(): Promise<string> {
  if (isTauri()) {
    try {
      const raw = await readIdeBridgeDiscovery();
      const d = raw ? parseBridgeDiscoveryJson(raw) : null;
      const discovery = (d?.workspaceRoot || "").trim();
      if (discovery) return discovery;
    } catch {
      /* ignore */
    }
  }
  return (useIdeBridgeSession.getState().workspaceRoot || "").trim();
}

export async function resolveSyncProjectRoot(
  explicit: string | null | undefined
): Promise<{ root: string; warning?: string }> {
  const bound = (explicit || "").trim();
  const ideWs = await readIdeWorkspaceRoot();

  // Desktop gắn nhầm repo AITest tool nhưng IDE đang mở SUT → dùng IDE
  if (bound && looksLikeAitestToolRepo(bound)) {
    if (ideWs && !looksLikeAitestToolRepo(ideWs)) {
      return {
        root: ideWs,
        warning: `Desktop đang gắn AITest tool; dùng IDE workspace «${ideWs}» làm source đích.`,
      };
    }
    return {
      root: "",
      warning: `Project root «${bound}» là AITest tool — gắn Forensic trên Projects hoặc mở Forensic trong Cursor.`,
    };
  }

  if (bound) {
    let warning: string | undefined;
    if (ideWs && !samePath(bound, ideWs)) {
      warning =
        `IDE đang mở «${ideWs}» khác source đích «${bound}». Ghi vào source Desktop đã bind.`;
    }
    return { root: bound, warning };
  }

  if (ideWs) {
    if (looksLikeAitestToolRepo(ideWs)) {
      return {
        root: "",
        warning:
          `IDE đang mở AITest tool («${ideWs}»). Gắn mã nguồn Dự án A trên Desktop, hoặc Open Folder Forensic trong Cursor rồi Start Bridge.`,
      };
    }
    return { root: ideWs };
  }

  return {
    root: "",
    warning:
      "Chưa gắn project root. Vào Projects → gắn thư mục Forensic, hoặc Connect IDE với Cursor đang mở Forensic.",
  };
}

async function writeViaTauri(
  root: string,
  files: ApprovedTcMdFile[]
): Promise<{ written: string[]; errors: string[] }> {
  const written: string[] = [];
  const errors: string[] = [];
  for (const f of files) {
    try {
      await writeTextFile(root, f.path, f.content);
      written.push(f.path.replace(/\\/g, "/"));
    } catch (e) {
      errors.push(`${f.path}: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  return { written, errors };
}

async function writeViaIde(
  projectId: string,
  root: string,
  files: ApprovedTcMdFile[]
): Promise<SyncApprovedTcMdResult> {
  const client = getIdeRpcClientOrNull();
  if (!client?.isConnected) {
    return {
      ok: false,
      via: "ide",
      files,
      written: [],
      errors: ["IDE offline"],
      projectRoot: root,
    };
  }
  const result = await client.tcSyncApprovedMd({
    commandId: newCodegenCommandId("tc-sync"),
    projectId,
    projectRoot: root,
    files: files.map((f) => ({ path: f.path, content: f.content })),
  });
  const written = result.files
    .filter((f) => f.status === "CREATED" || f.status === "UPDATED")
    .map((f) => f.path);
  const errors = result.files
    .filter((f) => f.status === "REJECTED_JAIL" || f.status === "ERROR")
    .map((f) => f.error || f.path);
  return {
    ok: written.length > 0,
    via: "ide",
    files,
    written,
    errors,
    projectRoot: root,
    message: `Đã ghi ${written.length} TC → ${root}/.ai-test/test-cases/ (IDE)`,
  };
}

export async function syncApprovedTestCasesMd(opts: {
  projectId: string;
  projectRoot: string | null | undefined;
  cases: TestCase[];
}): Promise<SyncApprovedTcMdResult> {
  const files = buildApprovedTcMarkdownFiles(opts.cases);
  if (!files.length) {
    return {
      ok: false,
      via: "skipped",
      files: [],
      written: [],
      errors: ["Không có TC reviewStatus=Approved trong danh sách sync"],
      message: "Không có TC Approved để sync",
    };
  }

  const { root, warning } = await resolveSyncProjectRoot(opts.projectRoot);
  if (!root) {
    return {
      ok: false,
      via: "skipped",
      files,
      written: [],
      errors: [warning || "No project root"],
      message: warning || "No project root",
      warning,
    };
  }

  // 1) Tauri disk first (renderer-safe)
  if (isTauri()) {
    const disk = await writeViaTauri(root, files);
    if (disk.written.length > 0) {
      const client = getIdeRpcClientOrNull();
      if (client?.isConnected) {
        try {
          await writeViaIde(opts.projectId, root, files);
        } catch {
          /* disk ok */
        }
      }
      return {
        ok: disk.errors.length === 0,
        via: "tauri",
        files,
        written: disk.written,
        errors: disk.errors,
        projectRoot: root,
        warning,
        message: `Đã ghi ${disk.written.length} file → ${root}/.ai-test/test-cases/`,
      };
    }
    // Tauri failed — try IDE
    const client = getIdeRpcClientOrNull();
    if (client?.isConnected) {
      try {
        const ide = await writeViaIde(opts.projectId, root, files);
        if (ide.written.length) return { ...ide, warning };
        return {
          ok: false,
          via: "ide",
          files,
          written: [],
          errors: [...disk.errors, ...ide.errors],
          projectRoot: root,
          warning,
          message: ide.errors[0] || disk.errors[0] || "Ghi thất bại",
        };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        return {
          ok: false,
          via: "tauri",
          files,
          written: [],
          errors: [...disk.errors, msg],
          projectRoot: root,
          warning,
          message: disk.errors[0] || msg,
        };
      }
    }
    return {
      ok: false,
      via: "tauri",
      files,
      written: [],
      errors: disk.errors,
      projectRoot: root,
      warning,
      message: disk.errors[0] || "Ghi thất bại qua Desktop",
    };
  }

  // 2) Non-Tauri: IDE only
  const client = getIdeRpcClientOrNull();
  if (client?.isConnected) {
    try {
      const ide = await writeViaIde(opts.projectId, root, files);
      return { ...ide, warning };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return {
        ok: false,
        via: "ide",
        files,
        written: [],
        errors: [msg],
        projectRoot: root,
        warning,
        message: msg,
      };
    }
  }

  return {
    ok: false,
    via: "skipped",
    files,
    written: [],
    errors: [
      "Cần AITest Desktop (Tauri) hoặc Connect IDE. Không mở UI trên trình duyệt thuần.",
    ],
    projectRoot: root,
    warning,
    message: "No write backend",
  };
}

export async function syncApprovedTestCasesMdBestEffort(opts: {
  projectId: string;
  projectRoot: string | null | undefined;
  cases: TestCase[];
}): Promise<SyncApprovedTcMdResult> {
  try {
    return await syncApprovedTestCasesMd(opts);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    return {
      ok: false,
      via: "skipped",
      files: [],
      written: [],
      errors: [msg],
      message: msg,
    };
  }
}
