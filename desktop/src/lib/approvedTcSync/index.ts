/**
 * Phase C — sync Approved TC markdown into project `.ai-test/test-cases/{UnitTest|E2ETest}/`.
 * Renderer-safe: chỉ dùng Tauri writeTextFile (+ IDE). Không import node:fs.
 */
import { parseBridgeDiscoveryJson } from "@aitest/ide-protocol";
import { testcases } from "../../api";
import type { TestCase } from "../../api/types";
import { isTauri, listSourceFiles, readIdeBridgeDiscovery, readTextFile, writeTextFile } from "../../tauri/bridge";
import { getIdeRpcClientOrNull, useIdeBridgeSession } from "../ideBridge/session";
import { newCodegenCommandId } from "../ideProtocol/codegenCommands";
import {
  buildApprovedTcMarkdownFiles,
  type ApprovedTcMdFile,
} from "./approvedTcMarkdown";
import { enrichApprovedCasesWithUnitMarkers } from "./enrichUnitMarkersFromIndex";
import { enrichApprovedCasesWithE2eMarkers } from "./enrichE2eMarkersFromIndex";
import { mergeRequirementTitleFillGap } from "./requirementTitleFillGap";
import { buildRequirementTitleByCaseKey } from "./resolveRequirementTitles";
import { createTauriProfileIo } from "../projectProfile/tauriIo";
import { loadGenerateGroundingProfile } from "../e2eWorkspace/generateGrounding";
import { loadOrBuildE2eRouteCatalog } from "../e2eWorkspace/e2eRouteCatalogCache";
import type { E2eRouteCatalog } from "../e2eWorkspace/e2eRouteCatalog";
import { loadIndexSnapshot } from "../codeIndex/indexStore";
import { createTauriCodeIndexIo } from "../codeIndex/tauriIo";
import { buildUnitGroundingContractFiles } from "./unitSourceGroundingContract";

export {
  parseApprovedTcGrounding,
  renderUnitGroundingBlock,
  renderE2eGroundingBlock,
  buildApprovedTcMarkdownFiles,
  approvedTcMarkdownRelPath,
  approvedTcKindFolder,
  renderApprovedTestCaseMarkdown,
  type ApprovedTcMdFile,
  type ApprovedTcMdRenderOpts,
} from "./approvedTcMarkdown";

export {
  buildUnitSourceGroundingContract,
  buildUnitGroundingContractFiles,
  unitGroundingContractRelPath,
  serializeUnitSourceGroundingContract,
  parseConfidenceFromTestData,
  UNIT_GROUNDING_CONTRACT_SCHEMA,
  type UnitSourceGroundingContract,
  type BuildUnitSourceGroundingContractInput,
} from "./unitSourceGroundingContract";

export {
  enrichApprovedCasesWithUnitMarkers,
  enrichTestDataWithUnitMarkers,
  enrichTcTestDataFromIndex,
  enrichTcTestDataFromIndexAsync,
  hasUnitPathCodeMarkers,
  pickConfidentUnitSeed,
  UNIT_AUTO_MARKER,
} from "./enrichUnitMarkersFromIndex";

export {
  enrichApprovedCasesWithE2eMarkers,
  enrichTcTestDataWithE2eMarkers,
  inferE2eRoutePath,
  hasManualE2eSourceMarkers,
  stripAutoEnrichedE2eMarkers,
} from "./enrichE2eMarkersFromIndex";

export { buildRequirementTitleByCaseKey } from "./resolveRequirementTitles";
export { mergeRequirementTitleFillGap } from "./requirementTitleFillGap";

export type SyncApprovedTcMdResult = {
  ok: boolean;
  via: "ide" | "tauri" | "skipped";
  files: ApprovedTcMdFile[];
  written: string[];
  errors: string[];
  message?: string;
  projectRoot?: string;
  warning?: string;
  /** How many TCs had enriched testData written back to API DB */
  dbSyncedCount?: number;
};

/**
 * Best-effort: push enriched path:/code:/related: back to DB so Gen packet ≠ stale Test Data.
 */
