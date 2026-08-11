import {
  PauseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Input,
  Progress,
  Radio,
  Select,
  Space,
  Steps,
  Typography
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { audit, connection, generateApiTest, projects, requirementStudio, requirements, testcases } from "../api";
import type {
  Connection,
  Project,
  RequirementStudioWorkspace,
  TestCase,
  UnitResult,
} from "../api/types";
import { CodegenResultPanel } from "../components/CodegenResultPanel";
import { testRunnerAllowsGenerate } from "../components/EnsureTestRunnerPanel";
import { ReadyStrip } from "../components/ReadyStrip";
import { UnitScopePanel } from "../components/UnitScopePanel";
import {
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
  BatchRunConsole,
  batchTcSnapshot,
  isBatchQueueNote,
  markBatchRowsPaused,
  markBatchRowsResumed,
  type BatchPipelineRow,
} from "../features/unit-test/BatchRunConsole";
import {
  BatchStagingPreview,
  type BatchStagingJob,
} from "../features/unit-test/BatchStagingPreview";
import { aiConnectionDisplayLabel } from "../lib/aiConnectionLabel";
import {
  createBatchRunControl,
  type BatchRunStatus,
} from "../lib/batchRunControl";
import type { AITestContextPacket } from "../lib/contextPacket/types";
import {
  buildGenerateContext,
  buildIdeLocalGenerateBody,
  ideListSourceFiles,
  ideReadFile,
  loadUnitProjectRules,
  type IdeLocalGenerateBody,
} from "../lib/ideLocalCommands";
import {
  isIdeCodegenReady,
} from "../lib/ideProtocol";
import { discoverOpenApiSpec } from "../lib/openapiDiscovery";
import { ROUTES, activityUrl, requirementUrl } from "../lib/productRoutes";
import { resolveScopeWithAi } from "../lib/projectIntelligence/aiScopeResolve";
import type { UnitContextPacket } from "../lib/projectIntelligence/types";
import {
  isAcceptableUnitScopePath,
  pickFirstAcceptableUnitScopePath,
  tcBlobForUnitScope,
} from "../lib/projectIntelligence/unitScopeAccept";
import type { CodeAliasMap } from "../lib/projectIntelligence/viCodeAliases";
import {
  metaSyncedAt,
  normalizeProjectMeta,
} from "../lib/projectSync";
import { resolvePackagePrefix } from "../lib/resolvePackagePrefix";
import { runPool } from "../lib/runPool";
import {
  languageFromSourcePath,
  sourceExtensionsForLanguage,
  suggestApiTestPath,
  suggestUnitTestPath,
  testFrameworkOptions,
} from "../lib/stackHints";
import { isUnitTestCaseType } from "../lib/testEngine";
import { generateTcUrl } from "../lib/testingJourney";
import {
  GENERATED_TEST_FOLDERS,
  buildRequirementTcModule,
  uniquifyTestTargetRel,
} from "../lib/testOutputLayout";
import type { TestFrameworkResolution } from "../lib/testRunnerEnsure";
import { recordUnitJobMetric } from "../lib/unitJobMetrics";
import { syncWorkspaceRun } from "../lib/unitWorkspace/auditSync";
import {
  generateErrorLogRel,
  saveErrorLogFile,
} from "../lib/unitWorkspace/errorLogStore";
import {
  addArtifactToWorkspace,
  createUnitWorkspaceRun,
  loadManifest,
  loadWorkspacePreviews,
} from "../lib/unitWorkspace/manager";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../lib/unitWorkspace/types";
import { startUnitIdeGenJob } from "../lib/unitWorkspace/unitJobRunner";
import {
  ensureWorkspaceOpen,
  getActiveWorkspaceId,
  listWorkspaceSourceFiles,
  readWorkspaceFiles,
  resolveWorkspaceScope,
} from "../lib/workspaceManager";
import { useProject } from "../state/ProjectContext";
import { isTauri } from "../tauri/bridge";
import { workspace } from "../workspace";

/** Parallel Cursor/API generate — mỗi TC 1 request + workspace riêng; cap 3. */
const UNIT_GEN_CONCURRENCY = 3;

function displayRel(localPath: string | null, absOrRel: string): string {
  if (!localPath) return absOrRel;
  const root = localPath.replace(/\\/g, "/").replace(/\/$/, "");
  const n = absOrRel.replace(/\\/g, "/");
  if (n.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return n.slice(root.length + 1);
  }
  return absOrRel.replace(/^[\\/]+/, "");
}

function pathMatchesUnitFramework(path: string, fw?: string | null): boolean {
  if (!fw || fw === "auto") return true;
  const p = path.toLowerCase().replace(/\\/g, "/");
  if (["jest", "vitest", "mocha"].includes(fw)) {
    return /\.(ts|tsx|js|jsx|mjs|cjs)$/.test(p);
  }
  if (fw === "pytest" || fw === "unittest") return p.endsWith(".py");
  if (["xunit", "nunit", "mstest"].includes(fw)) return p.endsWith(".cs");
  if (fw === "go test" || fw === "gotest") return p.endsWith(".go");
  return true;
}

/** BE workspace resolve → FE heuristic/AI fallback khi primary trống (TC VI ≠ path Latin). */
async function resolveTcSourcePrimary(opts: {
  projectId: string;
  workspaceId: string;
  testCase: TestCase;
  allSourcePaths: string[];
  useAi: boolean;
  codeAliases?: CodeAliasMap | null;
  /** Khi đã khóa Jest/pytest/… — bỏ primary lệch ngôn ngữ (docs/*.py trên Nest). */
  preferredFramework?: string | null;
}): Promise<{ primary: string | null; related: string[]; reason: string }> {
  const fw = opts.preferredFramework || null;
  const scopedPaths = fw
    ? opts.allSourcePaths.filter((p) => pathMatchesUnitFramework(p, fw))
    : opts.allSourcePaths;
  const tcText = tcBlobForUnitScope(opts.testCase);
  const acceptOpts = { tcText, codeAliases: opts.codeAliases };
  const fwOk = (p: string | null | undefined) =>
    Boolean(p && pathMatchesUnitFramework(p, fw));
  const domainOk = (p: string | null | undefined) =>
    Boolean(
      p &&
        isAcceptableUnitScopePath({
          pathRel: p,
          tcText: acceptOpts.tcText,
          codeAliases: acceptOpts.codeAliases,
        })
    );

  const ranked = await resolveWorkspaceScope(
    opts.workspaceId,
    opts.testCase.id,
    opts.useAi
  );
  let primary = (ranked.primary || "").replace(/\\/g, "/") || null;
  let related = (ranked.related || []).map((p) => p.replace(/\\/g, "/"));
  let reason = ranked.reason || "BE workspace resolve";

  // Same gate as Gen: drop unsuitable / domain-conflict BE primary before UI shows it.
  if (primary && (!fwOk(primary) || !domainOk(primary))) {
    const fromRelated = pickFirstAcceptableUnitScopePath(
      related.filter((p) => fwOk(p)),
      acceptOpts
    );
    if (fromRelated) {
      related = related.filter((p) => p !== fromRelated && fwOk(p) && domainOk(p));
      primary = fromRelated;
      reason = `${reason} · đổi primary (domain/SUT gate)`;
    } else {
      primary = null;
      related = [];
      reason = `Bỏ BE primary lệch domain/SUT`;
    }
  }

  const primaryOk = Boolean(primary && fwOk(primary) && domainOk(primary));
  if ((!primary || !primaryOk) && (scopedPaths.length > 0 || opts.allSourcePaths.length > 0)) {
    const fe = await resolveScopeWithAi({
      projectId: opts.projectId,
      testCase: opts.testCase,
      allSourcePaths: scopedPaths.length > 0 ? scopedPaths : opts.allSourcePaths,
      codeAliases: opts.codeAliases,
      useAi: opts.useAi,
    });
    if (fe.primary && fwOk(fe.primary) && domainOk(fe.primary)) {
      primary = fe.primary.replace(/\\/g, "/");
      related = (fe.related || [])
        .map((p) => p.replace(/\\/g, "/"))
        .filter((p) => fwOk(p) && domainOk(p));
      reason = primaryOk
        ? `FE fallback · ${fe.reason || "heuristic"}`
        : `FE · khớp ${fw || "stack"} · ${fe.reason || "heuristic"}`;
    } else if (primary && !primaryOk) {
      primary = null;
      related = [];
      reason = fw && primary && !fwOk(primary)
        ? `Bỏ scope lệch framework (${fw})`
        : `Bỏ scope lệch domain/SUT`;
    }
  }

  if (primary && fw) {
    related = related.filter((p) => pathMatchesUnitFramework(p, fw) && domainOk(p));
  }
  if (primary && !domainOk(primary)) {
    return {
      primary: null,
      related: [],
      reason: "Không khớp SUT an toàn cho TC (domain/SUT gate)",
    };
  }
  return { primary, related, reason };
}

type ScopeRank = { primary: string | null; related: string[]; reason: string };

/** Requirement Studio workspace (+ optional legacy) for Unit Engine selectors. */
type ReqOption = {
  id: string;
  title: string;
  description?: string;
  kind: "studio" | "legacy";
  legacySourceId?: string | null;
  snapshotIds: string[];
  tcTotal?: number;
  tcApproved?: number;
};

function tcBelongsToReq(tc: TestCase, req: ReqOption): boolean {
  if (tc.requirementSnapshotId && req.snapshotIds.includes(tc.requirementSnapshotId)) {
    return true;
  }
  if (req.legacySourceId && tc.sourceId === req.legacySourceId) return true;
  if (tc.sourceId === req.id) return true;
  return false;
}

/** Requirement folder for Unit layout: selected req, else owning req of the TC. */
function requirementTitleForTc(
  tc: TestCase,
  requirementsList: ReqOption[],
  selectedReqId?: string | null
): string {
  if (selectedReqId && selectedReqId !== "__all__") {
    const sel = requirementsList.find((r) => r.id === selectedReqId);
    if (sel?.title?.trim()) return sel.title.trim();
  }
  const owned = requirementsList.find((r) => tcBelongsToReq(tc, r));
  if (owned?.title?.trim()) return owned.title.trim();
  return (tc.module || "Requirement").trim();
}

function guessClassFromCode(code: string, fileName: string): string {
  const m = code.match(
    /^\s*(?:public\s+|export\s+)?(?:class|interface|struct|type|def|fn|func)\s+(\w+)/m
  );
  if (m?.[1]) return m[1];
  const base = (fileName.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "");
  return base || "Target";
}

function normalizeUnitGenErrorForUi(errMsg: string): string {
  const msg = (errMsg || "").trim();

  // Phase 5 gates: require path:/code: before CLI. User-facing: must be explicit.
  if (
    /FAIL_NEEDS_MARKER|needs_marker/i.test(msg) ||
    /\bpath\s*:\s*\+?\s*code\s*:/i.test(msg) ||
    /chưa có path\s*:\s*\+?\s*code\s*:/i.test(msg)
  ) {
    return "Không tìm thấy path và code liên quan";
  }

  if (/FAIL_FEATURE_GAP|feature_gap/i.test(msg)) {
    return "Thiếu backend feature / gap (FEATURE_GAP)";
  }

  if (/FAIL_SUT_MISMATCH|sut_mismatch/i.test(msg)) {
    return "SUT không khớp intent (FAIL_SUT_MISMATCH)";
  }

  if (/FAIL_DOMAIN_GUARD|domain_guard/i.test(msg)) {
    return "Bị chặn theo domain guard (DOMAIN_GUARD)";
  }

  if (/FAIL_NEEDS_SOURCE/i.test(msg)) {
    return "Chưa có đủ thông tin nguồn để sinh code";
  }

  if (/timeout|timed out/i.test(msg)) {
    return "Lỗi timeout — AI/CLI quá lâu (thử lại/giảm batch)";
  }

  return msg || "Sinh unit thất bại";
}

type BatchRow = BatchPipelineRow;

export default function GenerateUnitPage({ unitOnly = false }: { unitOnly?: boolean }) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const artifactParam = searchParams.get("artifact");
  const isApiKind = !unitOnly && artifactParam === "api";
  const gapsMode = searchParams.get("mode") === "gaps";
  const gapsModulesParam = searchParams.get("modules");
  const { project } = useProject();
  const [serverProject, setServerProject] = useState<Project | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [approved, setApproved] = useState<TestCase[]>([]);
  const [testCaseId, setTestCaseId] = useState<string | undefined>();
  const [sourceFiles, setSourceFiles] = useState<string[]>([]);
  /** File chính (primary) — nội dung hiện trong textarea */
  const [sourceFile, setSourceFile] = useState<string | undefined>();
  /** Các file liên quan gửi kèm AI (không gồm primary) */
  const [relatedSourceFiles, setRelatedSourceFiles] = useState<string[]>([]);
  const [sourceCode, setSourceCode] = useState("");
  const [framework, setFramework] = useState<string | undefined>();
  const [result, setResult] = useState<UnitResult | null>(null);
  const [writePath, setWritePath] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [wsManifest, setWsManifest] = useState<UnitWorkspaceManifest | null>(null);
  const [wsPreviews, setWsPreviews] = useState<WorkspacePreviewFile[]>([]);
  const [wsSelectedRel, setWsSelectedRel] = useState<string | null>(null);
  const [suggestVerify, setSuggestVerify] = useState(false);
  const [contextPacket, setContextPacket] = useState<UnitContextPacket | null>(null);
  const [unitPacketV1, setUnitPacketV1] = useState<AITestContextPacket | null>(null);
  const [scopeLoading, setScopeLoading] = useState(false);
  const [manualSourcePick, setManualSourcePick] = useState(false);
  const manualSourcePickRef = useRef(false);
  const sourceFileRef = useRef<string | undefined>(undefined);
  const relatedSourceFilesRef = useRef<string[]>([]);
  /** Đọc rộng file local theo module — gửi kèm job, không lưu DB */
  const [broadLocalContext, setBroadLocalContext] = useState(false);
  /** FE lọc ứng viên → AI xếp hạng path */
  const [useAiScope, setUseAiScope] = useState(true);
  /** P2: hiện file combobox (fallback) khi scope auto chưa khớp */
  const [showAdvancedSource, setShowAdvancedSource] = useState(false);
  const [, setContextSource] = useState<"ide" | "local-fs" | "agent-ide">("local-fs");
  const [testFwResolution, setTestFwResolution] = useState<TestFrameworkResolution | null>(
    null
  );
  const [skipTestFwInstall, setSkipTestFwInstall] = useState(false);
  const [repairing, setRepairing] = useState(false);
  const [inputMode, setInputMode] = useState<"requirement" | "single">(() => {
    return searchParams.get("reqId") ? "requirement" : "requirement";
  });
  const [moduleKey, setModuleKey] = useState<string | undefined>();
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const [batchResults, setBatchResults] = useState<BatchRow[]>([]);
  const [batchJobs, setBatchJobs] = useState<BatchStagingJob[]>([]);
  const [batchJobKey, setBatchJobKey] = useState<string | null>(null);
  const [batchFileRel, setBatchFileRel] = useState<string | null>(null);
  const [openApiSpec, setOpenApiSpec] = useState("");
  /** Bump after bind/sync so localPath re-reads from workspace store */
  const [sourceRootTick, setSourceRootTick] = useState(0);
  const [batchRunStatus, setBatchRunStatus] = useState<BatchRunStatus>("idle");
  const batchControlRef = useRef(createBatchRunControl());
  /** Per-TC scope cache only — never reuse primary across TCs in the same module. */
  const tcScopeCacheRef = useRef<Map<string, ScopeRank>>(new Map());

  useEffect(() => {
    return batchControlRef.current.subscribe(setBatchRunStatus);
  }, []);

  async function resolveTcSourcePrimaryCached(
    opts: Parameters<typeof resolveTcSourcePrimary>[0]
  ): Promise<ScopeRank> {
    const tcKey = opts.testCase.id;
    const hit = tcScopeCacheRef.current.get(tcKey);
    if (hit) {
      return { ...hit, reason: `${hit.reason} · tc-cache` };
    }
    const ranked = await resolveTcSourcePrimary(opts);
    tcScopeCacheRef.current.set(tcKey, ranked);
    return ranked;
  }

  const [requirementsList, setRequirementsList] = useState<ReqOption[]>([]);
  const [allTestCases, setAllTestCases] = useState<TestCase[]>([]);
  const [selectedReqId, setSelectedReqId] = useState<string | undefined>(() => {
    return searchParams.get("reqId") || searchParams.get("workspaceId") || undefined;
  });
  const [showAllTcStatus, setShowAllTcStatus] = useState<boolean>(false);

  useEffect(() => {
    const mode = searchParams.get("mode");
    const mod = searchParams.get("module");
    const tc = searchParams.get("testCaseId");
    const req = searchParams.get("reqId") || searchParams.get("workspaceId");
    if (req) {
      setSelectedReqId(req);
      setInputMode("requirement");
    }
    if (mode === "gaps") {
      setInputMode("requirement");
    } else if (mode === "module" && mod) {
      setInputMode("requirement");
      setModuleKey(decodeURIComponent(mod));
    } else if (mode === "single" && tc) {
      setInputMode("single");
      setTestCaseId(tc);
    }
  }, [searchParams]);

  const [gapsPrompted, setGapsPrompted] = useState(false);

  const filteredTestCases = useMemo(() => {
    let list = showAllTcStatus ? allTestCases : approved;
    // Unit Job chỉ lấy TC engine=unit (loại E2E/API).
    list = list.filter((tc) => isUnitTestCaseType(tc.type));
    if (selectedReqId && selectedReqId !== "__all__") {
      const req = requirementsList.find((r) => r.id === selectedReqId);
      if (req) {
        list = list.filter((tc) => tcBelongsToReq(tc, req));
      } else {
        // Fallback: match legacy sourceId or snapshot id until list loads
        list = list.filter(
          (tc) =>
            tc.sourceId === selectedReqId || tc.requirementSnapshotId === selectedReqId
        );
      }
    }
    return list;
  }, [allTestCases, approved, selectedReqId, showAllTcStatus, requirementsList]);

  const selectedReq = useMemo(
    () => requirementsList.find((r) => r.id === selectedReqId),
    [requirementsList, selectedReqId]
  );

  const moduleGroups = useMemo(() => {
    const map = new Map<string, TestCase[]>();
    for (const t of filteredTestCases) {
      const key = (t.module || "").trim() || "(Chưa gán module)";
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "vi"));
  }, [filteredTestCases]);

  useEffect(() => {
    if (moduleGroups.length === 0) {
      setModuleKey(undefined);
      return;
    }
    if (moduleKey) {
      const hit = moduleGroups.find(
        ([k]) => k === moduleKey || k.toLowerCase() === moduleKey.toLowerCase()
      );
      if (hit) {
        if (hit[0] !== moduleKey) setModuleKey(hit[0]);
        return;
      }
    }
    setModuleKey(moduleGroups[0][0]);
  }, [moduleGroups, moduleKey]);

  const localPath = useMemo(() => {
    void sourceRootTick;
    return project ? workspace.getLocalPath(project.id) : null;
  }, [project, sourceRootTick]);

  useEffect(() => {
    if (!isApiKind || !localPath) {
      setOpenApiSpec("");
      return;
    }
    void discoverOpenApiSpec(localPath).then(setOpenApiSpec);
  }, [isApiKind, localPath]);

  const meta = useMemo(
    () => normalizeProjectMeta(serverProject?.meta),
    [serverProject?.meta]
  );

  // Đổi project → xóa source/scope dính từ project cũ
  useEffect(() => {
    setManualSourcePick(false);
    manualSourcePickRef.current = false;
    setSourceFile(undefined);
    sourceFileRef.current = undefined;
    setRelatedSourceFiles([]);
    relatedSourceFilesRef.current = [];
    setSourceCode("");
    setContextPacket(null);
    setUnitPacketV1(null);
  }, [project?.id]);

  /**
   * Language theo file đang test trước (monorepo Forensic: .cs → C#, không để
   * ClientApp TS hoặc "C# + TypeScript" kéo framework sang Jest).
   * Nếu Ready đã khóa Jest/Vitest — ưu tiên TypeScript; bỏ qua docs/*.py auto-scope.
   */
  const lockedNodeFw =
    Boolean(testFwResolution?.framework) &&
    ["jest", "vitest", "mocha"].includes(testFwResolution!.framework);
  const sourceLang = languageFromSourcePath(sourceFile);
  const language =
    (sourceLang &&
    !(lockedNodeFw && sourceLang === "Python" && !manualSourcePick)
      ? sourceLang
      : null) ||
    (lockedNodeFw ? "TypeScript" : null) ||
    (serverProject?.language && !serverProject.language.includes("+")
      ? serverProject.language
      : null) ||
    (serverProject?.language?.toLowerCase().includes("c#") ? "C#" : null) ||
    serverProject?.language ||
    null;
  const syncedAt = metaSyncedAt(meta ?? undefined);
  const aiReady =
    conn?.status === "Ready" || conn?.status === "Connected" || Boolean(conn?.hasApiKey);

  const fwOptions = useMemo(
    () => testFrameworkOptions(language, meta),
    [language, meta]
  );

  useEffect(() => {
    if (!framework && fwOptions.length > 0) {
      setFramework(fwOptions[0].value);
    }
  }, [fwOptions, framework]);

  const onTestFwResolved = useCallback((res: TestFrameworkResolution | null) => {
    setTestFwResolution(res);
    if (res?.framework && res.framework !== "auto") {
      // Khóa khi đã có trong project; vẫn set gợi ý khi missing để Select không kẹt "auto"
      setFramework(res.framework);
    }
  }, []);

  const runnerOk = testRunnerAllowsGenerate(testFwResolution, skipTestFwInstall);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [allTcItems, studioRes, legacyRes, p, c] = await Promise.all([
        testcases.listAll({ projectId: project.id }),
        requirementStudio.listWorkspaces(project.id).catch(() => ({ items: [] as RequirementStudioWorkspace[] })),
        requirements.list(project.id, 1, 200).catch(() => ({ items: [] })),
        projects.get(project.id),
        connection.get(project.id).catch(() => null),
      ]);
      setAllTestCases(allTcItems);
      const appList = allTcItems.filter(
        (t) => t.reviewStatus === "Approved" && isUnitTestCaseType(t.type)
      );
      setApproved(appList);

      const studios = studioRes.items ?? [];
      const snapEntries = await Promise.all(
        studios.map(async (ws) => {
          try {
            const snaps = await requirementStudio.listSnapshots(ws.id);
            return [ws.id, (snaps.items ?? []).map((s) => s.id)] as const;
          } catch {
            return [ws.id, [] as string[]] as const;
          }
        })
      );
      const snapByWs = new Map(snapEntries);

      const studioOpts: ReqOption[] = studios.map((ws) => ({
        id: ws.id,
        title: ws.title,
        kind: "studio",
        legacySourceId: ws.legacySourceId ?? null,
        snapshotIds: snapByWs.get(ws.id) ?? [],
        tcTotal: ws.tcTotal,
        tcApproved: ws.tcApproved,
      }));

      const studioLegacyIds = new Set(
        studioOpts.map((o) => o.legacySourceId).filter(Boolean) as string[]
      );
      const studioIds = new Set(studioOpts.map((o) => o.id));
      const legacyOpts: ReqOption[] = (legacyRes.items ?? [])
        .filter((r) => !studioIds.has(r.id) && !studioLegacyIds.has(r.id))
        .map((r) => ({
          id: r.id,
          title: r.title,
          description: r.description ?? undefined,
          kind: "legacy",
          legacySourceId: r.id,
          snapshotIds: [],
        }));

      const merged = [...studioOpts, ...legacyOpts];
      setRequirementsList(merged);

      // Auto-select first Requirement when URL has none
      setSelectedReqId((prev) => {
        if (prev && merged.some((m) => m.id === prev)) return prev;
        if (prev && allTcItems.some((t) => t.sourceId === prev || t.requirementSnapshotId === prev)) {
          return prev;
        }
        return prev ?? merged[0]?.id;
      });

      setServerProject({
        ...p,
        meta: normalizeProjectMeta(p.meta) ?? p.meta,
      });
      setConn(c);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Tải thất bại");
    } finally {
      setLoading(false);
    }
  }, [project, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const loadSourceFiles = useCallback(async () => {
    if (!project?.id || !localPath || !isTauri()) return;
    try {
      const exts = sourceExtensionsForLanguage(language);
      // Local FS list first (Tauri); workspace list is fallback only
      let all: string[] = [];
      try {
        all = await ideListSourceFiles(localPath, exts);
      } catch {
        const wsId = await ensureWorkspaceOpen(project.id, localPath);
        all = await listWorkspaceSourceFiles(wsId, { limit: 5000 });
      }
      const allow = new Set(
        exts.map((e) => (e.startsWith(".") ? e : `.${e}`).toLowerCase())
      );
      const filtered = allow.size
        ? all.filter((p) => {
            const i = p.lastIndexOf(".");
            return i >= 0 && allow.has(p.slice(i).toLowerCase());
          })
        : all;
      setSourceFiles(filtered.map((p) => p.replace(/\\/g, "/")));
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Không liệt kê được file nguồn (Local FS)");
    }
  }, [project?.id, localPath, language, message]);

  useEffect(() => {
    void loadSourceFiles();
  }, [loadSourceFiles]);

  const selectedTc = useMemo(
    () => approved.find((t) => t.id === testCaseId),
    [approved, testCaseId]
  );

  const pathHint = useMemo(() => {
    if (!sourceCode.trim() && !sourceFile) return null;
    const className = guessClassFromCode(sourceCode, sourceFile || "");
    const reqTitle = selectedTc
      ? requirementTitleForTc(selectedTc, requirementsList, selectedReqId)
      : selectedReq?.title;
    return suggestUnitTestPath({
      language,
      framework: framework === "auto" ? "" : framework,
      sourceFileName: sourceFile ? displayRel(localPath, sourceFile) : undefined,
      className,
      module: selectedTc?.module || undefined,
      requirementTitle: reqTitle,
      testCaseTitle: selectedTc?.title,
    });
  }, [
    sourceCode,
    sourceFile,
    language,
    framework,
    localPath,
    selectedTc,
    requirementsList,
    selectedReqId,
    selectedReq?.title,
  ]);

  const matchSourceFile = useCallback(
    (pathOrRel: string): string | undefined => {
      if (!pathOrRel) return undefined;
      const rel = displayRel(localPath, pathOrRel).replace(/\\/g, '/').toLowerCase();
      return (
        sourceFiles.find((f) => f.replace(/\\/g, '/').toLowerCase() === rel) ??
        sourceFiles.find((f) => f.replace(/\\/g, '/').toLowerCase().endsWith(rel)) ??
        undefined
      );
    },
    [localPath, sourceFiles]
  );

  /** Multi-select: [primary, ...related] */
  const selectedSourcePaths = useMemo(() => {
    const out: string[] = [];
    if (sourceFile) out.push(sourceFile);
    for (const f of relatedSourceFiles) {
      if (f && !out.includes(f)) out.push(f);
    }
    return out;
  }, [sourceFile, relatedSourceFiles]);

  useEffect(() => {
    manualSourcePickRef.current = manualSourcePick;
  }, [manualSourcePick]);
  useEffect(() => {
    sourceFileRef.current = sourceFile;
  }, [sourceFile]);
  useEffect(() => {
    relatedSourceFilesRef.current = relatedSourceFiles;
  }, [relatedSourceFiles]);

  const resolveScope = useCallback(async () => {
    if (!localPath || !isTauri() || !selectedTc || !project?.id) {
      setContextPacket(null);
      setUnitPacketV1(null);
      return;
    }
    setScopeLoading(true);
    try {
      const wsId = await ensureWorkspaceOpen(project.id, localPath);
      let primary =
        manualSourcePickRef.current && sourceFileRef.current
          ? displayRel(localPath, sourceFileRef.current)
          : null;
      let related =
        manualSourcePickRef.current && relatedSourceFilesRef.current.length
          ? relatedSourceFilesRef.current.map((f) => displayRel(localPath, f))
          : ([] as string[]);

      let reason = 'Manual pick';
      if (!primary) {
        // Unit code Gen path uses startUnitIdeGenJob (Desktop gate + Extension CLI).
        // Scope UI: prefer Approved markers only — no AI/FE fuzzy (avoids dual resolve).
        const { extractTcSourceMarkers } = await import("@aitest/ide-protocol");
        const markers = extractTcSourceMarkers(
          [selectedTc.testData, selectedTc.steps, selectedTc.expectedResult]
            .filter(Boolean)
            .join("\n")
        );
        if (markers.paths[0]) {
          primary = markers.paths[0].replace(/\\/g, "/");
          related = markers.related.map((p) => p.replace(/\\/g, "/"));
          reason = "Test Data path:/code: markers";
        } else if (isApiKind) {
          const pathsForMatch =
            sourceFiles.length > 0
              ? sourceFiles.map((f) => displayRel(localPath, f))
              : await listWorkspaceSourceFiles(wsId).then((xs) =>
                  xs.map((x) => x.replace(/\\/g, "/"))
                ).catch(() => [] as string[]);
          const ranked = await resolveTcSourcePrimary({
            projectId: project.id,
            workspaceId: wsId,
            testCase: selectedTc,
            allSourcePaths: pathsForMatch,
            useAi: useAiScope && aiReady !== false,
            codeAliases: (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
              ?.codeAliases,
            preferredFramework: framework === "auto" ? testFwResolution?.framework : framework,
          });
          primary = ranked.primary;
          related = ranked.related ?? [];
          reason = ranked.reason || "BE workspace resolve";
        } else {
          primary = null;
          related = [];
          reason = "Chưa có path:/code: — Approve/enrich trước khi Gen Unit";
        }
      }

      let paths = [primary, ...related].filter(Boolean) as string[];
      let reads = await readWorkspaceFiles(wsId, paths);
      let byPath = new Map(reads.map((r) => [r.path.replace(/\\/g, "/"), r]));
      let primaryRel = (primary || "").replace(/\\/g, "/");
      let primaryContent = byPath.get(primaryRel)?.content || "";

      // Content-level gate (same as buildGenerateContext) so Local FS alert never shows a poison SUT.
      if (primaryRel && primaryContent && !manualSourcePickRef.current) {
        try {
          const { isPacketSutAcceptable } = await import("@aitest/ide-protocol");
          const aliases = (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
            ?.codeAliases;
          const ok = isPacketSutAcceptable({
            tcText: tcBlobForUnitScope(selectedTc),
            primaryPath: primaryRel,
            sourceExcerpt: primaryContent,
            codeAliases: aliases,
          });
          if (!ok) {
            primary = null;
            related = [];
            primaryRel = "";
            primaryContent = "";
            paths = [];
            byPath = new Map();
            reason = "Bỏ SUT lệch domain/align (content gate)";
          }
        } catch {
          /* keep path-only gate result */
        }
      }

      const relatedView = related.map((p) => {
        const rel = p.replace(/\\/g, "/");
        return {
          pathRel: rel,
          content: byPath.get(rel)?.content || "",
          role: "dependency" as const,
        };
      });

      const view: UnitContextPacket = {
        primaryPath: primaryRel,
        primaryContent,
        related: primaryRel
          ? [{ pathRel: primaryRel, content: primaryContent, role: "primary" }, ...relatedView]
          : relatedView,
        seed: primaryRel ? { pathRel: primaryRel, score: 100, reason } : null,
        candidates: paths.map((p) => ({
          pathRel: p.replace(/\\/g, "/"),
          score: 50,
          reason,
        })),
        mentionedPaths: [],
        truncated: [],
      };
      setContextPacket(view);
      setUnitPacketV1(null);

      if (!manualSourcePickRef.current) {
        if (primaryRel) {
          const primaryMatch = matchSourceFile(primaryRel) ?? primaryRel;
          setSourceFile(primaryMatch);
          sourceFileRef.current = primaryMatch;
          if (primaryContent) setSourceCode(primaryContent);
          const relatedMatches = related
            .map((r) => matchSourceFile(r) ?? r)
            .filter((p): p is string => Boolean(p) && p !== primaryMatch);
          setRelatedSourceFiles(relatedMatches);
          relatedSourceFilesRef.current = relatedMatches;
        } else {
          setSourceFile(undefined);
          sourceFileRef.current = undefined;
          setSourceCode("");
          setRelatedSourceFiles([]);
          relatedSourceFilesRef.current = [];
        }
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Quét scope thất bại');
    } finally {
      setScopeLoading(false);
    }
  }, [
    localPath,
    selectedTc,
    message,
    project?.id,
    useAiScope,
    aiReady,
    matchSourceFile,
    sourceFiles,
    framework,
    testFwResolution?.framework,
    serverProject?.meta,
    isApiKind,
  ]);

  useEffect(() => {
    void resolveScope();
  }, [resolveScope, testCaseId]);

  async function pickSource(file: string) {
    setManualSourcePick(true);
    manualSourcePickRef.current = true;
    const match = matchSourceFile(file) ?? displayRel(localPath, file);
    setSourceFile(match);
    sourceFileRef.current = match;
    setRelatedSourceFiles((prev) => {
      const next = prev.filter((f) => f !== match);
      relatedSourceFilesRef.current = next;
      return next;
    });
    const wsId = project ? getActiveWorkspaceId(project.id) : null;
    if (wsId) {
      try {
        const reads = await readWorkspaceFiles(wsId, [match]);
        setSourceCode(reads[0]?.content || '');
      } catch (e) {
        message.error(e instanceof Error ? e.message : 'Không đọc được file');
      }
    }
    void resolveScope();
  }

  function addRelatedSource(pathRel: string) {
    setManualSourcePick(true);
    manualSourcePickRef.current = true;
    const match = matchSourceFile(pathRel) ?? pathRel;
    if (sourceFileRef.current && match === sourceFileRef.current) return;
    setRelatedSourceFiles((prev) => {
      const next = prev.includes(match) ? prev : [...prev, match];
      relatedSourceFilesRef.current = next;
      return next;
    });
    void resolveScope();
  }

  async function pickSources(files: string[]) {
    setManualSourcePick(true);
    manualSourcePickRef.current = true;
    if (files.length === 0) {
      setSourceFile(undefined);
      sourceFileRef.current = undefined;
      setRelatedSourceFiles([]);
      relatedSourceFilesRef.current = [];
      setSourceCode('');
      void resolveScope();
      return;
    }
    const primary = files[0];
    const related = files.slice(1);
    setSourceFile(primary);
    sourceFileRef.current = primary;
    setRelatedSourceFiles(related);
    relatedSourceFilesRef.current = related;
    const wsId = project ? getActiveWorkspaceId(project.id) : null;
    if (localPath && isTauri()) {
      try {
        const content = await ideReadFile(localPath, primary);
        setSourceCode(content || "");
      } catch (e) {
        if (wsId) {
          try {
            const reads = await readWorkspaceFiles(wsId, [primary]);
            setSourceCode(reads[0]?.content || "");
          } catch (e2) {
            message.error(e2 instanceof Error ? e2.message : "Không đọc được file");
          }
        } else {
          message.error(e instanceof Error ? e.message : "Không đọc được file");
        }
      }
    }
    void resolveScope();
  }

  async function runForTestCase(
    tc: TestCase,
    opts?: { batch?: boolean }
  ) {
    if (!project || !localPath || !isTauri()) {
      throw new Error(
        isApiKind
          ? "Cần Desktop + thư mục local để sinh API test theo module."
          : "Cần Desktop + thư mục local để sinh unit theo module."
      );
    }
    const batch = Boolean(opts?.batch);
    if (!batch) {
      setManualSourcePick(false);
      manualSourcePickRef.current = false;
      setTestCaseId(tc.id);
    }

    const wsId = await ensureWorkspaceOpen(project.id, localPath);

    // Unit code Gen: Desktop orchestrates → Extension → Cursor CLI only (no API Gen).
    if (!isApiKind) {
      const aliases = (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
        ?.codeAliases;
      const reqTitle = requirementTitleForTc(tc, requirementsList, selectedReqId);
      const out = await startUnitIdeGenJob({
        projectRoot: localPath,
        projectId: project.id,
        tc,
        deps: {
          language,
          framework,
          broadLocalContext,
          sourceFiles,
          codeAliases: aliases,
          requirementTitle: reqTitle,
          onProgress: (msg) => {
            if (!batch) message.loading({ content: msg, key: "unit-gen", duration: 0 });
          },
        },
      });
      message.destroy("unit-gen");
      if (!out.ok) {
        throw new Error(out.error);
      }
      if (!batch) {
        message.success(
          `Unit Job (IDE) · ${out.manifest.runId.slice(0, 8)}… → ${out.writeRel}` +
            (out.manifest.sourceFileName ? ` · SUT ${out.manifest.sourceFileName}` : "")
        );
        const previews = await loadWorkspacePreviews(localPath, out.manifest);
        setResult({
          code: out.code,
          suggestedPath: out.writeRel,
          fileName: out.writeRel.split("/").pop() || "test.ts",
          testCaseId: tc.id,
          projectId: project.id,
          provider: "ide-extension",
          runnerUsed: "IDE_EXTENSION",
        });
        setWritePath(out.writeRel);
        setWsManifest(out.manifest);
        setWsPreviews(previews);
        setWsSelectedRel(out.manifest.files[0]?.targetRel || out.writeRel);
      }
      return { runId: out.runId, packagePrefix: out.packagePrefix };
    }

    // API Test artifact only (OpenAPI / handler) — still Desktop → API ↔ AI CLI.
    const paths =
      sourceFiles.length > 0
        ? sourceFiles
        : await ideListSourceFiles(localPath, sourceExtensionsForLanguage(language));
    const aliases = (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
      ?.codeAliases;

    const langLower = (language || "").toLowerCase();
    const useJsTsIndex =
      !/c#|csharp|dotnet|\.net|f#|vb|java|kotlin|python|go\b|php|ruby|swift/.test(langLower) &&
      (!!langLower || /typescript|javascript|tsx|jsx|\bts\b|\bjs\b|node/.test(langLower));

    let ctx;
    let primaryRel = "";
    let relatedRels: string[] = [];

    if (useJsTsIndex) {
      ctx = await buildGenerateContext({
        projectRoot: localPath,
        projectId: project.id,
        language: language || "",
        framework: framework === "auto" ? "" : framework || "",
        testCase: tc,
        allSourcePaths: paths,
        manualPrimaryPath: null,
        forcedRelatedPaths: null,
        broadLocalContext,
        codeAliases: aliases,
        preferIndexContext: true,
        syncIndexIfMissing: true,
      });
      primaryRel = (ctx.primaryPath || "").replace(/\\/g, "/");
      relatedRels = (ctx.packet.files || [])
        .filter((f) => f.role !== "primary")
        .map((f) => f.pathRel);
    }

    if (!primaryRel && !openApiSpec.trim()) {
      const ranked = await resolveTcSourcePrimaryCached({
        projectId: project.id,
        workspaceId: wsId,
        testCase: tc,
        allSourcePaths: paths.map((p) => displayRel(localPath, p)),
        useAi: useAiScope && aiReady !== false,
        codeAliases: aliases,
        preferredFramework: framework === "auto" ? testFwResolution?.framework : framework,
      });
      primaryRel = (ranked.primary || "").replace(/\\/g, "/");
      relatedRels = (ranked.related || []).map((p) => p.replace(/\\/g, "/"));
      if (!primaryRel && !openApiSpec.trim()) {
        throw new Error(
          `Không tìm handler/OpenAPI cho «${tc.title}». Thêm openapi.yaml hoặc chọn file thủ công.`
        );
      }
      ctx = await buildGenerateContext({
        projectRoot: localPath,
        projectId: project.id,
        language: language || "",
        framework: framework === "auto" ? "" : framework || "",
        testCase: tc,
        allSourcePaths: paths,
        manualPrimaryPath: primaryRel || null,
        forcedRelatedPaths: relatedRels,
        broadLocalContext,
        codeAliases: aliases,
        preferIndexContext: false,
      });
      primaryRel = (ctx.primaryPath || primaryRel).replace(/\\/g, "/");
    }

    if (!ctx) {
      throw new Error("Không tạo được context packet cho API test gen.");
    }

    const relName = primaryRel || "openapi.yaml";
    if (!batch) {
      setContextPacket(ctx.view);
      setUnitPacketV1(ctx.packet);
    }
    const classHint =
      guessClassFromCode(ctx.primaryContent, relName) ||
      ctx.packet.sourceUnderTest?.symbol ||
      "";
    const packagePrefix = await resolvePackagePrefix(localPath, relName);
    const unitProjectRules = await loadUnitProjectRules(localPath).catch(() => "");
    const genBody = buildIdeLocalGenerateBody({
      projectId: project.id,
      testCaseId: tc.id,
      packet: ctx.packetForApi,
      sourceFileName: relName,
      framework: framework === "auto" ? "" : framework || "",
      language,
      className: classHint,
      module: tc.module || undefined,
      packagePrefix,
      openApiSpec: openApiSpec || undefined,
      workspaceId: wsId,
      projectRoot: localPath,
      planner: ctx.planner,
      indexVersion: ctx.indexVersion,
      contextSource: ctx.contextSource,
      projectRules: unitProjectRules,
      projectRulesSource: unitProjectRules
        ? ("unit-conventions" as const)
        : ("none" as const),
    });
    const res = await generateApiTest.run(genBody);

    const view = ctx.view;
    const primaryContent = ctx.primaryContent;

    const reqTitle = requirementTitleForTc(tc, requirementsList, selectedReqId);
    const layoutModule = buildRequirementTcModule(reqTitle, tc.title, tc.module);
    const feHint = suggestApiTestPath({
      language,
      framework: framework === "auto" ? "" : framework,
      className: classHint,
      sourceFileName: relName,
      module: tc.module || undefined,
      requirementTitle: reqTitle,
      testCaseTitle: tc.title,
      packagePrefix,
    });
    const targetPath = uniquifyTestTargetRel(feHint.relativePath, tc.id);

    let manifest = await createUnitWorkspaceRun({
      projectRoot: localPath,
      projectId: project.id,
      testCaseId: tc.id,
      provider: res.provider,
      sourceFileName: relName,
      artifactKind: "api",
      packagePrefix,
      packageName: res.stackInspect?.package_name,
      status: "generating",
    });
    const added = await addArtifactToWorkspace({
      projectRoot: localPath,
      manifest,
      targetRel: targetPath,
      content: res.code,
      module: layoutModule,
    });
    manifest = added.manifest;
    syncWorkspaceRun(manifest, { module: layoutModule, status: "generated" });
    recordUnitJobMetric({
      projectId: project.id,
      contextSource: "local-fs",
      runnerUsed: res.runnerUsed,
      ideConnected: false,
      jobId: manifest.jobId,
      ok: true,
    });
    if (!batch) {
      message.success(
        `Unit Job đã tạo · ${manifest.runId.slice(0, 8)}… — xem Job Board`
      );
      const previews = await loadWorkspacePreviews(localPath, manifest);

      setUnitPacketV1(null);
      setContextPacket(view);
      setSourceCode(primaryContent);
      const primaryMatch = matchSourceFile(view.primaryPath) ?? view.primaryPath;
      setSourceFile(primaryMatch);
      sourceFileRef.current = primaryMatch;
      const relatedMatches = view.related
        .filter((r) => r.role === "dependency")
        .map((r) => matchSourceFile(r.pathRel) ?? r.pathRel)
        .filter((p): p is string => Boolean(p) && p !== primaryMatch);
      setRelatedSourceFiles(relatedMatches);
      relatedSourceFilesRef.current = relatedMatches;
      setResult(res);
      setWritePath(targetPath);
      setWsManifest(manifest);
      setWsPreviews(previews);
      setWsSelectedRel(added.entry.targetRel);
    }
    return { runId: manifest.runId, packagePrefix: manifest.packagePrefix };
  }

  function focusVerifyConsole() {
    setSuggestVerify(true);
    window.setTimeout(() => {
      document
        .getElementById("aitest-batch-verify-apply")
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  async function refreshBatchStaging(
    rows: BatchRow[],
    preferTargetRel?: string | null
  ) {
    if (!localPath || !isTauri()) {
      setBatchJobs([]);
      return;
    }
    const jobs: BatchStagingJob[] = [];
    for (const row of rows) {
      if (row.workspaceRunId && row.status === "ok") {
        try {
          const manifest = await loadManifest(
            localPath,
            row.workspaceRunId,
            row.packagePrefix
          );
          const previews = manifest
            ? await loadWorkspacePreviews(localPath, manifest)
            : [];
          jobs.push({ row, manifest, previews });
        } catch {
          jobs.push({ row, manifest: null, previews: [] });
        }
      } else {
        jobs.push({ row, manifest: null, previews: [] });
      }
    }
    setBatchJobs(jobs);
    if (jobs.length) {
      const want = preferTargetRel?.trim() || null;
      const keepJob = want
        ? jobs.find((j) =>
            j.previews.some((p) => p.entry.targetRel === want)
          )
        : null;
      if (keepJob && want) {
        setBatchJobKey(keepJob.row.key);
        setBatchFileRel(want);
        return;
      }
      const firstOk = jobs.find((j) => j.row.status === "ok" && j.previews.length);
      const pick = firstOk || jobs[0];
      setBatchJobKey(pick.row.key);
      setBatchFileRel(pick.previews[0]?.entry.targetRel ?? null);
    }
  }

  async function runRequirementBatch(retryFailsOnly = false) {
    if (!project || !selectedReqId) return;
    const req = requirementsList.find((r) => r.id === selectedReqId);
    const list = filteredTestCases;
    if (list.length === 0) return;
    if (!aiReady) {
      message.error("AI chưa Ready — vào Cấu hình AI để Verify trước.");
      return;
    }
    if (!localPath || !isTauri()) {
      message.error("Sinh theo Requirement cần Desktop + gắn project root trên trang này.");
      return;
    }

    const workList = retryFailsOnly
      ? list.filter((t) => batchResults.some((r) => r.key === t.id && r.status === "fail"))
      : list;

    if (workList.length === 0) {
      message.info(retryFailsOnly ? "Không có dòng lỗi để thử lại." : "Không có test case trong Requirement.");
      return;
    }

    const rowMap = new Map<string, BatchRow>();
    if (retryFailsOnly) {
      for (const r of batchResults) rowMap.set(r.key, r);
    } else {
      for (const t of list) {
        rowMap.set(t.id, {
          key: t.id,
          testCaseId: t.testCaseId,
          title: t.title,
          status: "fail",
          error: BATCH_NOTE_WAITING,
          ...batchTcSnapshot(t),
        });
      }
    }

    setBusy(true);
    const control = batchControlRef.current;
    control.start();
    tcScopeCacheRef.current.clear();
    setBatchProgress({ current: 0, total: workList.length, label: workList[0].title });

    let campaignId: string | undefined;
    if (!retryFailsOnly) {
      try {
        const camp = await audit.createCampaign({
          projectId: project.id,
          kind: isApiKind ? "api" : "unit",
          scopeLevel: "requirement",
          scopeLabel: req?.title || selectedReqId,
        });
        campaignId = camp.id;
      } catch {
        campaignId = undefined;
      }
    }

    try {
      const flushRows = () => {
        const rows = [...rowMap.values()];
        // Keep UI pause notes even after current TC finishes while paused.
        const next =
          control.getStatus() === "paused" ? markBatchRowsPaused(rows) : rows;
        setBatchResults(next);
        return next;
      };

      let done = 0;
      await runPool(
        workList,
        UNIT_GEN_CONCURRENCY,
        async (tc, i) => {
          setBatchProgress({
            current: done + 1,
            total: workList.length,
            label: tc.title,
          });
          const snap = batchTcSnapshot(tc);
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "fail",
            error: BATCH_NOTE_RUNNING,
            ...snap,
          });
          flushRows();
          try {
            const out = await runForTestCase(tc, { batch: true });
            rowMap.set(tc.id, {
              key: tc.id,
              testCaseId: tc.testCaseId,
              title: tc.title,
              status: "ok",
              workspaceRunId: out?.runId,
              packagePrefix: out?.packagePrefix,
              verifyStatus: "pending",
              applyStatus: "pending",
              ...snap,
            });
            if (campaignId) {
              void audit.addCampaignTasks(campaignId, [
                {
                  testCaseId: tc.id,
                  localRunId: out?.runId,
                  status: "ok",
                  sortOrder: i,
                },
              ]);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : "Lỗi";
            const uiErr = normalizeUnitGenErrorForUi(errMsg);
            const stack = e instanceof Error && e.stack ? `\n\n${e.stack}` : "";
            const logBody = `${new Date().toISOString()} · Generate FAIL · ${tc.testCaseId}\n${tc.title}\n\n${errMsg}${stack}`;
            let errorLogRel: string | undefined;
            if (localPath && isTauri()) {
              try {
                errorLogRel = await saveErrorLogFile(
                  localPath,
                  generateErrorLogRel(tc.testCaseId),
                  logBody
                );
              } catch {
                errorLogRel = undefined;
              }
            }
            rowMap.set(tc.id, {
              key: tc.id,
              testCaseId: tc.testCaseId,
              title: tc.title,
              status: "fail",
              error: uiErr,
              errorDetail: logBody,
              errorLogRel,
              ...snap,
            });
            if (campaignId) {
              void audit.addCampaignTasks(campaignId, [
                { testCaseId: tc.id, status: "fail", error: errMsg, sortOrder: i },
              ]);
            }
          }
          done += 1;
          setBatchProgress({
            current: done,
            total: workList.length,
            label: tc.title,
          });
          void refreshBatchStaging(flushRows());
        },
        { waitGate: () => control.waitIfPaused() }
      );
    } finally {
      control.reset();
      setBatchProgress(null);
      setBusy(false);
      const finalRows = [...rowMap.values()];
      void refreshBatchStaging(finalRows).then(() => {
        window.setTimeout(() => {
          document
            .getElementById("aitest-batch-staging-preview")
            ?.scrollIntoView({ behavior: "smooth", block: "start" });
        }, 150);
      });
    }
  }

  async function runModuleBatch(retryFailsOnly = false, moduleOverride?: string) {
    const activeModule = moduleOverride ?? moduleKey;
    if (!project || !activeModule) return;
    const list = moduleGroups.find(([k]) => k === activeModule)?.[1] ?? [];
    if (list.length === 0) return;
    if (!aiReady) {
      message.error("AI chưa Ready — vào Cấu hình AI để Verify trước.");
      return;
    }
    if (!localPath || !isTauri()) {
      message.error("Sinh theo module cần Desktop + gắn project root trên trang này.");
      return;
    }

    const workList = retryFailsOnly
      ? list.filter((t) => batchResults.some((r) => r.key === t.id && r.status === "fail"))
      : list;

    if (workList.length === 0) {
      message.info(retryFailsOnly ? "Không có dòng lỗi để thử lại." : "Không có test case trong module.");
      return;
    }

    const rowMap = new Map<string, BatchRow>();
    if (retryFailsOnly) {
      for (const r of batchResults) rowMap.set(r.key, r);
    } else {
      for (const t of list) {
        rowMap.set(t.id, {
          key: t.id,
          testCaseId: t.testCaseId,
          title: t.title,
          status: "fail",
          error: BATCH_NOTE_WAITING,
          ...batchTcSnapshot(t),
        });
      }
    }

    setModuleKey(activeModule);
    setBusy(true);
    const control = batchControlRef.current;
    control.start();
    tcScopeCacheRef.current.clear();
    setBatchProgress({ current: 0, total: workList.length, label: workList[0].title });

    let campaignId: string | undefined;
    if (!retryFailsOnly) {
      try {
        const camp = await audit.createCampaign({
          projectId: project.id,
          kind: isApiKind ? "api" : "unit",
          scopeLevel: gapsMode ? "project" : "module",
          scopeLabel: activeModule,
        });
        campaignId = camp.id;
      } catch {
        campaignId = undefined;
      }
    }

    try {
      const flushRows = () => {
        const rows = [...rowMap.values()];
        const next =
          control.getStatus() === "paused" ? markBatchRowsPaused(rows) : rows;
        setBatchResults(next);
        return next;
      };

      let done = 0;
      await runPool(
        workList,
        UNIT_GEN_CONCURRENCY,
        async (tc, i) => {
          setBatchProgress({
            current: done + 1,
            total: workList.length,
            label: tc.title,
          });
          const snap = batchTcSnapshot(tc);
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "fail",
            error: BATCH_NOTE_RUNNING,
            ...snap,
          });
          flushRows();
          try {
            const out = await runForTestCase(tc, { batch: true });
            rowMap.set(tc.id, {
              key: tc.id,
              testCaseId: tc.testCaseId,
              title: tc.title,
              status: "ok",
              workspaceRunId: out?.runId,
              packagePrefix: out?.packagePrefix,
              verifyStatus: "pending",
              applyStatus: "pending",
              ...snap,
            });
            if (campaignId) {
              void audit.addCampaignTasks(campaignId, [
                {
                  testCaseId: tc.id,
                  localRunId: out?.runId,
                  status: "ok",
                  sortOrder: i,
                },
              ]);
            }
          } catch (e) {
            const errMsg = e instanceof Error ? e.message : "Lỗi";
            const uiErr = normalizeUnitGenErrorForUi(errMsg);
            const stack = e instanceof Error && e.stack ? `\n\n${e.stack}` : "";
            const logBody = `${new Date().toISOString()} · Generate FAIL · ${tc.testCaseId}\n${tc.title}\n\n${errMsg}${stack}`;
            let errorLogRel: string | undefined;
            if (localPath && isTauri()) {
              try {
                errorLogRel = await saveErrorLogFile(
                  localPath,
                  generateErrorLogRel(tc.testCaseId),
                  logBody
                );
              } catch {
                errorLogRel = undefined;
              }
            }
            rowMap.set(tc.id, {
              key: tc.id,
              testCaseId: tc.testCaseId,
              title: tc.title,
              status: "fail",
              error: uiErr,
              errorDetail: logBody,
              errorLogRel,
              ...snap,
            });
            if (campaignId) {
              void audit.addCampaignTasks(campaignId, [
                { testCaseId: tc.id, status: "fail", error: errMsg, sortOrder: i },
              ]);
            }
          }
          done += 1;
          setBatchProgress({
            current: done,
            total: workList.length,
            label: tc.title,
          });
          void refreshBatchStaging(flushRows());
        },
        { waitGate: () => control.waitIfPaused() }
      );
      const finalRows = [...rowMap.values()];
      setBatchResults(finalRows);
      const failN = finalRows.filter(
        (r) => r.status === "fail" && !isBatchQueueNote(r.error)
      ).length;
      const okN = finalRows.filter((r) => r.status === "ok").length;
      if (campaignId) {
        void audit.finishCampaign(campaignId, failN > 0 ? "Partial" : "Completed");
      }
      if (failN === 0) {
        message.success(`Chức năng «${activeModule}»: ${okN}/${list.length} thành công${gapsMode ? "" : " — về Requirement."}`);
        if (!gapsMode) navigate(ROUTES.requirement);
      } else {
        message.warning(`Module «${activeModule}»: OK ${okN}, lỗi ${failN} / ${list.length} TC.`);
      }
      return { okN, failN };
    } finally {
      control.reset();
      setBusy(false);
      setBatchProgress(null);
      void refreshBatchStaging([...rowMap.values()]);
    }
  }

  async function runGapsCodeFill(moduleNames: string[]) {
    let totalOk = 0;
    let totalFail = 0;
    try {
      for (const name of moduleNames) {
        await batchControlRef.current.waitIfPaused();
        message.loading({ content: `Gap-fill module «${name}»…`, key: "gaps", duration: 0 });
        const res = await runModuleBatch(false, name);
        totalOk += res?.okN ?? 0;
        totalFail += res?.failN ?? 0;
      }
      message.success({
        key: "gaps",
        content: `Gap-fill code xong · OK ${totalOk} · lỗi ${totalFail} — về Requirement.`,
      });
      navigate(ROUTES.requirement);
    } catch (e) {
      message.error({
        key: "gaps",
        content: e instanceof Error ? e.message : "Gap-fill code thất bại",
      });
    }
  }

  useEffect(() => {
    if (!gapsMode || gapsPrompted || loading || !project || moduleGroups.length === 0) return;
    setGapsPrompted(true);
    const wanted = (gapsModulesParam ?? "")
      .split(",")
      .map((s) => decodeURIComponent(s.trim()))
      .filter(Boolean);
    const targets =
      wanted.length > 0
        ? moduleGroups.filter(([k]) =>
            wanted.some((w) => w === k || w.toLowerCase() === k.toLowerCase())
          )
        : moduleGroups;
    if (targets.length === 0) {
      message.warning("Không khớp module Approved cho gap-fill code.");
      return;
    }
    modal.confirm({
      title: "Gap-fill sinh mã — cả dự án",
      content: `Sẽ lần lượt sinh mã (bản nháp) cho ${targets.length} module. Có thể mất nhiều phút / token.`,
      okText: "Bắt đầu",
      cancelText: "Huỷ",
      onOk: () => void runGapsCodeFill(targets.map(([k]) => k)),
      onCancel: () => navigate(ROUTES.requirement),
    });
    // prompt once when approved modules ready
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [gapsMode, gapsPrompted, loading, project, moduleGroups, gapsModulesParam]);

  /** Unit code Gen: IDE Extension only (fail-closed). API Test artifact uses API path below. */
  async function runUnitJob() {
    try {
      await run();
    } finally {
      /* done */
    }
  }

  async function run() {
    if (!project || !testCaseId) {
      message.error("Cần chọn TC Approved.");
      return;
    }
    if (!aiReady) {
      message.error("AI chưa Ready — vào Cấu hình AI để Verify trước.");
      return;
    }
    if (!localPath || !isTauri()) {
      message.error("Cần Desktop + gắn project root.");
      return;
    }

    const tc =
      approved.find((t) => t.id === testCaseId) ||
      allTestCases.find((t) => t.id === testCaseId);
    if (!tc) {
      message.error("Không tìm thấy TC đã chọn.");
      return;
    }

    // Unit: Desktop orchestrates → Extension → Cursor CLI only.
    if (!isApiKind) {
      setBusy(true);
      try {
        const aliases = (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
          ?.codeAliases;
        const reqTitle = requirementTitleForTc(tc, requirementsList, selectedReqId);
        const out = await startUnitIdeGenJob({
          projectRoot: localPath,
          projectId: project.id,
          tc,
          deps: {
            language,
            framework,
            broadLocalContext,
            sourceFiles,
            codeAliases: aliases,
            requirementTitle: reqTitle,
            onProgress: (msg) =>
              message.loading({ content: msg, key: "unit-gen", duration: 0 }),
          },
        });
        message.destroy("unit-gen");
        if (!out.ok) {
          message.error(normalizeUnitGenErrorForUi(out.error));
          return;
        }
        setResult({
          code: out.code,
          suggestedPath: out.writeRel,
          fileName: out.writeRel.split("/").pop() || "test.ts",
          testCaseId: tc.id,
          projectId: project.id,
          provider: "ide-extension",
          runnerUsed: "IDE_EXTENSION",
        });
        setWritePath(out.writeRel);
        const previews = await loadWorkspacePreviews(localPath, out.manifest);
        setWsManifest(out.manifest);
        setWsPreviews(previews);
        setWsSelectedRel(out.manifest.files[0]?.targetRel || out.writeRel);
        const singleRow: BatchRow = {
          key: tc.id,
          testCaseId: tc.testCaseId,
          title: tc.title,
          status: "ok",
          workspaceRunId: out.manifest.runId,
          packagePrefix: out.manifest.packagePrefix,
          ...batchTcSnapshot(tc),
        };
        setBatchResults([singleRow]);
        await refreshBatchStaging([singleRow]);
        message.success(
          `Unit Job (IDE) · ${out.manifest.runId.slice(0, 8)}… · ${out.writeRel}`
        );
        focusVerifyConsole();
      } catch (e) {
        message.destroy("unit-gen");
        message.error(
          e instanceof Error ? normalizeUnitGenErrorForUi(e.message) : "Sinh unit thất bại"
        );
      } finally {
        setBusy(false);
      }
      return;
    }

    // API Test artifact — Desktop → API ↔ AI CLI.
    const hasFileScope = Boolean(
      sourceFile ||
        contextPacket?.primaryPath ||
        openApiSpec.trim()
    );
    const hasPastedOnly =
      Boolean(sourceCode.trim()) && !sourceFile && !contextPacket?.primaryPath;
    if (!hasFileScope && !hasPastedOnly && !openApiSpec.trim()) {
      message.error("Cần TC Approved và OpenAPI hoặc chọn file handler.");
      return;
    }

    setBusy(true);
    setResult(null);
    setWsManifest(null);
    setWsPreviews([]);
    setWsSelectedRel(null);
    setBatchResults([]);
    setBatchJobs([]);
    try {
      const wsId = await ensureWorkspaceOpen(project.id, localPath);

      type GenBody =
        | IdeLocalGenerateBody
        | {
            projectId: string;
            testCaseId: string;
            sourceFileName: string;
            sourceCode: string;
            framework: string;
            language?: string;
            className?: string;
            module?: string;
            openApiSpec?: string;
            projectRoot?: string;
          };

      let genBody: GenBody | null = null;
      let classHint = "";
      let outName = "";
      const usedLanguage = language;
      const usedSource: "ide" | "local-fs" | "agent-ide" = "local-fs";

      {
        const relName = sourceFile
          ? displayRel(localPath, sourceFile)
          : contextPacket?.primaryPath ||
            ("snippet" + (language?.toLowerCase().includes("python") ? ".py" : ".txt"));
        const relatedRels = relatedSourceFiles.map((f) => displayRel(localPath, f));
        classHint = guessClassFromCode(sourceCode, relName);
        outName = relName;
        setContextSource("local-fs");

        const pastedOnly =
          Boolean(sourceCode.trim()) && !sourceFile && !contextPacket?.primaryPath;

        if (pastedOnly) {
          genBody = {
            projectId: project.id,
            testCaseId,
            sourceFileName: relName,
            sourceCode: sourceCode.trim(),
            framework: framework === "auto" ? "" : framework || "",
            language: language ?? undefined,
            className: classHint,
            module: tc.module || undefined,
            projectRoot: localPath,
            openApiSpec: openApiSpec || undefined,
          };
        } else {
          const paths =
            sourceFiles.length > 0
              ? sourceFiles
              : await ideListSourceFiles(localPath, sourceExtensionsForLanguage(language));
          const ctx = await buildGenerateContext({
            projectRoot: localPath,
            projectId: project.id,
            language: language || "",
            framework: framework === "auto" ? "" : framework || "",
            testCase: tc,
            allSourcePaths: paths,
            manualPrimaryPath:
              sourceFile ? relName : contextPacket?.primaryPath || null,
            forcedRelatedPaths: relatedRels,
            broadLocalContext,
            codeAliases: (serverProject?.meta as { codeAliases?: Record<string, string[]> } | null)
              ?.codeAliases,
          });
          setContextPacket(ctx.view);
          setUnitPacketV1(ctx.packet);
          if (ctx.primaryContent) setSourceCode(ctx.primaryContent);
          classHint =
            guessClassFromCode(ctx.primaryContent || sourceCode, ctx.primaryPath || relName) ||
            ctx.packet.sourceUnderTest?.symbol ||
            classHint;
          outName = ctx.primaryPath || relName;
          genBody = buildIdeLocalGenerateBody({
            projectId: project.id,
            testCaseId,
            packet: ctx.packetForApi,
            sourceFileName: outName,
            framework: framework === "auto" ? "" : framework || "",
            language: language ?? undefined,
            className: classHint,
            module: tc.module || undefined,
            openApiSpec: openApiSpec || undefined,
            workspaceId: wsId,
            projectRoot: localPath,
            planner: ctx.planner,
            indexVersion: ctx.indexVersion,
            contextSource: ctx.contextSource,
          });
        }
      }

      if (!genBody) {
        message.error("Không tạo được payload sinh test.");
        return;
      }

      const prepared = genBody;
      const packagePrefix = await resolvePackagePrefix(localPath, outName);
      const unitProjectRules = await loadUnitProjectRules(localPath).catch(() => "");
      const body = {
        ...prepared,
        packagePrefix,
        projectRules: unitProjectRules,
        projectRulesSource: unitProjectRules
          ? ("unit-conventions" as const)
          : ("none" as const),
      };

      const res = await generateApiTest.run(body);
      setResult(res);
      const reqTitle = selectedTc
        ? requirementTitleForTc(selectedTc, requirementsList, selectedReqId)
        : selectedReq?.title || "";
      const layoutModule = buildRequirementTcModule(
        reqTitle,
        selectedTc?.title,
        selectedTc?.module
      );
      const feHint = suggestApiTestPath({
        language: usedLanguage,
        framework: framework === "auto" ? "" : framework,
        className: classHint,
        sourceFileName: outName,
        module: selectedTc?.module || undefined,
        requirementTitle: reqTitle,
        testCaseTitle: selectedTc?.title,
        packagePrefix,
      });
      const targetPath = uniquifyTestTargetRel(feHint.relativePath, testCaseId || "");
      setWritePath(targetPath);
      if (localPath && isTauri() && targetPath) {
        let manifest = await createUnitWorkspaceRun({
          projectRoot: localPath,
          projectId: project.id,
          testCaseId,
          provider: res.provider,
          sourceFileName: outName,
          artifactKind: "api",
          packagePrefix,
          packageName: res.stackInspect?.package_name,
          status: "generating",
        });
        const added = await addArtifactToWorkspace({
          projectRoot: localPath,
          manifest,
          targetRel: targetPath,
          content: res.code,
          module: layoutModule,
        });
        manifest = added.manifest;
        syncWorkspaceRun(manifest, {
          status: "generated",
          contextSource: usedSource,
          module: layoutModule,
        });
        recordUnitJobMetric({
          projectId: project.id,
          contextSource: usedSource,
          runnerUsed: res.runnerUsed,
          ideConnected: false,
          jobId: manifest.jobId,
          ok: true,
        });
        const previews = await loadWorkspacePreviews(localPath, manifest);
        setWsManifest(manifest);
        setWsPreviews(previews);
        setWsSelectedRel(added.entry.targetRel);
        const singleRow: BatchRow = {
          key: tc.id,
          testCaseId: tc.testCaseId,
          title: tc.title,
          status: "ok",
          workspaceRunId: manifest.runId,
          packagePrefix: manifest.packagePrefix,
          ...batchTcSnapshot(tc),
        };
        setBatchResults([singleRow]);
        await refreshBatchStaging([singleRow]);
        message.success(`Đã sinh API test · Bản nháp (${added.entry.op})`);
        focusVerifyConsole();
      } else {
        setWsManifest(null);
        setWsPreviews([]);
        setWsSelectedRel(null);
        setBatchResults([]);
        setBatchJobs([]);
        message.success(
          `Đã sinh API test bằng ${res.provider}${
            res.runnerUsed === "AI_CLI" ? " · AI CLI" : ""
          } (chưa lưu bản nháp — cần Desktop + project root)`
        );
      }
    } catch (e) {
      message.error(
        e instanceof Error ? e.message : "Sinh API test thất bại"
      );
    } finally {
      setBusy(false);
    }
  }

  async function updateWorkspacePath() {
    if (!result || !localPath || !isTauri() || !wsManifest || !writePath.trim()) return;
    setBusy(true);
    try {
      const added = await addArtifactToWorkspace({
        projectRoot: localPath,
        manifest: wsManifest,
        targetRel: writePath.trim(),
        content: result.code,
      });
      const previews = await loadWorkspacePreviews(localPath, added.manifest);
      setWsManifest(added.manifest);
      setWsPreviews(previews);
      setWsSelectedRel(added.entry.targetRel);
      message.success("Đã cập nhật file trong bản nháp test");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Cập nhật staging thất bại");
    } finally {
      setBusy(false);
    }
  }

  async function repairWorkspaceWithAi(
    baseManifest?: UnitWorkspaceManifest
  ): Promise<UnitWorkspaceManifest | null> {
    if (!project || !testCaseId || !localPath || !isTauri()) return null;
    const current = baseManifest ?? wsManifest;
    if (!current) return null;
    const previews = await loadWorkspacePreviews(localPath, current);
    const selected =
      previews.find((p) => p.entry.targetRel === (wsSelectedRel || previews[0]?.entry.targetRel)) ??
      previews[0] ??
      null;
    if (!selected) {
      message.warning("Không có file bản nháp để repair.");
      return null;
    }
    const failedStages = current.verify?.stages.filter((s) => !s.success) ?? [];
    const errorLog = failedStages
      .map(
        (s) =>
          `[${s.stage}] command=${s.command} exit=${s.exitCode}\n${(s.logExcerpt || "").slice(-2500)}`
      )
      .join("\n\n");
    const { buildUnitRepairContext, UNIT_REPAIR_TOP_K } = await import(
      "../lib/unitWorkspace/unitFailureMetrics"
    );
    const { repairContext, failClass } = buildUnitRepairContext({
      runId: current.runId,
      targetRel: selected.entry.targetRel,
      errorLog: errorLog || "Verify failed (no stage logs).",
      attempt: (current.repairAttempts ?? 0) + 1,
      maxAttempts: 3,
    });

    // Phase 6 slim repair: SUT + failing test + Top-K deps (no full packet re-expand)
    const primary =
      unitPacketV1?.files?.find((f) => f.role === "primary") ||
      (contextPacket?.primaryPath
        ? {
            pathRel: contextPacket.primaryPath,
            content: contextPacket.primaryContent || "",
          }
        : null);
    const deps =
      unitPacketV1?.files
        ?.filter((f) => f.role === "dependency")
        .slice(0, UNIT_REPAIR_TOP_K) ??
      contextPacket?.related
        ?.filter((r) => r.role === "dependency")
        .slice(0, UNIT_REPAIR_TOP_K)
        .map((r) => ({ pathRel: r.pathRel, content: r.content })) ??
      [];

    setRepairing(true);
    try {
      // Unit Repair: Extension → AI CLI (same engine as Gen). API /generate-unit is legacy.
      if (!isApiKind) {
        const { repairUnitViaIdeExtension } = await import(
          "../lib/unitWorkspace/repairUnitViaIde"
        );
        const aliases = (serverProject?.meta as { codeAliases?: CodeAliasMap } | null)
          ?.codeAliases;
        const out = await repairUnitViaIdeExtension({
          manifest: current,
          input: {
            projectRoot: localPath,
            projectId: project.id,
            testCaseId: selectedTc?.testCaseId || testCaseId,
            title: selectedTc?.title || selected.entry.targetRel,
            module: selectedTc?.module,
            targetRel: selected.entry.targetRel,
            failingTestContent: selected.content,
            repairContext: `${repairContext}\n\n(failClass=${failClass})`,
            primaryPath: primary?.pathRel,
            primaryContent: primary?.content,
            packagePrefix: current.packagePrefix,
            testData: selectedTc?.testData,
            steps: selectedTc?.steps,
            expectedOutcome: selectedTc?.expectedResult,
            contextPacket: unitPacketV1 || contextPacket || undefined,
            codeAliases: aliases,
          },
        });
        if (!out.ok) {
          message.error(normalizeUnitGenErrorForUi(out.error));
          throw new Error(out.error);
        }
        const nextPreviews = await loadWorkspacePreviews(localPath, out.manifest);
        setResult({
          code: out.code,
          suggestedPath: selected.entry.targetRel,
          fileName: selected.entry.targetRel.split("/").pop() || "test.ts",
          testCaseId,
          projectId: project.id,
          provider: "ide-extension",
          runnerUsed: "IDE_EXTENSION_REPAIR",
        });
        setWsManifest(out.manifest);
        setWsPreviews(nextPreviews);
        setWsSelectedRel(selected.entry.targetRel);
        return out.manifest;
      }

      const unitProjectRules = await loadUnitProjectRules(localPath).catch(() => "");
      const repairBody = {
        projectId: project.id,
        testCaseId,
        sourceFileName:
          primary?.pathRel || current.sourceFileName || selected.entry.targetRel,
        sourceCode: primary?.content || selected.content,
        framework: framework === "auto" ? "" : framework || "",
        language: language ?? undefined,
        className: guessClassFromCode(
          primary?.content || selected.content,
          primary?.pathRel || selected.entry.targetRel
        ),
        module: selectedTc?.module || undefined,
        packagePrefix: current.packagePrefix,
        projectRoot: localPath,
        relatedSources: [
          { path: selected.entry.targetRel, content: selected.content, role: "test" },
          ...deps.map((d) => ({
            path: d.pathRel,
            content: d.content,
            role: "dependency",
          })),
        ],
        repairContext: `${repairContext}\n\n(failClass=${failClass})`,
        ...(isApiKind ? { openApiSpec: openApiSpec || undefined } : {}),
        projectRules: unitProjectRules,
        projectRulesSource: unitProjectRules
          ? ("unit-conventions" as const)
          : ("none" as const),
      };
      // API Test Repair only — Unit uses Extension path above.
      const res = await generateApiTest.run(repairBody);

      const added = await addArtifactToWorkspace({
        projectRoot: localPath,
        manifest: {
          ...current,
          repairAttempts: (current.repairAttempts ?? 0) + 1,
        },
        targetRel: selected.entry.targetRel,
        content: res.code,
      });
      const nextPreviews = await loadWorkspacePreviews(localPath, added.manifest);
      setResult(res);
      setWsManifest(added.manifest);
      setWsPreviews(nextPreviews);
      setWsSelectedRel(selected.entry.targetRel);
      return added.manifest;
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Repair thất bại");
      throw e;
    } finally {
      setRepairing(false);
    }
  }

  const pageTitle = "Unit test";

  function onSourceRootBound(payload: {
    rootPath: string;
    syncedProject: Project | null;
    scan: import("../tauri/bridge").ProjectScan;
  }) {
    setSourceRootTick((n) => n + 1);
    if (payload.syncedProject) {
      setServerProject({
        ...payload.syncedProject,
        meta: normalizeProjectMeta(payload.syncedProject.meta) ?? payload.syncedProject.meta,
      });
    } else if (payload.scan.language) {
      setServerProject((prev) =>
        prev
          ? {
              ...prev,
              language: payload.scan.language ?? prev.language,
              framework: (payload.scan.frameworks ?? [])[0] ?? prev.framework,
            }
          : prev
      );
    }
  }

  function onSourceRootSynced(p: Project) {
    setServerProject({
      ...p,
      meta: normalizeProjectMeta(p.meta) ?? p.meta,
    });
    setSourceRootTick((n) => n + 1);
  }

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2} style={{ margin: 0 }}>
          {pageTitle}
        </Typography.Title>
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 16 }}
          title="Chưa chọn dự án"
          description={
            <span>
              Vào tab <Link to="/projects">Dự án</Link> để chọn hoặc tạo dự án trước.
            </span>
          }
        />
      </div>
    );
  }

  const pipelineStep = useMemo(() => {
    if (wsManifest?.status === "applied") return 3;
    if (wsManifest && (wsManifest.status === "pass" || wsManifest.status === "fail" || wsManifest.status === "verifying"))
      return 2;
    if (result || wsManifest) return 1;
    if (isIdeCodegenReady()) return 0;
    return 0;
  }, [wsManifest, result]);

  const batchFailCount = batchResults.filter(
    (r) => r.status === "fail" && !isBatchQueueNote(r.error)
  ).length;

  function pauseUnitBatch() {
    batchControlRef.current.pause();
    setBatchResults((prev) => markBatchRowsPaused(prev));
  }

  function resumeUnitBatch() {
    setBatchResults((prev) => markBatchRowsResumed(prev));
    batchControlRef.current.resume();
  }
  const noApproved = approved.length === 0;

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            {pageTitle}
          </Typography.Title>
          <Typography.Text type="secondary">
            TC Approved → Project root → Unit Job → Staging → Verify → Apply AItest/
          </Typography.Text>
        </div>
        <Space>
          <Link to={activityUrl({ tab: "unit-jobs" })}>
            <Button>Unit Job Board</Button>
          </Link>
          <Button onClick={() => void load()} loading={loading}>
            Tải lại
          </Button>
        </Space>
      </header>

      <Space orientation="vertical" size={12} style={{ width: "100%", marginTop: 12 }}>
        <ReadyStrip
          aiReady={Boolean(aiReady)}
          aiProvider={aiConnectionDisplayLabel(conn)}
          localPath={localPath}
          syncedAt={syncedAt}
          project={project ? { id: project.id, name: project.name } : null}
          meta={meta}
          preferredLanguage={language}
          sourceFile={sourceFile || null}
          testFwResolution={testFwResolution}
          skipTestFwInstall={skipTestFwInstall}
          onSkipChange={setSkipTestFwInstall}
          onTestFwResolved={onTestFwResolved}
          extraAlerts={
            isApiKind && localPath && !openApiSpec ? (
              <Alert
                style={{ marginTop: 10 }}
                type="info"
                showIcon
                title="Chưa thấy OpenAPI/Swagger ở root"
                description="Đặt openapi.yaml/json hoặc swagger.yaml — hoặc chọn file handler trong Nâng cao."
              />
            ) : null
          }
        />

        {!isIdeCodegenReady() && !isApiKind ? (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 8 }}
            message="Connect IDE bắt buộc trước Gen Unit"
            description={
              <span>
                Thứ tự: Approve (ghi TC MD) →{" "}
                <Link to={ROUTES.projects}>Connect IDE (Dự án)</Link> → Gen → Verify → Apply.
                Không còn fallback API tự động.
              </span>
            }
          />
        ) : null}
        <CodegenResultPanel title="IDE Extension — Gen / Apply / Run" />
        {wsManifest?.timeline?.length ? (
          <Collapse
            style={{ marginBottom: 8 }}
            items={[
              {
                key: "timeline",
                label: `Job timeline · ${wsManifest.jobId || wsManifest.runId} · ${wsManifest.status}${
                  wsManifest.via ? ` · ${wsManifest.via}` : ""
                }`,
                children: (
                  <Typography.Paragraph
                    style={{ margin: 0, fontFamily: "monospace", fontSize: 12, whiteSpace: "pre-wrap" }}
                  >
                    {(wsManifest.timeline || [])
                      .map(
                        (e) =>
                          `${e.at}  ${e.event}${e.detail ? ` — ${e.detail}` : ""}`
                      )
                      .join("\n")}
                    {wsManifest.transforms?.length
                      ? `\ntransforms: ${wsManifest.transforms.join(", ")}`
                      : ""}
                  </Typography.Paragraph>
                ),
              },
            ]}
          />
        ) : null}

        {noApproved ? (
          <Card style={{ textAlign: "center", padding: "48px 24px" }}>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              Chưa có test case Unit Approved
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ maxWidth: 420, margin: "0 auto 20px" }}>
              Sinh Unit chỉ dùng TC type=Unit (hoặc Functional/Boundary/Negative) đã duyệt.
              TC E2E/API nằm ở trang tương ứng — không đưa vào Unit Job.
            </Typography.Paragraph>
            <Space wrap>
              <Link to={generateTcUrl()}>
                <Button type="primary" size="large">
                  Sinh / duyệt TC
                </Button>
              </Link>
              <Link to={requirementUrl({ tab: "review" })}>
                <Button size="large">Mở hàng duyệt</Button>
              </Link>
            </Space>
          </Card>
        ) : null}
      </Space>

      {!noApproved ? (
        <>
      <Steps
        current={pipelineStep}
        style={{ marginTop: 16, marginBottom: 8, maxWidth: 720 }}
        items={[
          { title: "Approve + IDE" },
          { title: "Unit Job" },
          { title: "Verify" },
          { title: "Apply" },
        ]}
      />

      <Card title="Unit Job · AI CLI" style={{ marginTop: 8 }} loading={loading}>
        <Radio.Group
          value={inputMode}
          onChange={(e) => setInputMode(e.target.value as "requirement" | "single")}
          style={{ marginBottom: 16 }}
        >
          <Radio.Button value="requirement">📌 Theo Requirement (Batch tất cả TC)</Radio.Button>
          <Radio.Button value="single">🎯 Theo Test Case (Từng TC lẻ)</Radio.Button>
        </Radio.Group>

        {inputMode === "requirement" ? (
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            <div>
              <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                1. Chọn Yêu cầu (Requirement) muốn chạy Unit Test hàng loạt:
              </Typography.Text>
              <Select
                style={{ width: "100%" }}
                size="large"
                placeholder="— Chọn Requirement (Studio) trong dự án —"
                value={selectedReqId || undefined}
                onChange={(val) => setSelectedReqId(val)}
                options={requirementsList.map((r) => {
                  const linkedTc = allTestCases.filter(
                    (t) => isUnitTestCaseType(t.type) && tcBelongsToReq(t, r)
                  );
                  const appCount = linkedTc.filter((t) => t.reviewStatus === "Approved").length;
                  const total = linkedTc.length;
                  const approvedN = appCount;
                  return {
                    value: r.id,
                    label: `📄 ${r.title} (${total} Unit TC · ${approvedN} Approved)`,
                  };
                })}
                notFoundContent={
                  <div style={{ padding: 12, textAlign: "center" }}>
                    <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                      Chưa có Requirement Studio nào trong dự án.
                    </Typography.Text>
                    <Link to={ROUTES.requirement}>
                      <Button size="small" type="primary">Sang Requirement</Button>
                    </Link>
                  </div>
                }
              />
            </div>

            {selectedReq ? (
              <Alert
                type="info"
                showIcon
                title={`Yêu cầu: ${selectedReq.title}`}
                description={
                  <div>
                    {selectedReq.description ? <div>{selectedReq.description}</div> : null}
                    <div style={{ marginTop: 6 }}>
                      Tự động sinh mã + bản nháp cho tất cả <strong>{filteredTestCases.length} Unit TC</strong> thuộc Yêu cầu này
                      {selectedReq.kind === "studio" ? " (Requirement Studio)" : ""}.
                    </div>
                  </div>
                }
                action={
                  <Radio.Group
                    size="small"
                    value={showAllTcStatus ? "all" : "approved"}
                    onChange={(e) => setShowAllTcStatus(e.target.value === "all")}
                  >
                    <Radio.Button value="approved">Chỉ Approved</Radio.Button>
                    <Radio.Button value="all">Tất cả (Gồm Draft)</Radio.Button>
                  </Radio.Group>
                }
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                title="Chưa chọn Yêu cầu"
                description="Vui lòng chọn 1 Yêu cầu ở ô trên để tiến hành sinh Unit Test cho tất cả Test Cases của Yêu cầu đó."
              />
            )}

            {batchProgress ? (
              <Progress
                percent={Math.round((batchProgress.current / batchProgress.total) * 100)}
                status={batchRunStatus === "paused" ? "normal" : "active"}
                format={() => `${batchProgress.current}/${batchProgress.total}`}
              />
            ) : null}
            {batchProgress ? (
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {batchRunStatus === "paused"
                  ? `Tạm dừng · đã ${batchProgress.current}/${batchProgress.total} · có thể Kiểm thử tất cả phần đã gen · chờ Tiếp tục`
                  : `Đang xử lý: ${batchProgress.label}`} 
              </Typography.Text>
            ) : null}

            <Space wrap style={{ marginTop: 4 }}>
              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={() => void runRequirementBatch(false)}
                loading={busy && batchRunStatus === "running"}
                disabled={
                  !aiReady ||
                  !selectedReqId ||
                  filteredTestCases.length === 0 ||
                  !localPath ||
                  !isTauri() ||
                  batchRunStatus === "paused" ||
                  (busy && batchRunStatus === "running") ||
                  (!isApiKind && !isIdeCodegenReady())
                }
              >
                ⚡ Chạy Unit Job · Tất cả Unit TC trong Requirement ({filteredTestCases.length} TC)
              </Button>
              {batchRunStatus === "running" ? (
                <Button
                  icon={<PauseCircleOutlined />}
                  onClick={() => pauseUnitBatch()}
                >
                  Tạm dừng
                </Button>
              ) : null}
              {batchRunStatus === "paused" ? (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={() => resumeUnitBatch()}
                >
                  Tiếp tục
                </Button>
              ) : null}
            </Space>

            {batchResults.length > 0 ? (
              <BatchRunConsole
                variant="table"
                title="Kết quả Generate (batch)"
                rows={batchResults}
                onRowsChange={(rows) => {
                  setBatchResults(rows);
                  void refreshBatchStaging(rows);
                }}
                projectRoot={localPath!}
                language={language}
                framework={framework}
                meta={meta ?? undefined}
                stackInspect={result?.stackInspect}
                busy={busy}
                onBusy={setBusy}
                batchControl={batchControlRef.current}
                batchRunStatus={batchRunStatus}
                generateFailCount={batchFailCount}
                onRetryGenerateFails={() => void runRequirementBatch(true)}
              />
            ) : null}
          </Space>
        ) : (
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            <div>
              <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                1. Chọn Yêu cầu (Requirement) để lọc Test Case:
              </Typography.Text>
              <Select
                style={{ width: "100%" }}
                placeholder="— Tất cả Requirement trong dự án —"
                value={selectedReqId || "__all__"}
                onChange={(val) => setSelectedReqId(val === "__all__" ? undefined : val)}
                options={[
                  { value: "__all__", label: `📦 Tất cả Requirement (${requirementsList.length})` },
                  ...requirementsList.map((r) => {
                    const linkedTc = allTestCases.filter(
                      (t) => isUnitTestCaseType(t.type) && tcBelongsToReq(t, r)
                    );
                    const appCount = linkedTc.filter((t) => t.reviewStatus === "Approved").length;
                    return {
                      value: r.id,
                      label: `📄 ${r.title} (${linkedTc.length} Unit TC · ${appCount} Approved)`,
                    };
                  }),
                ]}
                notFoundContent={
                  <div style={{ padding: 8, textAlign: "center" }}>
                    <Link to={ROUTES.requirement}>Tạo Requirement Studio</Link>
                  </div>
                }
              />
            </div>
            <div>
              <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                2. Chọn Test Case cụ thể ({filteredTestCases.length}):
              </Typography.Text>
              <Select
                style={{ width: "100%" }}
                placeholder="— chọn test case —"
                value={testCaseId}
                onChange={(id) => {
                  setManualSourcePick(false);
                  manualSourcePickRef.current = false;
                  setTestCaseId(id);
                }}
                options={filteredTestCases.map((t) => ({
                  value: t.id,
                  label: `${t.testCaseId} · ${t.title} [${t.reviewStatus}]`,
                }))}
                showSearch
                optionFilterProp="label"
              />
            </div>

            {localPath && isTauri() ? (
              <Alert
                type={contextPacket?.primaryPath || sourceFile ? "success" : "info"}
                showIcon
                title={
                  contextPacket?.primaryPath || sourceFile
                    ? `Local FS · ${contextPacket?.primaryPath || sourceFile}`
                    : "Local FS · đang khớp file từ TC"
                }
                description={
                  contextPacket?.primaryPath || sourceFile
                    ? "Đọc source trên máy → AI CLI sinh → Staging."
                    : "Chọn TC rồi đợi scope, hoặc mở «Nâng cao · chọn file» nếu chưa khớp."
                }
                action={
                  <Button size="small" onClick={() => void resolveScope()} loading={scopeLoading}>
                    Quét scope
                  </Button>
                }
              />
            ) : (
              <Alert
                type="warning"
                showIcon
                title="Gắn project root để chạy Unit Job"
                description="Mở Ready → Chi tiết → Project root."
              />
            )}

            <div>
              <Typography.Text strong>Framework test</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 6 }}
                value={framework}
                onChange={setFramework}
                disabled={Boolean(testFwResolution?.locked && !skipTestFwInstall)}
                options={fwOptions.map((o) => ({ value: o.value, label: o.label }))}
              />
              {!runnerOk ? (
                <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                  Mở Ready → Chi tiết → Test runner để cài (hoặc bỏ qua).
                </Typography.Text>
              ) : null}
              {pathHint ? (
                <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 4 }}>
                  Gợi ý path: <code>{pathHint.relativePath}</code>
                </Typography.Text>
              ) : null}
            </div>

            <Space wrap>
              <Button
                type="primary"
                size="large"
                icon={<ThunderboltOutlined />}
                onClick={() => void runUnitJob()}
                loading={busy}
                disabled={
                  !aiReady ||
                  !testCaseId ||
                  !runnerOk ||
                  !localPath ||
                  !isTauri() ||
                  (isApiKind
                    ? !(
                        Boolean(contextPacket?.primaryPath) ||
                        Boolean(sourceFile) ||
                        Boolean(sourceCode.trim()) ||
                        Boolean(openApiSpec.trim())
                      )
                    : !isIdeCodegenReady())
                }
              >
                Chạy Unit Job
              </Button>
            </Space>

            {batchResults.length > 0 ? (
              <BatchRunConsole
                variant="table"
                title="Kết quả Generate"
                rows={batchResults}
                onRowsChange={(rows) => {
                  setBatchResults(rows);
                  void refreshBatchStaging(rows);
                }}
                projectRoot={localPath!}
                language={language}
                framework={framework}
                meta={meta ?? undefined}
                stackInspect={result?.stackInspect}
                busy={busy}
                onBusy={setBusy}
                batchControl={batchControlRef.current}
                batchRunStatus={batchRunStatus}
                generateFailCount={batchFailCount}
              />
            ) : null}

            <Collapse
              size="small"
              style={{ marginTop: 4 }}
              activeKey={showAdvancedSource || isApiKind ? ["advanced"] : []}
              onChange={(keys) => {
                const open = (Array.isArray(keys) ? keys : [keys]).includes("advanced");
                setShowAdvancedSource(open);
              }}
              items={[
                {
                  key: "advanced",
                  label: "Nâng cao · chọn file thủ công / paste / scope",
                  children: (
                    <Space orientation="vertical" size={14} style={{ width: "100%" }}>
                      <UnitScopePanel
                        packet={contextPacket}
                        loading={scopeLoading}
                        onRefresh={() => {
                          setManualSourcePick(false);
                          manualSourcePickRef.current = false;
                          void resolveScope();
                        }}
                        autoScopeEnabled={Boolean(localPath && isTauri())}
                        onPickCandidate={(pathRel) => void pickSource(pathRel)}
                        onAddRelated={(pathRel) => addRelatedSource(pathRel)}
                        broadLocal={broadLocalContext}
                      />
                      <Checkbox
                        checked={useAiScope}
                        onChange={(e) => setUseAiScope(e.target.checked)}
                        disabled={!localPath || !isTauri() || aiReady === false}
                      >
                        AI xếp hạng file theo TC (không upload source).
                      </Checkbox>
                      <Checkbox
                        checked={broadLocalContext}
                        onChange={(e) => setBroadLocalContext(e.target.checked)}
                        disabled={!localPath || !isTauri()}
                      >
                        Đọc rộng scope theo module · gen vào{" "}
                        <Typography.Text code>
                          AItest/
                          {isApiKind ? GENERATED_TEST_FOLDERS.api : GENERATED_TEST_FOLDERS.unit}
                          /{"{Requirement}/{TC title}/"}
                        </Typography.Text>
                      </Checkbox>

                      {isTauri() && localPath ? (
                        <div>
                          <Typography.Text strong>File mã nguồn (fallback)</Typography.Text>
                          <Select
                            mode="multiple"
                            style={{ width: "100%", marginTop: 6 }}
                            placeholder={
                              sourceFiles.length
                                ? "— chọn 1+ file (file đầu = chính) —"
                                : "Không tìm thấy file (đổi language / sync)"
                            }
                            value={selectedSourcePaths}
                            onChange={(v) => {
                              setManualSourcePick(true);
                              manualSourcePickRef.current = true;
                              setContextSource("local-fs");
                              void pickSources(v);
                            }}
                            options={sourceFiles.map((f) => ({
                              value: f,
                              label: displayRel(localPath, f),
                            }))}
                            showSearch
                            optionFilterProp="label"
                            allowClear
                            maxTagCount="responsive"
                          />
                        </div>
                      ) : null}

                      <div>
                        <Typography.Text strong>Preview / paste mã nguồn</Typography.Text>
                        <Input.TextArea
                          style={{ marginTop: 6 }}
                          rows={8}
                          value={sourceCode}
                          onChange={(e) => {
                            setManualSourcePick(true);
                            setSourceCode(e.target.value);
                          }}
                          placeholder="Paste mã nguồn hoặc preview từ scope Local FS."
                        />
                      </div>
                    </Space>
                  ),
                },
              ]}
            />
          </Space>
        )}
      </Card>

      {/* Staging + Verify/Apply — cùng UI Requirement (batch) cho cả Theo Test Case. */}
      {batchJobs.length > 0 || batchResults.length > 0 ? (
        <>
          <BatchStagingPreview
            jobs={
              batchJobs.length > 0
                ? batchJobs
                : batchResults.map((row) => ({
                    row,
                    manifest: null,
                    previews: [],
                  }))
            }
            selectedJobKey={batchJobKey}
            selectedTargetRel={batchFileRel}
            projectRoot={localPath}
            onSelectJob={(key) => {
              setBatchJobKey(key);
              const job = batchJobs.find((j) => j.row.key === key);
              setBatchFileRel(job?.previews[0]?.entry.targetRel ?? null);
            }}
            onSelectFile={setBatchFileRel}
            onFilesChanged={() => {
              void refreshBatchStaging(batchResults, batchFileRel);
            }}
          />
          {localPath && batchResults.some((r) => r.workspaceRunId) ? (
            <BatchRunConsole
              variant="verifyApply"
              title="3. Execute & Apply"
              rows={batchResults}
              onRowsChange={(rows) => {
                setBatchResults(rows);
                void refreshBatchStaging(rows);
              }}
              projectRoot={localPath}
              language={language}
              framework={framework}
              meta={meta ?? undefined}
              stackInspect={result?.stackInspect}
              busy={busy}
              onBusy={setBusy}
              batchControl={batchControlRef.current}
              batchRunStatus={batchRunStatus}
              generateFailCount={batchFailCount}
              onRetryGenerateFails={
                inputMode === "requirement" ? () => void runRequirementBatch(true) : undefined
              }
              onDiscarded={() => {
                setBatchJobs([]);
                setBatchResults([]);
                setWsManifest(null);
                setWsPreviews([]);
                setResult(null);
              }}
            />
          ) : null}
        </>
      ) : null}
        </>
      ) : null}
    </div>
  );
}
