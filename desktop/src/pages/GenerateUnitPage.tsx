import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
  Tag,
  Typography,
} from "antd";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { generateTcUrl } from "../lib/testingJourney";
import { ROUTES, requirementUrl, activityUrl } from "../lib/productRoutes";
import {
  CodeOutlined,
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { audit, connection, generateApiTest, generateUnit, projects, requirementStudio, requirements, testcases } from "../api";
import type {
  Connection,
  Project,
  RequirementStudioWorkspace,
  TestCase,
  UnitResult,
} from "../api/types";
import {
  metaSyncedAt,
  normalizeProjectMeta,
} from "../lib/projectSync";
import {
  languageFromSourcePath,
  sourceExtensionsForLanguage,
  suggestApiTestPath,
  suggestUnitTestPath,
  testFrameworkOptions,
} from "../lib/stackHints";
import { discoverOpenApiSpec } from "../lib/openapiDiscovery";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import { isTauri } from "../tauri/bridge";
import { syncWorkspaceRun } from "../lib/unitWorkspace/auditSync";
import {
  createUnitWorkspaceRun,
  addArtifactToWorkspace,
  loadWorkspacePreviews,
  loadManifest,
} from "../lib/unitWorkspace/manager";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../lib/unitWorkspace/types";
import { UnitWorkspacePreview } from "../components/UnitWorkspacePreview";
import { UnitWorkspaceVerifyPanel } from "../components/UnitWorkspaceVerifyPanel";
import { VERIFY_APPLY_CONSOLE_ID } from "../features/unit-test/VerifyApplyConsole";
import { BatchRunConsole, type BatchPipelineRow } from "../features/unit-test/BatchRunConsole";
import {
  BatchStagingPreview,
  type BatchStagingJob,
} from "../features/unit-test/BatchStagingPreview";
import { UnitScopePanel } from "../components/UnitScopePanel";
import { ReadyStrip } from "../components/ReadyStrip";
import { testRunnerAllowsGenerate } from "../components/EnsureTestRunnerPanel";
import type { TestFrameworkResolution } from "../lib/testRunnerEnsure";
import type { AITestContextPacket } from "../lib/contextPacket/types";
import type { UnitContextPacket } from "../lib/projectIntelligence/types";
import { GENERATED_TEST_FOLDERS } from "../lib/testOutputLayout";
import {
  createBatchRunControl,
  type BatchRunStatus,
} from "../lib/batchRunControl";
import {
  buildGenerateContext,
  buildIdeLocalGenerateBody,
  ideListSourceFiles,
  ideReadFile,
  type IdeLocalGenerateBody,
} from "../lib/ideLocalCommands";
import { resolvePackagePrefix } from "../lib/resolvePackagePrefix";
import { labelContextSource, recordUnitJobMetric } from "../lib/unitJobMetrics";
import {
  ensureWorkspaceOpen,
  getActiveWorkspaceId,
  listWorkspaceSourceFiles,
  readWorkspaceFiles,
  resolveWorkspaceScope,
} from "../lib/workspaceManager";

function displayRel(localPath: string | null, absOrRel: string): string {
  if (!localPath) return absOrRel;
  const root = localPath.replace(/\\/g, "/").replace(/\/$/, "");
  const n = absOrRel.replace(/\\/g, "/");
  if (n.toLowerCase().startsWith(`${root.toLowerCase()}/`)) {
    return n.slice(root.length + 1);
  }
  return absOrRel.replace(/^[\\/]+/, "");
}

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

function guessClassFromCode(code: string, fileName: string): string {
  const m = code.match(
    /^\s*(?:public\s+|export\s+)?(?:class|interface|struct|type|def|fn|func)\s+(\w+)/m
  );
  if (m?.[1]) return m[1];
  const base = (fileName.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "");
  return base || "Target";
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
  const [broadLocalContext, setBroadLocalContext] = useState(true);
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

  useEffect(() => {
    return batchControlRef.current.subscribe(setBatchRunStatus);
  }, []);

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
   */
  const language =
    languageFromSourcePath(sourceFile) ||
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
      const [allTcPage, studioRes, legacyRes, p, c] = await Promise.all([
        testcases.list({ projectId: project.id }, 1, 500),
        requirementStudio.listWorkspaces(project.id).catch(() => ({ items: [] as RequirementStudioWorkspace[] })),
        requirements.list(project.id, 1, 200).catch(() => ({ items: [] })),
        projects.get(project.id),
        connection.get(project.id).catch(() => null),
      ]);
      setAllTestCases(allTcPage.items);
      const appList = allTcPage.items.filter((t) => t.reviewStatus === "Approved");
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
        if (prev && allTcPage.items.some((t) => t.sourceId === prev || t.requirementSnapshotId === prev)) {
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
    return suggestUnitTestPath({
      language,
      framework: framework === "auto" ? "" : framework,
      sourceFileName: sourceFile ? displayRel(localPath, sourceFile) : undefined,
      className,
      module: selectedTc?.module || undefined,
    });
  }, [sourceCode, sourceFile, language, framework, localPath, selectedTc?.module]);

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
        const ranked = await resolveWorkspaceScope(
          wsId,
          selectedTc.id,
          useAiScope && aiReady !== false
        );
        primary = ranked.primary;
        related = ranked.related ?? [];
        reason = ranked.reason || 'BE workspace resolve';
      }

      const paths = [primary, ...related].filter(Boolean) as string[];
      const reads = await readWorkspaceFiles(wsId, paths);
      const byPath = new Map(reads.map((r) => [r.path.replace(/\\/g, '/'), r]));
      const primaryRel = (primary || '').replace(/\\/g, '/');
      const primaryContent = byPath.get(primaryRel)?.content || '';

      const relatedView = related.map((p) => {
        const rel = p.replace(/\\/g, '/');
        return {
          pathRel: rel,
          content: byPath.get(rel)?.content || '',
          role: 'dependency' as const,
        };
      });

      const view: UnitContextPacket = {
        primaryPath: primaryRel,
        primaryContent,
        related: [
          { pathRel: primaryRel, content: primaryContent, role: 'primary' },
          ...relatedView,
        ],
        seed: primaryRel ? { pathRel: primaryRel, score: 100, reason } : null,
        candidates: paths.map((p) => ({
          pathRel: p.replace(/\\/g, '/'),
          score: 50,
          reason,
        })),
        mentionedPaths: [],
        truncated: [],
      };
      setContextPacket(view);
      setUnitPacketV1(null);

      if (!manualSourcePickRef.current && primaryRel) {
        const primaryMatch = matchSourceFile(primaryRel) ?? primaryRel;
        setSourceFile(primaryMatch);
        sourceFileRef.current = primaryMatch;
        if (primaryContent) setSourceCode(primaryContent);
        const relatedMatches = related
          .map((r) => matchSourceFile(r) ?? r)
          .filter((p): p is string => Boolean(p) && p !== primaryMatch);
        setRelatedSourceFiles(relatedMatches);
        relatedSourceFilesRef.current = relatedMatches;
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : 'Quét scope thất bại');
    } finally {
      setScopeLoading(false);
    }
  }, [localPath, selectedTc, message, project?.id, useAiScope, aiReady, matchSourceFile]);

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

  async function runForTestCase(tc: TestCase) {
    if (!project || !localPath || !isTauri()) {
      throw new Error(
        isApiKind
          ? "Cần Desktop + thư mục local để sinh API test theo module."
          : "Cần Desktop + thư mục local để sinh unit theo module."
      );
    }
    setManualSourcePick(false);
    manualSourcePickRef.current = false;
    setTestCaseId(tc.id);

    const wsId = await ensureWorkspaceOpen(project.id, localPath);
    const ranked = await resolveWorkspaceScope(
      wsId,
      tc.id,
      useAiScope && aiReady !== false
    );
    const primaryRel = (ranked.primary || "").replace(/\\/g, "/");
    const relatedRels = (ranked.related || []).map((p) => p.replace(/\\/g, "/"));
    if (!primaryRel && !(isApiKind && openApiSpec.trim())) {
      throw new Error(
        isApiKind
          ? `Không tìm handler/OpenAPI cho «${tc.title}». Thêm openapi.yaml hoặc chọn file thủ công.`
          : `Không tìm được mã nguồn cho «${tc.title}». Chọn file thủ công ở chế độ từng TC.`
      );
    }
    const relName = primaryRel || (isApiKind ? "openapi.yaml" : "snippet.txt");
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
      manualPrimaryPath: primaryRel || null,
      forcedRelatedPaths: relatedRels,
      broadLocalContext,
      codeAliases: (serverProject?.meta as { codeAliases?: Record<string, string[]> } | null)
        ?.codeAliases,
    });
    setContextPacket(ctx.view);
    setUnitPacketV1(ctx.packet);
    const classHint =
      guessClassFromCode(ctx.primaryContent, relName) ||
      ctx.packet.sourceUnderTest?.symbol ||
      "";
    const packagePrefix = await resolvePackagePrefix(localPath, relName);
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
      openApiSpec: isApiKind ? openApiSpec || undefined : undefined,
      workspaceId: wsId,
      projectRoot: localPath,
    });
    const res = isApiKind
      ? await generateApiTest.run(genBody)
      : await generateUnit.run(genBody);

    const view = ctx.view;
    const primaryContent = ctx.primaryContent;

    const feHint = isApiKind
      ? suggestApiTestPath({
          language,
          framework: framework === "auto" ? "" : framework,
          className: classHint,
          sourceFileName: relName,
          module: tc.module || undefined,
          packagePrefix,
        })
      : suggestUnitTestPath({
          language,
          framework: framework === "auto" ? "" : framework,
          sourceFileName: relName,
          className: classHint,
          module: tc.module || undefined,
          packagePrefix,
        });
    const targetPath = (res.suggestedPath || feHint.relativePath).trim();

    let manifest = await createUnitWorkspaceRun({
      projectRoot: localPath,
      projectId: project.id,
      testCaseId: tc.id,
      provider: res.provider,
      sourceFileName: relName,
      artifactKind: isApiKind ? "api" : "unit",
      packagePrefix,
      packageName: res.stackInspect?.package_name,
    });
    const added = await addArtifactToWorkspace({
      projectRoot: localPath,
      manifest,
      targetRel: targetPath,
      content: res.code,
    });
    manifest = added.manifest;
        syncWorkspaceRun(manifest, { module: tc.module, status: "generated" });
    recordUnitJobMetric({
      projectId: project.id,
      contextSource: "local-fs",
      runnerUsed: res.runnerUsed,
      ideConnected: false,
    });
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
    return { runId: manifest.runId, packagePrefix: manifest.packagePrefix };
  }

  function focusVerifyConsole() {
    setSuggestVerify(true);
    window.setTimeout(() => {
      document
        .getElementById(VERIFY_APPLY_CONSOLE_ID)
        ?.scrollIntoView({ behavior: "smooth", block: "start" });
    }, 120);
  }

  async function refreshBatchStaging(rows: BatchRow[]) {
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
          error: "Đang chờ…",
        });
      }
    }

    setBusy(true);
    const control = batchControlRef.current;
    control.start();
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
      for (let i = 0; i < workList.length; i++) {
        await control.waitIfPaused();
        const tc = workList[i];
        setBatchProgress({ current: i + 1, total: workList.length, label: tc.title });
        try {
          const out = await runForTestCase(tc);
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "ok",
            workspaceRunId: out?.runId,
            packagePrefix: out?.packagePrefix,
            verifyStatus: "pending",
            applyStatus: "pending",
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
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "fail",
            error: errMsg,
          });
          if (campaignId) {
            void audit.addCampaignTasks(campaignId, [
              { testCaseId: tc.id, status: "fail", error: errMsg, sortOrder: i },
            ]);
          }
        }
        setBatchResults([...rowMap.values()]);
        void refreshBatchStaging([...rowMap.values()]);
      }
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
          error: "Đang chờ…",
        });
      }
    }

    setModuleKey(activeModule);
    setBusy(true);
    const control = batchControlRef.current;
    control.start();
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
      for (let i = 0; i < workList.length; i++) {
        await control.waitIfPaused();
        const tc = workList[i];
        setBatchProgress({ current: i + 1, total: workList.length, label: tc.title });
        try {
          const out = await runForTestCase(tc);
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "ok",
            workspaceRunId: out?.runId,
            packagePrefix: out?.packagePrefix,
            verifyStatus: "pending",
            applyStatus: "pending",
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
          rowMap.set(tc.id, {
            key: tc.id,
            testCaseId: tc.testCaseId,
            title: tc.title,
            status: "fail",
            error: errMsg,
          });
          if (campaignId) {
            void audit.addCampaignTasks(campaignId, [
              { testCaseId: tc.id, status: "fail", error: errMsg, sortOrder: i },
            ]);
          }
        }
        setBatchResults([...rowMap.values()]);
        void refreshBatchStaging([...rowMap.values()]);
      }
      const finalRows = [...rowMap.values()];
      setBatchResults(finalRows);
      const failN = finalRows.filter((r) => r.status === "fail").length;
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

  /** Happy path: Local FS + AI CLI only. */
  async function runUnitJob() {
    try {
      await run();
    } finally {
      /* done */
    }
  }

  async function run() {
    const hasFileScope = Boolean(
      sourceFile ||
        contextPacket?.primaryPath ||
        (isApiKind && openApiSpec.trim())
    );
    const hasPastedOnly =
      Boolean(sourceCode.trim()) && !sourceFile && !contextPacket?.primaryPath;
    if (
      !project ||
      !testCaseId ||
      (!hasFileScope && !hasPastedOnly && !(isApiKind && openApiSpec.trim()))
    ) {
      message.error(
        isApiKind
          ? "Cần TC Approved và OpenAPI hoặc chọn file handler."
          : "Cần TC Approved + project root (Local FS) hoặc chọn/dán mã nguồn."
      );
      return;
    }
    if (!aiReady) {
      message.error("AI chưa Ready — vào Cấu hình AI để Verify trước.");
      return;
    }
    if (!localPath || !isTauri()) {
      message.warning("Cần gắn project root trên trang này trước khi sinh → Bản nháp test.");
      return;
    }
    setBusy(true);
    try {
      const wsId = await ensureWorkspaceOpen(project.id, localPath);
      const tc = selectedTc;
      if (!tc) {
        message.error("Không tìm thấy test case đã duyệt.");
        return;
      }

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
          };

      let genBody: GenBody | null = null;
      let classHint = "";
      let outName = "";
      let usedLanguage = language;
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
            ...(isApiKind ? { openApiSpec: openApiSpec || undefined } : {}),
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
            openApiSpec: isApiKind ? openApiSpec || undefined : undefined,
            workspaceId: wsId,
            projectRoot: localPath,
          });
        }
      }

      if (!genBody) {
        message.error("Không tạo được payload sinh test.");
        return;
      }

      const prepared = genBody;
      const packagePrefix = await resolvePackagePrefix(localPath, outName);
      const body = { ...prepared, packagePrefix };

      const res = isApiKind
        ? await generateApiTest.run(body)
        : await generateUnit.run(body);
      setResult(res);
      const feHint = isApiKind
        ? suggestApiTestPath({
            language: usedLanguage,
            framework: framework === "auto" ? "" : framework,
            className: classHint,
            sourceFileName: outName,
            module: selectedTc?.module || undefined,
            packagePrefix,
          })
        : suggestUnitTestPath({
            language: usedLanguage,
            framework: framework === "auto" ? "" : framework,
            sourceFileName: outName,
            className: classHint,
            module: selectedTc?.module || undefined,
            packagePrefix,
          });
      setWritePath(res.suggestedPath || feHint.relativePath);
      const targetPath = (res.suggestedPath || feHint.relativePath).trim();
      if (localPath && isTauri() && targetPath) {
        let manifest = await createUnitWorkspaceRun({
          projectRoot: localPath,
          projectId: project.id,
          testCaseId,
          provider: res.provider,
          sourceFileName: outName,
          artifactKind: isApiKind ? "api" : "unit",
          packagePrefix,
          packageName: res.stackInspect?.package_name,
        });
        const added = await addArtifactToWorkspace({
          projectRoot: localPath,
          manifest,
          targetRel: targetPath,
          content: res.code,
        });
        manifest = added.manifest;
        syncWorkspaceRun(manifest, {
          status: "generated",
          contextSource: usedSource,
        });
        recordUnitJobMetric({
          projectId: project.id,
          contextSource: usedSource,
          runnerUsed: res.runnerUsed,
          ideConnected: false,
        });
        const previews = await loadWorkspacePreviews(localPath, manifest);
        setWsManifest(manifest);
        setWsPreviews(previews);
        setWsSelectedRel(added.entry.targetRel);
        message.success(
          isApiKind
            ? `Đã sinh API test · Bản nháp (${added.entry.op})`
            : `Unit Job OK${
                res.runnerUsed === "AI_CLI" ? " · AI CLI" : ""
              } · ${labelContextSource(usedSource)} · ${manifest.runId.slice(0, 8)}…`
        );
        focusVerifyConsole();
      } else {
        setWsManifest(null);
        setWsPreviews([]);
        setWsSelectedRel(null);
        message.success(
          `Đã sinh ${isApiKind ? "API" : "unit"} test bằng ${res.provider}${
            res.runnerUsed === "AI_CLI" ? " · AI CLI" : ""
          } (chưa lưu bản nháp — cần Desktop + project root)`
        );
      }
    } catch (e) {
      message.error(
        e instanceof Error ? e.message : isApiKind ? "Sinh API test thất bại" : "Sinh unit thất bại"
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
    const repairContext = [
      `Agent Staging run: ${current.runId}`,
      `Target file: ${selected.entry.targetRel}`,
      `Sandbox Auto-Repair (Step 3)`,
      ...(failedStages.length
        ? failedStages.map(
            (s) =>
              `[${s.stage}] command=${s.command} exit=${s.exitCode}\n${(s.logExcerpt || "").slice(-2500)}`
          )
        : ["Verify failed (no stage logs)."]),
    ].join("\n\n");

    setRepairing(true);
    try {
      const repairBody = {
        projectId: project.id,
        testCaseId,
        sourceFileName: current.sourceFileName || selected.entry.targetRel,
        sourceCode: selected.content,
        framework: framework === "auto" ? "" : framework || "",
        language: language ?? undefined,
        className: guessClassFromCode(selected.content, selected.entry.targetRel),
        module: selectedTc?.module || undefined,
        packagePrefix: current.packagePrefix,
        projectRoot: localPath,
        relatedSources:
          contextPacket?.related
            .filter((r) => r.role === "dependency")
            .map((r) => ({ path: r.pathRel, content: r.content, role: r.role })) ?? [],
        contextPacket: unitPacketV1 ?? undefined,
        repairContext,
        ...(isApiKind ? { openApiSpec: openApiSpec || undefined } : {}),
      };
      const res = isApiKind
        ? await generateApiTest.run(repairBody)
        : await generateUnit.run(repairBody);

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
    if (wsManifest && (wsManifest.status === "pass" || wsManifest.status === "applied")) return 2;
    if (result || wsManifest) return 1;
    return 0;
  }, [wsManifest, result]);

  const batchFailCount = batchResults.filter((r) => r.status === "fail" && r.error !== "Đang chờ…").length;
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
          aiProvider={conn?.provider}
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
          onSourceRootBound={onSourceRootBound}
          onSourceRootSynced={onSourceRootSynced}
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

        {noApproved ? (
          <Card style={{ textAlign: "center", padding: "48px 24px" }}>
            <Typography.Title level={4} style={{ marginTop: 0 }}>
              Chưa có test case Approved
            </Typography.Title>
            <Typography.Paragraph type="secondary" style={{ maxWidth: 420, margin: "0 auto 20px" }}>
              Sinh Unit cần ít nhất một TC đã duyệt. Hoàn tất pha Design trước, rồi gắn project
              root trên trang này.
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
        style={{ marginTop: 16, marginBottom: 8, maxWidth: 640 }}
        items={[
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
                  const linkedTc = allTestCases.filter((t) => tcBelongsToReq(t, r));
                  const appCount = linkedTc.filter((t) => t.reviewStatus === "Approved").length;
                  const total = r.tcTotal ?? linkedTc.length;
                  const approvedN = r.tcApproved ?? appCount;
                  return {
                    value: r.id,
                    label: `📄 ${r.title} (${total} TC · ${approvedN} Approved)`,
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
                      Tự động sinh mã + bản nháp cho tất cả <strong>{filteredTestCases.length} Test Cases</strong> thuộc Yêu cầu này
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
                  ? `Tạm dừng · đã ${batchProgress.current}/${batchProgress.total} · chờ tiếp tục`
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
                  (busy && batchRunStatus === "running")
                }
              >
                ⚡ Chạy Unit Job · Tất cả TC trong Requirement ({filteredTestCases.length} TC)
              </Button>
              {batchRunStatus === "running" ? (
                <Button
                  icon={<PauseCircleOutlined />}
                  onClick={() => batchControlRef.current.pause()}
                >
                  Tạm dừng
                </Button>
              ) : null}
              {batchRunStatus === "paused" ? (
                <Button
                  type="primary"
                  icon={<PlayCircleOutlined />}
                  onClick={() => batchControlRef.current.resume()}
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
                    const linkedTc = allTestCases.filter((t) => tcBelongsToReq(t, r));
                    const appCount = linkedTc.filter((t) => t.reviewStatus === "Approved").length;
                    const total = r.tcTotal ?? linkedTc.length;
                    const approvedN = r.tcApproved ?? appCount;
                    return {
                      value: r.id,
                      label: `📄 ${r.title} (${total} TC · ${approvedN} Approved)`,
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
                !(
                  Boolean(contextPacket?.primaryPath) ||
                  Boolean(sourceFile) ||
                  Boolean(sourceCode.trim()) ||
                  (isApiKind && Boolean(openApiSpec.trim()))
                )
              }
            >
              Chạy Unit Job
            </Button>

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
                          /{"{Module}/"}
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

      {result ? (
        <Card
          title={
            <Space wrap>
              <CodeOutlined />
              Kết quả · {result.fileName}
              {result.runnerUsed === "AI_CLI" ? <Tag color="blue">AI CLI</Tag> : null}
              {result.stackInspect?.package_name ? (
                <Tag>
                  {result.stackInspect.is_monorepo_package
                    ? `mono:${result.stackInspect.workspace_kind || "pkg"}`
                    : "pkg"}
                  {" · "}
                  {result.stackInspect.package_name}
                </Tag>
              ) : null}
              {result.stackInspect?.language ? (
                <Tag>
                  {result.stackInspect.language}/{result.stackInspect.framework}
                </Tag>
              ) : null}
            </Space>
          }
          style={{ marginTop: 8 }}
          extra={
            <Space>
              <Link to={activityUrl({ tab: "unit-jobs", runId: wsManifest?.runId })}>
                <Button size="small" type="link">
                  Job Board
                </Button>
              </Link>
              <Typography.Text type="secondary">provider: {result.provider}</Typography.Text>
            </Space>
          }
        >
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <div>
              <Typography.Text strong>Đường dẫn trong repo (khi Apply)</Typography.Text>
              <Input
                style={{ marginTop: 6 }}
                value={writePath}
                onChange={(e) => setWritePath(e.target.value)}
                onBlur={() => void updateWorkspacePath()}
                prefix={<FolderOpenOutlined />}
                placeholder="vd. tests/test_foo.py · src/foo.test.ts · Tests/FooTests.cs"
              />
              <Typography.Paragraph type="secondary" style={{ marginTop: 6, marginBottom: 0 }}>
                Gợi ý Backend: <code>{result.suggestedPath}</code>
                {wsManifest ? " · Sửa path rồi blur ô input để cập nhật bản nháp." : null}
              </Typography.Paragraph>
            </div>
          </Space>
        </Card>
      ) : null}

      {batchJobs.length > 0 || (batchResults.length > 0 && inputMode === "requirement") ? (
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
            onSelectJob={(key) => {
              setBatchJobKey(key);
              const job = batchJobs.find((j) => j.row.key === key);
              setBatchFileRel(job?.previews[0]?.entry.targetRel ?? null);
            }}
            onSelectFile={setBatchFileRel}
          />
          {localPath && batchResults.some((r) => r.workspaceRunId) ? (
            <BatchRunConsole
              variant="verifyApply"
              title="3. Verify & Apply"
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
              onRetryGenerateFails={() => void runRequirementBatch(true)}
              onDiscarded={() => {
                setBatchJobs([]);
                setBatchResults([]);
                setWsManifest(null);
                setWsPreviews([]);
              }}
            />
          ) : null}
        </>
      ) : null}

      {batchResults.length === 0 && wsManifest && wsPreviews.length > 0 ? (
        <>
          <UnitWorkspacePreview
            manifest={wsManifest}
            previews={wsPreviews}
            selectedTargetRel={wsSelectedRel}
            onSelect={setWsSelectedRel}
            projectRoot={localPath}
          />
          {localPath ? (
            <UnitWorkspaceVerifyPanel
              manifest={wsManifest}
              projectRoot={localPath}
              language={language}
              framework={framework}
              meta={meta ?? undefined}
              stackInspect={result?.stackInspect}
              busy={busy}
              repairing={repairing}
              suggestVerify={suggestVerify}
              onBusy={setBusy}
              onRepair={async () => {
                const next = await repairWorkspaceWithAi();
                if (next) message.success("AI đã sửa file trong bản nháp. Hãy chạy Verify lại.");
              }}
              onRepairAsync={async (m) => {
                const next = await repairWorkspaceWithAi(m);
                if (!next) throw new Error("Repair không trả về manifest");
                return next;
              }}
              onManifestChange={(m) => {
                setSuggestVerify(false);
                if (m.status === "discarded") {
                  setWsManifest(null);
                  setWsPreviews([]);
                  return;
                }
                setWsManifest(m);
                if (m.status === "applied") {
                  message.success("Đã Apply vào source code — về Requirement.");
                  navigate(ROUTES.requirement);
                } else if (m.status === "pass") {
                  message.success("Verify PASS — có thể Apply.");
                } else if (m.status === "fail") {
                  message.warning(
                    "Verify FAIL — bấm Repair with AI hoặc Verify + Auto-Repair."
                  );
                }
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