async function persistEnrichedTestDataToDb(
  original: TestCase[],
  enriched: TestCase[]
): Promise<number> {
  const byId = new Map(original.map((c) => [c.id, c]));
  const toSync = enriched.filter((tc) => {
    const prev = byId.get(tc.id);
    const nextTd = String(tc.testData || "").trim();
    const prevTd = String(prev?.testData || "").trim();
    return Boolean(nextTd && nextTd !== prevTd);
  });
  if (!toSync.length) return 0;

  let n = 0;
  const CONCURRENCY = 4;
  for (let i = 0; i < toSync.length; i += CONCURRENCY) {
    const chunk = toSync.slice(i, i + CONCURRENCY);
    const hits = await Promise.all(
      chunk.map(async (tc) => {
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await testcases.update(tc.id, { testData: tc.testData });
            return true;
          } catch {
            if (attempt === 0) {
              await new Promise((r) => setTimeout(r, 350));
            }
          }
        }
        return false;
      })
    );
    n += hits.filter(Boolean).length;
  }
  return n;
}

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
      warning: `Project root «${bound}» là AITest tool — gắn thư mục source dự án đích trên Projects, hoặc mở repo đích trong Cursor.`,
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
          `IDE đang mở AITest tool («${ideWs}»). Gắn mã nguồn dự án đích trên Desktop, hoặc Open Folder repo SUT trong Cursor rồi Start Bridge.`,
      };
    }
    return { root: ideWs };
  }

  return {
    root: "",
    warning:
      "Chưa gắn project root. Vào Projects → gắn thư mục source dự án đích, hoặc Connect IDE với Cursor đang mở repo SUT.",
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
    message: `Đã ghi ${written.length} TC → ${root}/.ai-test/test-cases/{UnitTest|E2ETest}/ (IDE)`,
  };
}

