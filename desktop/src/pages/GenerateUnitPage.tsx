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
  Table,
  Tag,
  Typography,
} from "antd";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { generateTcUrl } from "../lib/testingJourney";
import { ROUTES, requirementUrl } from "../lib/productRoutes";
import {
  CodeOutlined,
  FolderOpenOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { audit, connection, generateApiTest, generateUnit, agentApi, projects, testcases } from "../api";
import type { Connection, Project, TestCase, UnitResult } from "../api/types";
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
} from "../lib/unitWorkspace/manager";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../lib/unitWorkspace/types";
import { UnitWorkspacePreview } from "../components/UnitWorkspacePreview";
import { UnitWorkspaceVerifyPanel } from "../components/UnitWorkspaceVerifyPanel";
import { UnitScopePanel } from "../components/UnitScopePanel";
import { ReadyStrip } from "../components/ReadyStrip";
import { testRunnerAllowsGenerate } from "../components/EnsureTestRunnerPanel";
import { AgentRunPanel } from "../components/AgentRunPanel";
import { RootIdeMismatchBanner } from "../components/RootIdeMismatchBanner";
import type { TestFrameworkResolution } from "../lib/testRunnerEnsure";
import {
  analyzeBusinessIntentLocal,
  buildPacketFromAgentRun,
  buildRound0Retrieval,
  retrieveViaIdeCommands,
  useAgentRunSession,
} from "../lib/agentRun";
import type { BusinessIntent } from "@aitest/ide-protocol";
import type { AITestContextPacket } from "../lib/contextPacket/types";
import type { UnitContextPacket } from "../lib/projectIntelligence/types";
import { toUnitContextView } from "../lib/projectIntelligence/contextBuilder";
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
import {
  contextPacketFromIdeSemantic,
  fetchIdeSemanticOrNull,
  ideFocusReadyForGenerate,
  rootsMismatch,
  useIdeBridgeSession,
} from "../lib/ideBridge";
import { getIdeRpcClientOrNull } from "../lib/ideBridge/session";
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

function guessClassFromCode(code: string, fileName: string): string {
  const m = code.match(
    /^\s*(?:public\s+|export\s+)?(?:class|interface|struct|type|def|fn|func)\s+(\w+)/m
  );
  if (m?.[1]) return m[1];
  const base = (fileName.split(/[\\/]/).pop() || "").replace(/\.[^.]+$/, "");
  return base || "Target";
}

