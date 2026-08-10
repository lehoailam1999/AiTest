/**
 * Phase C — write Approved TC markdown under `.ai-test/test-cases/`.
 */
import { promises as fs } from "node:fs";
import * as path from "node:path";
import {
  AI_TEST_CASES_DIR,
  assertSafeAiTestCasesRel,
  type TcSyncApprovedMdParams,
  type TcSyncApprovedMdResult,
  type TcSyncFileMeta,
  type TcSyncFileStatus,
} from "@aitest/ide-protocol";
import { workspaceRoot } from "./semanticContext";

async function fileExists(abs: string): Promise<boolean> {
  try {
    await fs.access(abs);
    return true;
  } catch {
    return false;
  }
}

export async function handleTcSyncApprovedMd(
  params: TcSyncApprovedMdParams
): Promise<TcSyncApprovedMdResult> {
  // Desktop gửi projectRoot = source đích đã bind — ưu tiên hơn folder Cursor đang mở
  // (tránh ghi nhầm vào repo AITest tool khi Cursor mở workspace tool).
  const fromParams = (params.projectRoot || "").trim();
  const fromIde = (workspaceRoot() || "").trim();
  const root = fromParams || fromIde;
  if (!root) {
    throw new Error(
      "No workspace root — Desktop phải gửi projectRoot (source đích) hoặc mở folder Dự án A trong IDE"
    );
  }
  if (!params.files?.length) {
    throw new Error("files[] required");
  }

  const out: TcSyncFileMeta[] = [];
  for (const f of params.files) {
    const rel = (f.path || "").replace(/\\/g, "/");
    let status: TcSyncFileStatus = "ERROR";
    let error: string | undefined;
    try {
      const safe = assertSafeAiTestCasesRel(rel);
      const abs = path.join(root, ...safe.split("/"));
      const existed = await fileExists(abs);
      await fs.mkdir(path.dirname(abs), { recursive: true });
      await fs.writeFile(abs, f.content ?? "", "utf8");
      status = existed ? "UPDATED" : "CREATED";
      out.push({
        path: safe,
        status,
        size: Buffer.byteLength(f.content ?? "", "utf8"),
      });
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
      status = /TC path jail/i.test(error) ? "REJECTED_JAIL" : "ERROR";
      out.push({ path: rel, status, error });
    }
  }

  const rejected = out.some((g) => g.status === "REJECTED_JAIL" || g.status === "ERROR");
  const anyOk = out.some((g) => g.status === "CREATED" || g.status === "UPDATED");
  return {
    commandId: params.commandId,
    status: rejected ? (anyOk ? "PARTIAL" : "FAILED") : "COMPLETED",
    files: out,
    testCasesDir: AI_TEST_CASES_DIR,
  };
}

/** Best-effort read for Phase B Gen supplemental SoT (not Gen authority). */
export async function readApprovedTcMarkdownRel(
  pathRel: string,
  projectRoot?: string
): Promise<{ path: string; content: string } | null> {
  const root = (projectRoot || "").trim() || workspaceRoot();
  if (!root) return null;
  try {
    const safe = assertSafeAiTestCasesRel(pathRel);
    const abs = path.join(root, ...safe.split("/"));
    const content = await fs.readFile(abs, "utf8");
    return { path: safe, content };
  } catch {
    return null;
  }
}