export async function syncApprovedTestCasesMd(opts: {
  projectId: string;
  projectRoot: string | null | undefined;
  cases: TestCase[];
  /** Single Requirement title when approving under one req */
  requirementTitle?: string | null;
  /** Per TC / snapshot id → requirement title */
  requirementTitleByCaseKey?: Record<string, string> | null;
  /** Optional pre-listed source paths (skip listSourceFiles) */
  allSourcePaths?: string[] | null;
  codeAliases?: import("../projectIntelligence/viCodeAliases").CodeAliasMap | null;
}): Promise<SyncApprovedTcMdResult> {
  const approved = opts.cases.filter(
    (c) => String(c.reviewStatus || "").toLowerCase() === "approved"
  );
  if (!approved.length) {
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
    const files = buildApprovedTcMarkdownFiles(approved, {
      requirementTitle: opts.requirementTitle,
      requirementTitleByCaseKey: opts.requirementTitleByCaseKey,
    });
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

  // Requirement entity title (from Requirements page) — never invent from module.
  let requirementTitleByCaseKey: Record<string, string> = {
    ...(await buildRequirementTitleByCaseKey(opts.projectId, approved)),
    ...(opts.requirementTitleByCaseKey || {}),
  };
  requirementTitleByCaseKey = mergeRequirementTitleFillGap(
    approved,
    requirementTitleByCaseKey,
    opts.requirementTitle
  );

  const reqResolved = approved.filter(
    (tc) =>
      (requirementTitleByCaseKey[tc.id] ||
        requirementTitleByCaseKey[tc.testCaseId] ||
        opts.requirementTitle ||
        "").trim().length > 0
  ).length;
  let reqNote =
    reqResolved > 0
      ? ` · requirement ${reqResolved}/${approved.length}`
      : ` · requirement thiếu (gắn sourceId hoặc Approve từ trang Requirement)`;

  // Auto path:/code: (Unit) & path:/authRole: (E2E) when seed is confident.
  let casesToWrite = approved;
  let enrichNote = "";
  let e2eModuleMap: Record<string, string> = {};
  let e2eFallbackRole: string | null = null;
  let e2eRouteCatalog: E2eRouteCatalog | null = null;
  let catalogNote = "";
  try {
    if (isTauri() && root) {
      const { projectProfile } = await loadGenerateGroundingProfile(
        root,
        createTauriProfileIo()
      );
      e2eModuleMap = projectProfile?.moduleMap || {};
      e2eFallbackRole =
        (projectProfile?.auth?.roles || []).find((r) => (r || "").trim())?.trim() ||
        null;

      // One catalog build/cache hit per Approve batch — routing files only (≤40).
      const hasE2e = approved.some((tc) => {
        const t = (tc.type || "").trim().toUpperCase();
        return t === "E2E" || t === "E2E_UI" || t === "UI";
      });
      if (hasE2e) {
        try {
          const loaded = await loadOrBuildE2eRouteCatalog({
            allSourcePaths: opts.allSourcePaths,
            io: {
              listSourcePaths: () =>
                listSourceFiles(root, [".ts", ".tsx", ".js", ".jsx", ".html"]),
              readText: (pathRel) => readTextFile(root, pathRel.replace(/\\/g, "/")),
              writeText: (pathRel, content) =>
                writeTextFile(root, pathRel.replace(/\\/g, "/"), content).then(() => undefined),
            },
          });
          e2eRouteCatalog = loaded.catalog;
          catalogNote = loaded.fromCache
            ? `, routes:${loaded.catalog.routes.length}(cache)`
            : `, routes:${loaded.catalog.routes.length}(scan:${loaded.routingFileCount})`;
        } catch {
          /* catalog optional */
        }
      }
    }
  } catch {
    /* profile optional */
  }
  try {
    const enrichedUnit = await enrichApprovedCasesWithUnitMarkers({
      projectId: opts.projectId,
      projectRoot: root,
      cases: approved,
      requirementTitle: opts.requirementTitle,
      requirementTitleByCaseKey,
      codeAliases: opts.codeAliases,
      allSourcePaths: opts.allSourcePaths,
    });
    casesToWrite = enrichedUnit.cases;

    const enrichedE2e = await enrichApprovedCasesWithE2eMarkers({
      cases: casesToWrite,
      moduleMap: e2eModuleMap,
      fallbackRole: e2eFallbackRole,
      requirementTitle: opts.requirementTitle,
      requirementTitleByCaseKey,
      routeCatalog: e2eRouteCatalog,
    });
    casesToWrite = enrichedE2e.cases;

    const totalEnriched = enrichedUnit.enrichedCount + enrichedE2e.enrichedCount;
    if (totalEnriched > 0) {
      const via = enrichedUnit.usedCodeIndex ? "index.db" : "path-index";
      const retryNote =
        (enrichedUnit.retryEnrichedCount || 0) > 0
          ? `, retry:${enrichedUnit.retryEnrichedCount}`
          : "";
      const mapNote = Object.keys(e2eModuleMap).length
        ? `, moduleMap:${Object.keys(e2eModuleMap).length}`
        : "";
      enrichNote = ` · auto-enrich: ${totalEnriched}/${approved.length} (Unit:${enrichedUnit.enrichedCount}, E2E:${enrichedE2e.enrichedCount}${retryNote}${mapNote}${catalogNote}) via ${via}`;
    } else if (enrichedUnit.indexFileCount > 0) {
      const via = enrichedUnit.usedCodeIndex ? "index.db" : "path-index";
      enrichNote = ` · ${via} ${enrichedUnit.indexFileCount} files (chưa đủ tin cậy để auto-marker)${catalogNote}`;
    } else if (catalogNote) {
      enrichNote = ` · e2e-catalog${catalogNote}`;
    }
  } catch {
    /* enrich optional — still sync MD */
  }
  enrichNote = `${reqNote}${enrichNote}`;

  const mdFiles = buildApprovedTcMarkdownFiles(casesToWrite, {
    requirementTitle: opts.requirementTitle,
    requirementTitleByCaseKey,
    fallbackRole: e2eFallbackRole,
  });

  // Layer 5 — companion .grounding.json beside Unit MD (when path:/code: present)
  let contractFiles: ApprovedTcMdFile[] = [];
  try {
    let snap = null;
    if (isTauri() && root) {
      snap = await loadIndexSnapshot(root, createTauriCodeIndexIo());
    }
    contractFiles = buildUnitGroundingContractFiles(casesToWrite, {
      codeIndex: snap,
    });
  } catch {
    contractFiles = buildUnitGroundingContractFiles(casesToWrite, {
      codeIndex: null,
    });
  }
  const files = [...mdFiles, ...contractFiles];
  const contractNote =
    contractFiles.length > 0 ? ` · grounding:${contractFiles.length}` : "";


  // 1) Tauri disk first (renderer-safe)
  if (isTauri()) {
    const disk = await writeViaTauri(root, files);
    if (disk.written.length > 0) {
      const dbSyncedCount = await persistEnrichedTestDataToDb(approved, casesToWrite);
      const dbNote =
        dbSyncedCount > 0 ? ` · DB markers ${dbSyncedCount}` : "";
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
        dbSyncedCount,
        message: `Đã ghi ${disk.written.length} file → ${root}/.ai-test/test-cases/{UnitTest|E2ETest}/${enrichNote}${contractNote}${dbNote}`,
      };
    }
    // Tauri failed — try IDE
    const client = getIdeRpcClientOrNull();
    if (client?.isConnected) {
      try {
        const ide = await writeViaIde(opts.projectId, root, files);
        if (ide.written.length) {
          const dbSyncedCount = await persistEnrichedTestDataToDb(
            approved,
            casesToWrite
          );
          return {
            ...ide,
            dbSyncedCount,
            warning,
            message: `${ide.message || ""}${enrichNote}${contractNote}${
              dbSyncedCount > 0 ? ` · DB markers ${dbSyncedCount}` : ""
            }`.trim(),
          };
        }
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
      if (ide.written.length) {
        const dbSyncedCount = await persistEnrichedTestDataToDb(
          approved,
          casesToWrite
        );
        return {
          ...ide,
          dbSyncedCount,
          warning,
          message: `${ide.message || ""}${enrichNote}${contractNote}${
            dbSyncedCount > 0 ? ` · DB markers ${dbSyncedCount}` : ""
          }`.trim(),
        };
      }
      return {
        ...ide,
        warning,
        message: `${ide.message || ""}${enrichNote}${contractNote}`.trim(),
      };
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
  requirementTitle?: string | null;
  requirementTitleByCaseKey?: Record<string, string> | null;
  allSourcePaths?: string[] | null;
  codeAliases?: import("../projectIntelligence/viCodeAliases").CodeAliasMap | null;
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