type BatchRow = {
  key: string;
  testCaseId: string;
  title: string;
  status: "ok" | "fail";
  error?: string;
  workspaceRunId?: string;
};

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
  /** P2: hiện file combobox (fallback) — ẩn khi IDE focus sẵn sàng */
  const [showAdvancedSource, setShowAdvancedSource] = useState(false);
  const [, setContextSource] = useState<"ide" | "local-fs" | "agent-ide">("local-fs");
  const [testFwResolution, setTestFwResolution] = useState<TestFrameworkResolution | null>(
    null
  );
  const [skipTestFwInstall, setSkipTestFwInstall] = useState(false);
  const agentPhase = useAgentRunSession((s) => s.phase);
  const agentIntent = useAgentRunSession((s) => s.intent);
  const agentRetrieved = useAgentRunSession((s) => s.retrieved);
  const agentConfidence = useAgentRunSession((s) => s.confidence);
  const agentError = useAgentRunSession((s) => s.error);
  const agentOverride = useAgentRunSession((s) => s.override);
  const agentPacket = useAgentRunSession((s) => s.packet);
  const agentPrimaryPath = useAgentRunSession((s) => s.primaryPath);
  const agentFw = useAgentRunSession((s) => s.framework);
  const agentLang = useAgentRunSession((s) => s.language);
  const agentSetAnalyzing = useAgentRunSession((s) => s.setAnalyzing);
  const agentSetIntent = useAgentRunSession((s) => s.setIntent);
  const agentSetRetrieving = useAgentRunSession((s) => s.setRetrieving);
  const agentSetRetrieved = useAgentRunSession((s) => s.setRetrieved);
  const agentSetPacket = useAgentRunSession((s) => s.setPacket);
  const agentSetPhase = useAgentRunSession((s) => s.setPhase);
  const agentSetError = useAgentRunSession((s) => s.setError);
  const agentSetOverride = useAgentRunSession((s) => s.setOverride);
  const agentClear = useAgentRunSession((s) => s.clear);
  const [repairing, setRepairing] = useState(false);
  const [inputMode, setInputMode] = useState<"single" | "module">("single");
  const [moduleKey, setModuleKey] = useState<string | undefined>();
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const [batchResults, setBatchResults] = useState<BatchRow[]>([]);
  const [openApiSpec, setOpenApiSpec] = useState("");
  /** Bump after bind/sync so localPath re-reads from workspace store */
  const [sourceRootTick, setSourceRootTick] = useState(0);
  const [batchRunStatus, setBatchRunStatus] = useState<BatchRunStatus>("idle");
  const batchControlRef = useRef(createBatchRunControl());

  useEffect(() => {
    return batchControlRef.current.subscribe(setBatchRunStatus);
  }, []);

  useEffect(() => {
    const mode = searchParams.get("mode");
    const mod = searchParams.get("module");
    const tc = searchParams.get("testCaseId");
    if (mode === "gaps") {
      setInputMode("module");
    } else if (mode === "module" && mod) {
      setInputMode("module");
      setModuleKey(decodeURIComponent(mod));
    } else if (mode === "single" && tc) {
      setInputMode("single");
      setTestCaseId(tc);
    }
  }, [searchParams]);

  const [gapsPrompted, setGapsPrompted] = useState(false);

  const moduleGroups = useMemo(() => {
    const map = new Map<string, TestCase[]>();
    for (const t of approved) {
      const key = (t.module || "").trim() || "(Chưa gán module)";
      const arr = map.get(key) ?? [];
      arr.push(t);
      map.set(key, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "vi"));
  }, [approved]);

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
  const ideStatus = useIdeBridgeSession((s) => s.status);
  const ideFocus = useIdeBridgeSession((s) => s.focus);
  const ideConfidence = useIdeBridgeSession((s) => s.confidence);
  const ideLanguage = useIdeBridgeSession((s) => s.language);
  const ideWorkspaceRoot = useIdeBridgeSession((s) => s.workspaceRoot);
  const clearIdeFocus = useIdeBridgeSession((s) => s.clearFocus);
  const ideReady = ideStatus === "connected" && ideFocusReadyForGenerate(ideConfidence, Boolean(ideFocus));
  const ideRootMismatch = rootsMismatch(localPath, ideWorkspaceRoot);

  // Đổi project AITest → xóa caret boost / source dính từ IDE project cũ
  useEffect(() => {
    clearIdeFocus();
    setManualSourcePick(false);
    manualSourcePickRef.current = false;
    setSourceFile(undefined);
    sourceFileRef.current = undefined;
    setRelatedSourceFiles([]);
    relatedSourceFilesRef.current = [];
    setSourceCode("");
    setContextPacket(null);
    setUnitPacketV1(null);
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- only on project switch

  /**
   * Language theo file đang test trước (monorepo Forensic: .cs → C#, không để
   * IDE/ClientApp TS hoặc "C# + TypeScript" kéo framework sang Jest).
   */
  const language =
    languageFromSourcePath(sourceFile) ||
    languageFromSourcePath(ideFocus?.file) ||
    ideLanguage ||
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

  const onIdeFocusApplied = useCallback(
    (focus: { file: string; symbol: string; method?: string }) => {
      if (manualSourcePickRef.current) return;
      if (rootsMismatch(localPath, useIdeBridgeSession.getState().workspaceRoot)) {
        return;
      }
      const rel = focus.file.replace(/\\/g, "/");
      setContextSource("ide");
      setSourceFile(rel);
      sourceFileRef.current = rel;
      void (async () => {
        if (!localPath || !isTauri()) return;
        try {
          const code = await ideReadFile(localPath, rel);
          if (!manualSourcePickRef.current) setSourceCode(code);
        } catch {
          /* preview optional */
        }
      })();
    },
    [localPath]
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
      const [page, p, c] = await Promise.all([
        testcases.list({ projectId: project.id, reviewStatus: "Approved" }),
        projects.get(project.id),
        connection.get(project.id).catch(() => null),
      ]);
      setApproved(page.items);
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
      // IDE-local list first (Tauri); workspace list is fallback only
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
      message.error(e instanceof Error ? e.message : "Không liệt kê được file nguồn (IDE local)");
    }
  }, [project?.id, localPath, language, message]);

  useEffect(() => {
    void loadSourceFiles();
  }, [loadSourceFiles]);

  const selectedTc = useMemo(
    () => approved.find((t) => t.id === testCaseId),
    [approved, testCaseId]
  );

  const readForAgentPacket = useCallback(
    async (pathRel: string): Promise<string> => {
      if (localPath && isTauri()) {
        try {
          return await ideReadFile(localPath, pathRel);
        } catch {
          /* try IDE */
        }
      }
      const client = getIdeRpcClientOrNull();
      if (client?.isConnected) {
        const r = await client.readFile({ pathRel, maxBytes: 16_000 });
        return r.content;
      }
      throw new Error(`Không đọc được ${pathRel}`);
    },
    [localPath]
  );

  const freezeAgentPacket = useCallback(
    async (opts: {
      intent: BusinessIntent;
      retrieved: import("@aitest/ide-protocol").RetrievedFile[];
      confidence: import("@aitest/ide-protocol").ConfidenceReport;
      tc: TestCase;
    }) => {
      if (!project?.id) return;
      const semantic = await fetchIdeSemanticOrNull();
      const built = await buildPacketFromAgentRun({
        intent: opts.intent,
        retrieved: opts.retrieved,
        confidence: opts.confidence,
        testCase: opts.tc,
        projectId: project.id,
        framework: framework === "auto" ? "" : framework || "",
        readFile: readForAgentPacket,
        ideSemantic: semantic,
      });
      agentSetPacket({
        packet: built.packet,
        language: built.language,
        framework: built.framework,
        primaryPath: built.primaryPath,
      });
      setUnitPacketV1(built.packet);
      setContextPacket(toUnitContextView(built.packet));
      setContextSource("ide");
      if (built.primaryPath) {
        setSourceFile(built.primaryPath);
        sourceFileRef.current = built.primaryPath;
      }
      if (built.packet.files[0]?.content) {
        setSourceCode(built.packet.files[0].content);
      }
      if (built.framework) setFramework(built.framework);
    },
    [project?.id, framework, readForAgentPacket, agentSetPacket]
  );

  const runAgentAnalyze = useCallback(async () => {
    if (!selectedTc || !project?.id) {
      agentSetError("Chọn TC Approved trước");
      return;
    }
    if (rootsMismatch(localPath, useIdeBridgeSession.getState().workspaceRoot)) {
      agentSetError(
        "Lệch thư mục IDE · Root — dùng «Dùng folder Cursor làm Root Apply» hoặc Open Folder đúng repo, rồi Analyze lại."
      );
      return;
    }
    agentSetAnalyzing(selectedTc.id);
    agentSetOverride(false);
    let intent: BusinessIntent;
    try {
      const dto = await agentApi.analyzeIntent({
        projectId: project.id,
        testCaseId: selectedTc.id,
      });
      intent = {
        action: dto.action,
        entity: dto.entity,
        expectedResults: dto.expectedResults ?? [],
        businessRules: dto.businessRules ?? [],
        validationRules: dto.validationRules ?? [],
        externalDeps: dto.externalDeps ?? [],
        domainTerms: dto.domainTerms ?? [],
        searchHints: dto.searchHints ?? [],
      };
      if (dto.source === "heuristic" && dto.fallbackReason) {
        message.warning(`Intent dùng heuristic (LLM lỗi): ${dto.fallbackReason}`);
      }
    } catch (e) {
      intent = analyzeBusinessIntentLocal(selectedTc);
      message.warning(
        e instanceof Error
          ? `API analyze-intent lỗi — dùng heuristic local: ${e.message}`
          : "API analyze-intent lỗi — dùng heuristic local"
      );
    }
    agentSetIntent(intent);
    agentSetRetrieving();
    const round0 = buildRound0Retrieval({
      intent,
      focus: ideFocus
        ? { file: ideFocus.file, symbol: ideFocus.symbol, method: ideFocus.method }
        : null,
    });
    agentSetRetrieved(round0.retrieved, round0.confidence);

    const ide = await retrieveViaIdeCommands({
      intent,
      focus: ideFocus
        ? { file: ideFocus.file, symbol: ideFocus.symbol, method: ideFocus.method }
        : null,
    });
    const retrieved = ide.usedIde ? ide.retrieved : round0.retrieved;
    const conf = ide.usedIde ? ide.confidence : round0.confidence;
    agentSetRetrieved(retrieved, conf);
    if (ide.usedIde && ide.error) message.warning(`IDE retrieve: ${ide.error}`);

    try {
      await freezeAgentPacket({
        intent,
        retrieved,
        confidence: conf,
        tc: selectedTc,
      });
    } catch (e) {
      message.warning(
        e instanceof Error
          ? `Dựng packet thất bại: ${e.message}`
          : "Dựng packet thất bại"
      );
    }
  }, [
    selectedTc,
    ideFocus,
    project?.id,
    message,
    agentSetAnalyzing,
    agentSetOverride,
    agentSetError,
    agentSetIntent,
    agentSetRetrieving,
    agentSetRetrieved,
    freezeAgentPacket,
    localPath,
  ]);

  const runIdeRetrieveOnly = useCallback(async () => {
    if (!agentIntent || !selectedTc) {
      message.warning("Chưa có Business Intent — chọn TC trước");
      return;
    }
    if (rootsMismatch(localPath, useIdeBridgeSession.getState().workspaceRoot)) {
      message.warning(
        "Lệch thư mục IDE · Root — khớp Root với Cursor trước khi lấy context IDE."
      );
      return;
    }
    agentSetRetrieving();
    const ide = await retrieveViaIdeCommands({
      intent: agentIntent,
      focus: ideFocus
        ? { file: ideFocus.file, symbol: ideFocus.symbol, method: ideFocus.method }
        : null,
    });
    agentSetRetrieved(ide.retrieved, ide.confidence);
    if (!ide.usedIde) {
      message.warning(ide.error || "Connect IDE để searchSymbol / readFile");
    } else if (ide.error) {
      message.warning(`IDE retrieve: ${ide.error}`);
    } else {
      message.success(
        `Đã lấy ${ide.retrieved.length} file qua IDE commands (không dump workspace)`
      );
    }
    try {
      await freezeAgentPacket({
        intent: agentIntent,
        retrieved: ide.retrieved,
        confidence: ide.confidence,
        tc: selectedTc,
      });
    } catch (e) {
      message.warning(e instanceof Error ? e.message : "Dựng packet thất bại");
    }
  }, [
    agentIntent,
    ideFocus,
    message,
    selectedTc,
    agentSetRetrieving,
    agentSetRetrieved,
    freezeAgentPacket,
    localPath,
  ]);

  useEffect(() => {
    if (!selectedTc || !project?.id) {
      agentClear();
      return;
    }
    void runAgentAnalyze();
  }, [selectedTc?.id, project?.id]); // eslint-disable-line react-hooks/exhaustive-deps -- re-analyze on TC change only

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
    });
    const added = await addArtifactToWorkspace({
      projectRoot: localPath,
      manifest,
      targetRel: targetPath,
      content: res.code,
    });
    manifest = added.manifest;
    syncWorkspaceRun(manifest, { module: tc.module, status: "generated" });
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
    return { runId: manifest.runId };
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
      message.error("Sinh theo module cần Desktop + gắn Root Apply trên trang này.");
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

  async function run() {
    const hasIdeScope = ideReady && Boolean(ideFocus);
    const hasFileScope = Boolean(
      sourceFile ||
        contextPacket?.primaryPath ||
        (isApiKind && openApiSpec.trim()) ||
        hasIdeScope
    );
    const hasPastedOnly =
      Boolean(sourceCode.trim()) && !sourceFile && !contextPacket?.primaryPath && !hasIdeScope;
    if (
      !project ||
      !testCaseId ||
      (!hasFileScope && !hasPastedOnly && !(isApiKind && openApiSpec.trim()))
    ) {
      message.error(
        isApiKind
          ? "Cần TC Approved và OpenAPI hoặc chọn file handler."
          : "Cần TC Approved + Connect IDE (caret) hoặc chọn/dán mã nguồn (fallback)."
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
    if (
      !isApiKind &&
      !manualSourcePickRef.current &&
      agentPacket?.files?.length &&
      agentConfidence &&
      !agentConfidence.enough &&
      !agentOverride
    ) {
      message.warning(
        "Confidence chưa đủ — bấm «Sinh anyway (override)» hoặc «Tiếp tục lấy context»."
      );
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
      let usedSource: "ide" | "local-fs" | "agent-ide" = "local-fs";

      // P0 — Prefer frozen Agent packet (retrieve → packet → generate)
      const useAgentPacket =
        !isApiKind &&
        !manualSourcePickRef.current &&
        Boolean(agentPacket?.files?.length) &&
        (Boolean(agentConfidence?.enough) || agentOverride);

      if (useAgentPacket && agentPacket) {
        usedSource = "agent-ide";
        setContextSource("ide");
        setUnitPacketV1(agentPacket);
        setContextPacket(toUnitContextView(agentPacket));
        usedLanguage = agentLang || languageFromSourcePath(agentPrimaryPath) || language;
        outName =
          agentPrimaryPath ||
          agentPacket.sourceUnderTest?.pathRel ||
          agentPacket.files[0]?.pathRel ||
          "";
        classHint =
          agentPacket.sourceUnderTest?.symbol ||
          guessClassFromCode(agentPacket.files[0]?.content || "", outName);
        if (agentPacket.files[0]?.content) setSourceCode(agentPacket.files[0].content);
        if (outName) setSourceFile(outName);
        const fw =
          (framework && framework !== "auto" ? framework : null) ||
          agentFw ||
          agentPacket.testingStack?.testingFramework ||
          "";
        genBody = buildIdeLocalGenerateBody({
          projectId: project.id,
          testCaseId,
          packet: agentPacket,
          sourceFileName: outName,
          framework: fw,
          language: usedLanguage ?? undefined,
          className: classHint,
          module: tc.module || undefined,
          workspaceId: wsId,
          agentConfidence: agentConfidence?.overall,
          agentEnough: agentConfidence?.enough,
          agentOverride,
          contextSource: "agent-ide",
        });
      }

      const preferIde =
        !genBody &&
        !manualSourcePickRef.current &&
        ideStatus === "connected" &&
        !isApiKind &&
        ideFocusReadyForGenerate(ideConfidence, Boolean(ideFocus));

      if (preferIde) {
        const semantic = await fetchIdeSemanticOrNull();
        if (semantic) {
          const built = await contextPacketFromIdeSemantic({
            packet: semantic,
            testCase: tc,
            projectId: project.id,
            framework: framework === "auto" ? "" : framework || "",
            purpose: "generate-unit",
            testKind: "unit",
            readFile: (pathRel) => ideReadFile(localPath, pathRel),
          });
          usedSource = "ide";
          setContextSource("ide");
          setUnitPacketV1(built.packet);
          setContextPacket(toUnitContextView(built.packet));
          usedLanguage = built.language || language;
          outName = built.packet.sourceUnderTest?.pathRel || semantic.focus.file;
          classHint =
            built.packet.sourceUnderTest?.symbol ||
            guessClassFromCode(built.packet.files[0]?.content || "", outName);
          if (built.packet.files[0]?.content) setSourceCode(built.packet.files[0].content);
          setSourceFile(outName);
          const fw =
            framework && framework !== "auto" ? framework : built.framework || framework || "";
          genBody = buildIdeLocalGenerateBody({
            projectId: project.id,
            testCaseId,
            packet: built.packetForApi,
            sourceFileName: outName,
            framework: fw,
            language: usedLanguage ?? undefined,
            className: classHint,
            module: tc.module || undefined,
            workspaceId: wsId,
            contextSource: "ide-semantic",
          });
        } else {
          message.warning("IDE không trả semantic — chuyển Local FS fallback.");
        }
      }

      if (!genBody) {
        const relName = sourceFile
          ? displayRel(localPath, sourceFile)
          : contextPacket?.primaryPath ||
            ideFocus?.file ||
            ("snippet" + (language?.toLowerCase().includes("python") ? ".py" : ".txt"));
        const relatedRels = relatedSourceFiles.map((f) => displayRel(localPath, f));
        classHint = guessClassFromCode(sourceCode, relName);
        outName = relName;
        usedSource = "local-fs";
        setContextSource("local-fs");

        const pastedOnly =
          Boolean(sourceCode.trim()) && !sourceFile && !contextPacket?.primaryPath && !ideFocus;

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
              sourceFile ? relName : contextPacket?.primaryPath || ideFocus?.file || null,
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
          agentConfidence: agentConfidence?.overall,
          agentOverride,
        });
        const previews = await loadWorkspacePreviews(localPath, manifest);
        setWsManifest(manifest);
        setWsPreviews(previews);
        setWsSelectedRel(added.entry.targetRel);
        message.success(
          isApiKind
            ? `Đã sinh API test · Bản nháp (${added.entry.op})`
            : `Đã sinh unit · nguồn ${
                usedSource === "agent-ide"
                  ? "Agent IDE packet"
                  : usedSource === "ide"
                    ? "IDE semantic"
                    : "Local FS"
              } · Bản nháp (${added.entry.op})`
        );
      } else {
        setWsManifest(null);
        setWsPreviews([]);
        setWsSelectedRel(null);
        message.success(
          `Đã sinh ${isApiKind ? "API" : "unit"} test bằng ${res.provider} (chưa lưu bản nháp — cần Desktop + project root)`
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

  async function repairWorkspaceWithAi() {
    if (!project || !testCaseId || !localPath || !wsManifest || !isTauri()) return;
    const selected =
      wsPreviews.find((p) => p.entry.targetRel === wsSelectedRel) ?? wsPreviews[0] ?? null;
    if (!selected) {
      message.warning("Không có file bản nháp để repair.");
      return;
    }
    const failedStages = wsManifest.verify?.stages.filter((s) => !s.success) ?? [];
    const repairContext = [
      `Agent Staging run: ${wsManifest.runId}`,
      `Target file: ${selected.entry.targetRel}`,
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
        sourceFileName: wsManifest.sourceFileName || selected.entry.targetRel,
        sourceCode: selected.content,
        framework: framework === "auto" ? "" : framework || "",
        language: language ?? undefined,
        className: guessClassFromCode(selected.content, selected.entry.targetRel),
        module: selectedTc?.module || undefined,
        packagePrefix: wsManifest.packagePrefix,
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
          ...wsManifest,
          repairAttempts: (wsManifest.repairAttempts ?? 0) + 1,
        },
        targetRel: selected.entry.targetRel,
        content: res.code,
      });
      const previews = await loadWorkspacePreviews(localPath, added.manifest);
      setResult(res);
      setWsManifest(added.manifest);
      setWsPreviews(previews);
      setWsSelectedRel(selected.entry.targetRel);
      message.success("AI đã sửa file trong bản nháp. Hãy chạy Verify lại.");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Repair thất bại");
    } finally {
      setRepairing(false);
    }
  }

  const pageTitle = unitOnly ? "Unit test" : "Unit test";

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
            TC Approved → Agent lấy context IDE → Sinh Unit → Staging → Apply
          </Typography.Text>
        </div>
        <Space>
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
          sourceFile={sourceFile || ideFocus?.file || null}
          testFwResolution={testFwResolution}
          skipTestFwInstall={skipTestFwInstall}
          onSkipChange={setSkipTestFwInstall}
          onTestFwResolved={onTestFwResolved}
          onSourceRootBound={onSourceRootBound}
          onSourceRootSynced={onSourceRootSynced}
          onFocusApplied={onIdeFocusApplied}
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
              Sinh Unit cần ít nhất một TC đã duyệt. Hoàn tất pha Design trước — không dùng Focus IDE
              của project khác.
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
          { title: "Agent" },
          { title: "Draft" },
          { title: "Apply" },
        ]}
      />

      <Card title="Sinh Unit" style={{ marginTop: 8 }} loading={loading}>
        <Radio.Group
          value={inputMode}
          onChange={(e) => setInputMode(e.target.value as "single" | "module")}
          style={{ marginBottom: 12 }}
        >
          <Radio.Button value="single">Từng test case</Radio.Button>
          <Radio.Button value="module">Theo module (batch)</Radio.Button>
        </Radio.Group>

        {inputMode === "module" ? (
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <Alert
              type="info"
              showIcon
              title="Sinh hàng loạt · Local FS"
              description="Chọn module. Hệ thống lần lượt sinh mã + bản nháp cho mọi TC Approved — chưa dùng caret IDE từng item."
            />
            <div>
              <Typography.Text strong>Module</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 6 }}
                placeholder="— chọn module —"
                value={moduleKey}
                onChange={setModuleKey}
                options={moduleGroups.map(([name, cases]) => ({
                  value: name,
                  label: `${name} (${cases.length} TC)`,
                }))}
              />
            </div>
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
            <Space wrap>
              <Button
                type="primary"
                icon={<ThunderboltOutlined />}
                onClick={() => void runModuleBatch(false)}
                loading={busy && batchRunStatus === "running"}
                disabled={
                  !aiReady ||
                  !moduleKey ||
                  moduleGroups.length === 0 ||
                  !localPath ||
                  !isTauri() ||
                  batchRunStatus === "paused" ||
                  (busy && batchRunStatus === "running")
                }
              >
                Sinh {isApiKind ? "API" : "unit"} cho cả module
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
              <Card size="small" title="Kết quả batch" type="inner">
                <Table
                  size="small"
                  pagination={false}
                  rowKey="key"
                  dataSource={batchResults}
                  columns={[
                    { title: "TC", dataIndex: "testCaseId", width: 90 },
                    { title: "Tiêu đề", dataIndex: "title", ellipsis: true },
                    {
                      title: "Trạng thái",
                      width: 100,
                      render: (_, r) =>
                        r.status === "ok" ? (
                          <Tag color="success">OK</Tag>
                        ) : r.error === "Đang chờ…" ? (
                          <Tag>Chờ</Tag>
                        ) : (
                          <Tag color="error">Lỗi</Tag>
                        ),
                    },
                    {
                      title: "Ghi chú",
                      dataIndex: "error",
                      ellipsis: true,
                      render: (v, r) =>
                        r.status === "ok" ? (
                          <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                            {r.workspaceRunId?.slice(0, 8) ?? "staging"}
                          </Typography.Text>
                        ) : (
                          v
                        ),
                    },
                  ]}
                />
                {batchFailCount > 0 || batchRunStatus === "running" || batchRunStatus === "paused" ? (
                  <Space wrap style={{ marginTop: 8 }}>
                    {batchFailCount > 0 ? (
                      <Button
                        onClick={() => void runModuleBatch(true)}
                        loading={busy && batchRunStatus === "running"}
                        disabled={
                          !aiReady ||
                          batchRunStatus === "paused" ||
                          (busy && batchRunStatus === "running")
                        }
                      >
                        Thử lại các TC lỗi ({batchFailCount})
                      </Button>
                    ) : null}
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
                ) : null}
              </Card>
            ) : null}
          </Space>
        ) : (
          <Space orientation="vertical" size={14} style={{ width: "100%" }}>
            <div>
              <Typography.Text strong>Test case (đã duyệt)</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 6 }}
                placeholder="— chọn —"
                value={testCaseId}
                onChange={(id) => {
                  setManualSourcePick(false);
                  manualSourcePickRef.current = false;
                  setTestCaseId(id);
                }}
                options={approved.map((t) => ({
                  value: t.id,
                  label: `${t.testCaseId} · ${t.title}`,
                }))}
                showSearch
                optionFilterProp="label"
              />
            </div>

            <AgentRunPanel
              phase={agentPhase}
              intent={agentIntent}
              retrieved={agentRetrieved}
              confidence={agentConfidence}
              error={agentError}
              packetReady={Boolean(agentPacket?.files?.length)}
              primaryPath={agentPrimaryPath}
              framework={agentFw}
              language={agentLang}
              fileCount={agentPacket?.files?.length}
              override={agentOverride}
              rootsMismatch={ideRootMismatch}
              mismatchBanner={
                ideRootMismatch && ideWorkspaceRoot && localPath ? (
                  <RootIdeMismatchBanner
                    compact
                    ideRoot={ideWorkspaceRoot}
                    localPath={localPath}
                    project={project ? { id: project.id, name: project.name } : null}
                    existingMeta={meta}
                    onBound={onSourceRootBound}
                  />
                ) : null
              }
              onContinueRetrieve={() => {
                void runIdeRetrieveOnly();
              }}
              onOverrideGenerate={() => {
                agentSetOverride(true);
                message.warning(
                  "Override: Sinh với packet hiện tại dù confidence chưa đủ."
                );
                agentSetPhase("generating");
                void run().finally(() => {
                  agentSetPhase("done");
                });
              }}
              onGenerate={() => {
                if (agentConfidence && !agentConfidence.enough && !agentOverride) {
                  agentSetOverride(true);
                  message.warning(
                    "Confidence chưa đủ — vẫn sinh (override). Nên Connect IDE + search."
                  );
                }
                agentSetPhase("generating");
                void run().finally(() => {
                  agentSetPhase("done");
                });
              }}
              generateLoading={busy}
              generateDisabled={
                ideRootMismatch ||
                !aiReady ||
                !testCaseId ||
                !runnerOk ||
                !(
                  Boolean(agentPacket?.files?.length) ||
                  sourceFile ||
                  contextPacket?.primaryPath ||
                  sourceCode.trim() ||
                  ideReady ||
                  ideStatus === "connected" ||
                  agentConfidence?.enough ||
                  agentOverride ||
                  (isApiKind && openApiSpec.trim())
                ) ||
                (Boolean(agentPacket?.files?.length) &&
                  !agentConfidence?.enough &&
                  !agentOverride)
              }
            />

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
                          placeholder="Preview từ IDE hoặc paste tạm. Sinh ưu tiên contextPacket từ IDE."
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
            <Space>
              <CodeOutlined />
              Kết quả AI · {result.fileName}
            </Space>
          }
          style={{ marginTop: 8 }}
          extra={
            <Typography.Text type="secondary">provider: {result.provider}</Typography.Text>
          }
        >
          <Space orientation="vertical" size={12} style={{ width: "100%" }}>
            <div>
              <Typography.Text strong>???ng d?n trong repo (khi Apply)</Typography.Text>
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

      {wsManifest && wsPreviews.length > 0 ? (
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
              busy={busy}
              repairing={repairing}
              onBusy={setBusy}
              onRepair={() => void repairWorkspaceWithAi()}
              onManifestChange={(m) => {
                setWsManifest(m);
                if (m.status === "applied") {
                  message.success("Đã Apply vào source code — về Requirement.");
                  navigate(ROUTES.requirement);
                } else if (m.status === "pass") {
                  message.success("Verify PASS — có thể Apply.");
                } else if (m.status === "fail") {
                  message.warning("Verify FAIL — xem log bên dưới. Bấm Repair with AI để AI tự sửa.");
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
