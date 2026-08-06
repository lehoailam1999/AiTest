/**
 * Automate — E2E Test Engine (Playwright TS MVP).
 * EX1–EX5: console · WorkspaceRun · staging Apply · batch · polish.
 */
import {
  DesktopOutlined,
  EyeInvisibleOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RocketOutlined,
  SaveOutlined,
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
  Segmented,
  Select,
  Space,
  Steps,
  Tag,
  Typography,
} from "antd";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import {
  connection,
  generateE2e,
  projects,
  requirementStudio,
  requirements,
  testcases,
  type E2EFileDto,
} from "../../api";
import type {
  Connection,
  Project,
  ProjectMeta,
  RequirementStudioWorkspace,
  TestCase,
} from "../../api/types";
import { createBatchRunControl, type BatchRunStatus } from "../../lib/batchRunControl";
import {
  generateE2eBatch,
  inspectE2eDom,
  verifyE2eForTestCase,
  verifyE2eModuleBatch,
  generateE2eForTestCase,
  runE2eSmokeJob,
  type SmokeJobReport,
  type E2eGenItem,
} from "../../lib/e2eWorkspace";
import {
  aggregateE2eMetrics,
  classifyE2eFailure,
  type E2eRunMetrics,
} from "../../lib/e2eWorkspace/e2eFailureMetrics";
import { resolveE2eFeSources } from "../../lib/e2eWorkspace/resolveE2eFeSources";
import { deriveFeaturePathFromTc } from "../../lib/e2eWorkspace/deriveFeaturePathFromTc";
import { pickDiscoveredStorageStateRel } from "../../lib/e2eWorkspace/pickDiscoveredStorageState";
import {
  applyE2eStaging,
  buildE2eStagedFiles,
  captureE2eBackups,
  deleteE2eStagedFile,
  newE2eRunId,
  refreshE2eOverlayFromFiles,
  rollbackE2eTargets,
  stagingDirHint,
  updateE2eStagedFileContent,
  writeE2eOverlayReplacingPrevious,
  type E2eStagingSession,
} from "../../lib/e2eWorkspace/stagingApply";
import { cleanupWorkspaceRunAfterApply } from "../../lib/unitWorkspace/cleanup";
import { activityUrl, ROUTES } from "../../lib/productRoutes";
import { normalizeProjectMeta } from "../../lib/projectSync";
import { isE2eTestCaseType } from "../../lib/testEngine";
import { useProject } from "../../state/ProjectContext";
import { isTauri } from "../../tauri/bridge";
import { workspace } from "../../workspace";
import { E2eGateBanner } from "./E2eGateBanner";
import { aiConnectionDisplayLabel } from "../../lib/aiConnectionLabel";
import { E2ePipelineStrip } from "./E2ePipelineStrip";
import { E2eResultTabs } from "./E2eResultTabs";
import {
  E2eBatchConsole,
  type E2eBatchPipelineRow,
} from "./E2eBatchConsole";
import { E2eBatchStagingPreview } from "./E2eBatchStagingPreview";
import { E2eVerifyApplyConsole } from "./E2eVerifyApplyConsole";
import {
  BATCH_NOTE_PAUSED,
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
  batchTcSnapshot,
  isBatchQueueNote,
  markBatchRowsPaused,
  markBatchRowsResumed,
  type BatchPipelineRow,
} from "../unit-test/BatchRunConsole";
import {
  generateErrorLogRel,
  saveErrorLogFile,
} from "../../lib/unitWorkspace/errorLogStore";
import {
  appendPhaseLog,
  finishPhase,
  initialE2eJobRunState,
  setPhaseRunning,
  type E2eJobRunState,
  type E2ePhaseId,
} from "./e2eJobState";

/** Requirement Studio / legacy — same shape as Unit batch selector. */
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

/** Folder label for batch — SoT is requirement title; API builds {Req}/{TC} per case. */
function resolveBatchModuleFolder(cases: TestCase[], reqTitle: string): string {
  const slug = (reqTitle || "").trim();
  if (slug) return slug.slice(0, 80);
  const mods = cases
    .map((t) => (t.module || "").trim())
    .filter(Boolean);
  if (mods.length > 0) {
    const counts = new Map<string, number>();
    for (const m of mods) counts.set(m, (counts.get(m) || 0) + 1);
    const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
    if (top) return top[0].slice(0, 80);
  }
  return "E2E";
}

function initE2eQueueRows(cases: TestCase[]): E2eBatchPipelineRow[] {
  return cases.map((t) => ({
    key: t.id,
    testCaseId: t.id,
    title: t.title,
    status: "fail",
    error: BATCH_NOTE_WAITING,
    ...batchTcSnapshot(t),
  }));
}

function mapGenToPipeline(
  cases: TestCase[],
  rows: { testCaseId: string; title: string; status: string; error?: string; runId?: string; files?: number }[],
  genItems: E2eGenItem[],
  prevRows?: E2eBatchPipelineRow[]
): E2eBatchPipelineRow[] {
  const byId = new Map(rows.map((r) => [r.testCaseId, r]));
  const prevById = new Map((prevRows || []).map((r) => [r.testCaseId, r]));
  const okIds = new Set(genItems.map((g) => g.testCaseId));
  return cases.map((t) => {
    const r = byId.get(t.id);
    const prev = prevById.get(t.id);
    const snap = batchTcSnapshot(t);
    if (okIds.has(t.id) || r?.status === "generated" || r?.status === "ok") {
      return {
        key: t.id,
        testCaseId: t.id,
        title: t.title,
        status: "ok" as const,
        runId: r?.runId ?? genItems.find((g) => g.testCaseId === t.id)?.runId,
        files: r?.files ?? genItems.find((g) => g.testCaseId === t.id)?.files.length,
        verifyStatus: "pending" as const,
        ...snap,
      };
    }
    if (r?.status === "running") {
      return {
        key: t.id,
        testCaseId: t.id,
        title: t.title,
        status: "fail" as const,
        error: BATCH_NOTE_RUNNING,
        runId: r.runId,
        ...snap,
      };
    }
    if (r?.status === "pending") {
      return {
        key: t.id,
        testCaseId: t.id,
        title: t.title,
        status: "fail" as const,
        error: BATCH_NOTE_WAITING,
        ...snap,
      };
    }
    const errMsg = r?.error || prev?.error || "Generate fail";
    const detail =
      prev?.errorDetail && !isBatchQueueNote(prev.error)
        ? prev.errorDetail
        : isBatchQueueNote(errMsg)
          ? undefined
          : errMsg;
    return {
      key: t.id,
      testCaseId: t.id,
      title: t.title,
      status: "fail" as const,
      error: errMsg,
      errorDetail: detail,
      errorLogRel: prev?.errorLogRel,
      runId: r?.runId ?? prev?.runId,
      ...snap,
    };
  });
}

function mergeVerifyStatus(
  prev: E2eBatchPipelineRow[],
  verifyRows: {
    testCaseId: string;
    status: string;
    error?: string;
    failCategory?: string;
  }[],
  logRels?: Map<string, string>
): E2eBatchPipelineRow[] {
  const byId = new Map(verifyRows.map((r) => [r.testCaseId, r]));
  return prev.map((p) => {
    const v = byId.get(p.testCaseId);
    if (!v || p.status !== "ok") return p;
    const pass = v.status === "ok";
    if (pass) {
      return {
        ...p,
        verifyStatus: "pass" as const,
        error: undefined,
        errorDetail: undefined,
        errorLogRel: undefined,
        failCategory: undefined,
      };
    }
    const errBody = v.error || p.error || "Verify FAIL";
    return {
      ...p,
      verifyStatus: "fail" as const,
      error: errBody,
      errorDetail: errBody,
      errorLogRel: logRels?.get(p.testCaseId) || p.errorLogRel,
      failCategory: v.failCategory || p.failCategory,
    };
  });
}

export default function E2ETestPage() {
  const { message } = App.useApp();
  const { project } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();

  const [localPath, setLocalPath] = useState<string | null>(null);
  const [serverProject, setServerProject] = useState<Project | null>(null);
  const [conn, setConn] = useState<Connection | null>(null);
  const [approved, setApproved] = useState<TestCase[]>([]);
  const [testCaseId, setTestCaseId] = useState(searchParams.get("testCaseId") || "");
  const [targetUrl, setTargetUrl] = useState("http://localhost:3000");
  const [usePlaywrightInspect, setUsePlaywrightInspect] = useState(true);
  /** Prefer UI login until a real storageState.json exists (avoids Playwright ENOENT). */
  const [useStorageState, setUseStorageState] = useState(false);
  /** Optional override only — primary: AI seed → .ai-test/auth */
  const [e2eUsername, setE2eUsername] = useState("");
  const [e2ePassword, setE2ePassword] = useState("");
  const [authDiscovery, setAuthDiscovery] = useState<{
    ready: boolean;
    defaultRole: string;
    notes: string[];
    envFilesRead: string[];
    roles: {
      role: string;
      hasUsername: boolean;
      hasPassword: boolean;
      storageStateRel?: string | null;
      storageStateValid: boolean;
      source: string;
      skippedSeed: boolean;
    }[];
  } | null>(null);
  const [showAuthOverride, setShowAuthOverride] = useState(false);
  /** Default bật — hiện cửa sổ Chromium khi Headless (có thể tắt để nhanh hơn). */
  const [showBrowser, setShowBrowser] = useState(true);
  const [envHydrated, setEnvHydrated] = useState(false);

  const [busy, setBusy] = useState(false);
  const [files, setFiles] = useState<E2EFileDto[]>([]);
  const [run, setRun] = useState<E2eJobRunState>(initialE2eJobRunState);
  const [activePhase, setActivePhase] = useState<E2ePhaseId | null>(null);
  const [resultTab, setResultTab] = useState("log");
  const [, setGateReady] = useState(false);
  const [, setGateReasons] = useState<string[]>([]);
  const [staging, setStaging] = useState<E2eStagingSession | null>(null);
  const [applyBusy, setApplyBusy] = useState(false);
  const [appliedPaths, setAppliedPaths] = useState<string[]>([]);

  /** Batch theo Requirement (giống Unit) — bên trong là TC E2E Approved */
  const [requirementsList, setRequirementsList] = useState<ReqOption[]>([]);
  const [batchReqId, setBatchReqId] = useState<string | undefined>(() => {
    return searchParams.get("reqId") || searchParams.get("workspaceId") || undefined;
  });
  const [batchSelected, setBatchSelected] = useState<string[]>([]);
  const [batchResults, setBatchResults] = useState<E2eBatchPipelineRow[]>([]);
  const [batchGenItems, setBatchGenItems] = useState<E2eGenItem[]>([]);
  /** Phase 4 — last Verify/Heal metrics */
  const [verifyMetrics, setVerifyMetrics] = useState<E2eRunMetrics | null>(null);
  const [smokeReport, setSmokeReport] = useState<SmokeJobReport | null>(null);
  const [stagingPreviewPath, setStagingPreviewPath] = useState<string | null>(null);
  const [singleRunId, setSingleRunId] = useState<string | null>(null);
  const [singlePrimarySpec, setSinglePrimarySpec] = useState<string>("");
  const [inputMode, setInputMode] = useState<"requirement" | "single">("requirement");
  const [batchStatus, setBatchStatus] = useState<BatchRunStatus>("idle");
  const [batchProgress, setBatchProgress] = useState<{
    current: number;
    total: number;
    label: string;
  } | null>(null);
  const batchControlRef = useRef(createBatchRunControl());
  /** One staging runId per Generate batch — never mint a new folder per TC. */
  const e2eStagingRunIdRef = useRef<string | null>(null);
  const e2eStagingSessionRef = useRef<E2eStagingSession | null>(null);
  /** Reuse Inspect DOM for ~5 phút cùng Target URL + feature seed (skip cold Chromium). */
  const inspectCacheRef = useRef<{
    targetUrl: string;
    featurePath?: string;
    feSeed?: string;
    promptJson: string;
    elementCount: number;
    routeCount: number;
    source: string;
    routes: string[];
    at: number;
  } | null>(null);

  const aiReady =
    conn?.status === "Ready" ||
    conn?.status === "Connected" ||
    Boolean(conn?.hasApiKey);

  const selected = useMemo(
    () => approved.find((t) => t.id === testCaseId) || null,
    [approved, testCaseId]
  );

  const selectedBatchReq = useMemo(
    () => requirementsList.find((r) => r.id === batchReqId) || null,
    [requirementsList, batchReqId]
  );

  const batchCandidates = useMemo(() => {
    if (!selectedBatchReq) return [];
    return approved.filter((t) => tcBelongsToReq(t, selectedBatchReq));
  }, [approved, selectedBatchReq]);

  useEffect(() => {
    if (!selectedBatchReq) return;
    setBatchSelected((prev) => {
      const ids = batchCandidates.map((t) => t.id);
      if (prev.length === 0 && ids.length > 0) return ids;
      const keep = prev.filter((id) => ids.includes(id));
      return keep.length > 0 ? keep : ids;
    });
  }, [selectedBatchReq?.id, batchCandidates]); // eslint-disable-line react-hooks/exhaustive-deps

  /** Single TC: lọc theo cùng Requirement đang chọn ở Batch (nếu có). */
  const singleTcOptions = useMemo(() => {
    if (!selectedBatchReq) return approved;
    const linked = approved.filter((t) => tcBelongsToReq(t, selectedBatchReq));
    return linked.length > 0 ? linked : approved;
  }, [approved, selectedBatchReq]);

  useEffect(() => {
    const unsub = batchControlRef.current.subscribe(setBatchStatus);
    return unsub;
  }, []);

  // EX4.3 — hydrate env from project meta once
  useEffect(() => {
    if (!serverProject || envHydrated) return;
    const e2e = normalizeProjectMeta(serverProject.meta)?.e2e;
    if (e2e?.targetUrl) setTargetUrl(e2e.targetUrl);
    if (typeof e2e?.usePlaywrightInspect === "boolean") {
      setUsePlaywrightInspect(e2e.usePlaywrightInspect);
    }
    if (typeof e2e?.showBrowser === "boolean") {
      setShowBrowser(e2e.showBrowser);
    }
    if (typeof e2e?.useStorageState === "boolean") {
      setUseStorageState(e2e.useStorageState);
    }
    // username/password no longer persisted as primary auth — override only in-session
    setEnvHydrated(true);
  }, [serverProject, envHydrated]);

  const persistE2eEnv = useCallback(async () => {
    if (!project?.id || !serverProject) return;
    const prev = normalizeProjectMeta(serverProject.meta) || {};
    const nextMeta: ProjectMeta = {
      ...prev,
      e2e: {
        targetUrl: targetUrl.trim() || undefined,
        usePlaywrightInspect,
        showBrowser,
        useStorageState,
      },
    };
    try {
      const updated = await projects.update(project.id, { meta: nextMeta });
      setServerProject({
        ...updated,
        meta: normalizeProjectMeta(updated.meta) ?? nextMeta,
      });
    } catch {
      /* best-effort */
    }
  }, [
    project?.id,
    serverProject,
    targetUrl,
    usePlaywrightInspect,
    showBrowser,
    useStorageState,
  ]);

  const refreshRoot = useCallback(() => {
    if (!project?.id) return;
    setLocalPath(workspace.getLocalPath(project.id));
  }, [project?.id]);

  useEffect(() => {
    refreshRoot();
  }, [refreshRoot]);

  useEffect(() => {
    if (!localPath) {
      setAuthDiscovery(null);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const d = await generateE2e.authDiscover({
          projectRoot: localPath,
          module:
            inputMode === "requirement"
              ? selectedBatchReq?.title
              : selected?.module || undefined,
        });
        if (!cancelled) setAuthDiscovery(d);
      } catch {
        if (!cancelled) setAuthDiscovery(null);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [localPath, inputMode, selectedBatchReq?.title, selected?.module]);

  async function refreshAuthDiscovery() {
    if (!localPath) {
      setAuthDiscovery(null);
      return null;
    }
    try {
      const d = await generateE2e.authDiscover({
        projectRoot: localPath,
        module:
          inputMode === "requirement"
            ? selectedBatchReq?.title
            : selected?.module || undefined,
      });
      setAuthDiscovery(d);
      return d;
    } catch {
      setAuthDiscovery(null);
      return null;
    }
  }

  /** AI seed → .ai-test/auth (idempotent). Prefer DOM from Inspect. */
  async function runAuthSeed(opts?: { silent?: boolean }) {
    if (!project?.id || !localPath) {
      if (!opts?.silent) message.warning("Cần project + root");
      return null;
    }
    if (!aiReady) {
      if (!opts?.silent) message.warning("AI chưa Ready");
      return null;
    }
    let domSnapshot = inspectCacheRef.current?.promptJson || "";
    if (!domSnapshot && targetUrl.trim()) {
      try {
        domSnapshot = await ensureInspectSnapshot(false);
      } catch (e) {
        pushPhaseLog("inspect", `  inspect warn (seed): ${String(e)}\n`);
      }
    }
    const tc =
      inputMode === "single"
        ? selected
        : batchCandidates.find((t) => t.id === (batchSelected[0] || testCaseId)) ||
          selected;
    try {
      pushPhaseLog("generate", "→ Seed auth (AI)…\n");
      const res = await generateE2e.authEnsure({
        projectId: project.id,
        projectRoot: localPath,
        testCaseId: tc?.id,
        targetUrl: targetUrl.trim() || undefined,
        domSnapshot: domSnapshot || undefined,
        module: tc?.module || selectedBatchReq?.title || undefined,
        // Manual click re-seeds (stale password → 401). Silent auto-seed stays idempotent.
        force: !opts?.silent,
      });
      pushPhaseLog(
        "generate",
        `  authSeed: ${res.message}${res.skipped ? " (skipped)" : ""}\n`
      );
      await refreshAuthDiscovery();
      if (!opts?.silent) {
        if (res.ok) message.success(res.message);
        else message.warning(res.message || "Seed auth chưa xong");
      }
      return res;
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushPhaseLog("generate", `  authSeed ERROR: ${msg}\n`);
      if (!opts?.silent) message.error(msg);
      return null;
    }
  }

  useEffect(() => {
    if (!project?.id) return;
    let cancelled = false;
    void (async () => {
      try {
        const [p, c, approvedAll, studioRes, legacyRes] = await Promise.all([
          projects.get(project.id),
          connection.get(project.id).catch(() => null),
          testcases.listAll({
            projectId: project.id,
            reviewStatus: "Approved",
          }),
          requirementStudio
            .listWorkspaces(project.id)
            .catch(() => ({ items: [] as RequirementStudioWorkspace[] })),
          requirements.list(project.id, 1, 200).catch(() => ({ items: [] })),
        ]);
        if (cancelled) return;
        setServerProject({
          ...p,
          meta: normalizeProjectMeta(p.meta) ?? p.meta,
        });
        setConn(c);
        const items = (approvedAll || []).filter((t) => isE2eTestCaseType(t.type));
        setApproved(items);

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
        if (cancelled) return;
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
            kind: "legacy" as const,
            legacySourceId: r.id,
            snapshotIds: [],
          }));
        const merged = [...studioOpts, ...legacyOpts];
        setRequirementsList(merged);
        setBatchReqId((prev) => {
          if (prev && merged.some((m) => m.id === prev)) return prev;
          if (
            prev &&
            items.some(
              (t) => t.sourceId === prev || t.requirementSnapshotId === prev
            )
          ) {
            return prev;
          }
          return prev ?? merged[0]?.id;
        });

        const fromUrl = searchParams.get("testCaseId");
        const moduleQ = searchParams.get("module")?.trim();
        if (fromUrl) {
          setTestCaseId(fromUrl);
        } else if (moduleQ) {
          const match = items.find(
            (t) => (t.module || "").toLowerCase() === moduleQ.toLowerCase()
          );
          if (match) setTestCaseId(match.id);
          else if (!testCaseId && items[0]) setTestCaseId(items[0].id);
        } else if (!testCaseId && items[0]) {
          setTestCaseId(items[0].id);
        }
      } catch {
        if (!cancelled) {
          setApproved([]);
          setRequirementsList([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [project?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const syncUrl = useCallback(
    (id: string) => {
      const q = new URLSearchParams(searchParams);
      q.set("testCaseId", id);
      setSearchParams(q, { replace: true });
    },
    [searchParams, setSearchParams]
  );

  const onGateChange = useCallback((g: { ready: boolean; reasons: string[] }) => {
    setGateReady(g.ready);
    setGateReasons(g.reasons);
  }, []);

  function selectPhase(id: E2ePhaseId) {
    setActivePhase(id);
    setResultTab("log");
  }

  function pushPhaseLog(phase: E2ePhaseId, line: string) {
    setActivePhase(phase);
    setRun((r) => appendPhaseLog(setPhaseRunning(r, phase), phase, line));
  }

  async function ensureInspectSnapshot(force = false): Promise<string> {
    if (!localPath) throw new Error("Chưa gắn project root");
    const tcForSeed =
      selected ||
      batchCandidates[0] ||
      approved[0] ||
      null;

    let feSeed = "";
    let sourceCode: string | undefined;
    let sourcePaths: { path: string; content: string }[] | undefined;
    let featurePath: string | undefined;
    if (tcForSeed) {
      try {
        const fe = await resolveE2eFeSources({
          projectRoot: localPath,
          testCase: tcForSeed,
        });
        if (fe) {
          feSeed = fe.sourceFileName;
          sourceCode = fe.sourceCode;
          sourcePaths = [
            { path: fe.sourceFileName, content: fe.sourceCode },
            ...fe.relatedSources,
          ];
          for (const n of fe.notes) {
            pushPhaseLog("inspect", `  fe: ${n}\n`);
          }
          featurePath = deriveFeaturePathFromTc({
            title: tcForSeed.title,
            precondition: tcForSeed.precondition,
            testData: tcForSeed.testData,
            steps: tcForSeed.steps,
            feSource: [fe.sourceCode, ...fe.relatedSources.map((r) => r.content)].join(
              "\n"
            ),
            feFilePaths: [
              fe.sourceFileName,
              ...fe.relatedSources.map((r) => r.path),
            ],
          });
          if (featurePath) {
            pushPhaseLog("inspect", `  featurePath=${featurePath}\n`);
          }
        }
      } catch (e) {
        pushPhaseLog("inspect", `  fe warn: ${String(e)}\n`);
      }
    }

    const cached = inspectCacheRef.current;
    const sameUrl = cached && cached.targetUrl === targetUrl.trim();
    const sameSeed =
      cached &&
      (cached.feSeed || "") === feSeed &&
      (cached.featurePath || "") === (featurePath || "");
    const fresh = sameUrl && sameSeed && Date.now() - cached.at < 5 * 60 * 1000;
    if (!force && fresh && cached.promptJson) {
      pushPhaseLog(
        "inspect",
        `→ Inspect (cache ${Math.round((Date.now() - cached.at) / 1000)}s) elements=${cached.elementCount}\n`
      );
      setRun((r) => finishPhase(r, "inspect", { status: "finish", durationMs: 0 }));
      return cached.promptJson;
    }
    const t0 = performance.now();
    setRun((r) => setPhaseRunning(r, "inspect"));
    const inspected = await inspectE2eDom({
      targetUrl,
      projectRoot: localPath,
      usePlaywrightInspect,
      sourceCode,
      sourcePaths,
      featurePath,
      // Post-auth: prefer discovered AItest storage; API also searches if missing
      username: e2eUsername.trim() || undefined,
      password: e2ePassword.trim() || undefined,
      storageStateRel:
        pickDiscoveredStorageStateRel(authDiscovery) ||
        (useStorageState ? "./fixtures/storageState.json" : undefined),
      module:
        inputMode === "requirement"
          ? selectedBatchReq?.title
          : selected?.module || undefined,
      onLog: (line) => pushPhaseLog("inspect", line),
    });
    // Refine feature path with live routes from Inspect when TC/FE alone was ambiguous
    if (!featurePath && inspected.routes?.length && tcForSeed) {
      featurePath = deriveFeaturePathFromTc({
        title: tcForSeed.title,
        precondition: tcForSeed.precondition,
        testData: tcForSeed.testData,
        steps: tcForSeed.steps,
        routes: inspected.routes,
        feSource: sourceCode,
      });
      if (featurePath) {
        pushPhaseLog("inspect", `  featurePath(from routes)=${featurePath}\n`);
      }
    }
    inspectCacheRef.current = {
      targetUrl: targetUrl.trim(),
      featurePath,
      feSeed,
      promptJson: inspected.domSnapshot,
      elementCount: inspected.elementCount,
      routeCount: inspected.routeCount,
      source: inspected.source,
      routes: inspected.routes || [],
      at: Date.now(),
    };
    setRun((r) =>
      finishPhase(r, "inspect", {
        status: inspected.elementCount > 0 ? "finish" : "error",
        durationMs: Math.round(performance.now() - t0),
      })
    );
    return inspected.domSnapshot;
  }

  async function stageFilesFromGen(
    batchFiles: E2EFileDto[],
    moduleName: string,
    tcId: string,
    fixedRunId?: string
  ) {
    if (!project?.id || !localPath || batchFiles.length === 0) return;
    setFiles(batchFiles);
    setResultTab("files");
    if (!isTauri()) return;
    // Reuse batch/single runId — creating a new e2e-* folder per TC was the
    // root cause of stacked overlays (1 TC, then 2, then 4…) under .ai-test/staging.
    const runId =
      fixedRunId ||
      e2eStagingRunIdRef.current ||
      newE2eRunId(tcId || "batch");
    e2eStagingRunIdRef.current = runId;
    try {
      const staged = buildE2eStagedFiles(batchFiles, {
        runId,
        module: moduleName,
      });
      const session: E2eStagingSession = {
        runId,
        projectId: project.id,
        testCaseId: tcId,
        module: moduleName,
        files: staged,
        backups: [],
      };
      await writeE2eOverlayReplacingPrevious(
        localPath,
        session,
        e2eStagingSessionRef.current
      );
      e2eStagingSessionRef.current = session;
      setStaging(session);
      setAppliedPaths([]);
    } catch {
      /* optional */
    }
  }

  /** Step 1 — Inspect only */
  async function runStepInspect() {
    if (!localPath) {
      message.warning("Cần gắn project root");
      return;
    }
    if (!targetUrl.trim()) {
      message.warning("Cần Target URL");
      return;
    }
    setBusy(true);
    setResultTab("log");
    try {
      await ensureInspectSnapshot(true);
      message.success("Inspect xong");
      void persistE2eEnv();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, "inspect", `ERROR: ${String(e)}\n`), "inspect", {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      setBusy(false);
    }
  }

  /** Step 2 — Generate only (batch) */
  async function runStepGenerateBatch() {
    if (!project?.id || !localPath) {
      message.warning("Cần project + root");
      return;
    }
    if (!selectedBatchReq || batchSelected.length === 0) {
      message.warning("Chọn Requirement và ít nhất 1 TC E2E");
      return;
    }
    if (!aiReady) {
      message.warning("AI chưa Ready");
      return;
    }
    const cases =
      batchSelected.length > 0
        ? batchCandidates.filter((t) => batchSelected.includes(t.id))
        : [...batchCandidates];
    if (cases.length === 0) return;
    setBatchSelected(cases.map((t) => t.id));
    if (!testCaseId && cases[0]) {
      setTestCaseId(cases[0].id);
      syncUrl(cases[0].id);
    }

    const batchModule = resolveBatchModuleFolder(cases, selectedBatchReq.title);
    // Mint ONE staging run for the whole batch before any TC finishes.
    const batchStagingRunId = newE2eRunId(cases[0]?.id || "batch");
    if (
      e2eStagingRunIdRef.current &&
      e2eStagingRunIdRef.current !== batchStagingRunId &&
      localPath
    ) {
      try {
        await cleanupWorkspaceRunAfterApply(
          localPath,
          e2eStagingRunIdRef.current,
          e2eStagingSessionRef.current?.packagePrefix
        );
      } catch {
        /* best-effort clear prior batch staging */
      }
    }
    e2eStagingRunIdRef.current = batchStagingRunId;
    e2eStagingSessionRef.current = null;
    setStaging(null);

    const control = batchControlRef.current;
    control.start();
    setBusy(true);
    setAppliedPaths([]);
    setBatchGenItems([]);
    setBatchResults(initE2eQueueRows(cases));
    setVerifyMetrics(null);
    setBatchProgress({ current: 0, total: cases.length, label: cases[0]?.title || "Generate…" });
    setActivePhase("generate");
    setResultTab("log");
    setRun((r) => setPhaseRunning(r, "generate"));

    try {
      // Inspect runs per TC inside generateE2eBatch (inspectPerTc) — no warm-up Chromium.
      pushPhaseLog(
        "inspect",
        "  skip warm-up Inspect (per-TC Inspect during Generate)\n"
      );

      const t0 = performance.now();
      const { rows, files: batchFiles, genItems } = await generateE2eBatch({
        projectId: project.id,
        projectRoot: localPath,
        testCases: cases,
        targetUrl,
        module: batchModule,
        requirementTitle: selectedBatchReq?.title,
        provider: conn?.provider,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        inspectPerTc: true,
        usePlaywrightInspect,
        skipAuthSeed: Boolean(pickDiscoveredStorageStateRel(authDiscovery)),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        waitIfPaused: async () => {
          await control.waitIfPaused();
          setBatchResults((prev) =>
            control.getStatus() === "paused"
              ? (markBatchRowsPaused(prev as BatchPipelineRow[]) as E2eBatchPipelineRow[])
              : prev
          );
        },
        onProgress: (p) => {
          setActivePhase("generate");
          setBatchProgress({
            current: p.current,
            total: p.total,
            label: p.label,
          });
          if (!p.testCaseId) return;
          setBatchResults((prev) =>
            prev.map((r) => {
              if (r.testCaseId !== p.testCaseId) return r;
              if (p.itemStatus === "running") {
                return { ...r, status: "fail", error: BATCH_NOTE_RUNNING };
              }
              return r;
            })
          );
        },
        onItemDone: (item) => {
          setBatchProgress({
            current: item.done,
            total: item.total,
            label:
              item.status === "generated"
                ? `Đã gen «${item.title}» (${item.done}/${item.total})`
                : `Gen lỗi «${item.title}» (${item.done}/${item.total})`,
          });
          const tc = cases.find((c) => c.id === item.testCaseId);
          const snap = tc ? batchTcSnapshot(tc) : {};
          if (item.status === "generated") {
            setBatchResults((prev) =>
              prev.map((r) =>
                r.testCaseId !== item.testCaseId
                  ? r
                  : {
                      ...r,
                      ...snap,
                      status: "ok",
                      error: undefined,
                      errorDetail: undefined,
                      errorLogRel: undefined,
                      runId: item.row.runId,
                      files: item.row.files,
                      verifyStatus: "pending",
                    }
              )
            );
          } else {
            const errMsg = item.row.error || "Generate fail";
            const logBody = `${new Date().toISOString()} · E2E Generate FAIL · ${item.testCaseId}\n${item.title}\n\n${errMsg}`;
            setBatchResults((prev) =>
              prev.map((r) =>
                r.testCaseId !== item.testCaseId
                  ? r
                  : {
                      ...r,
                      ...snap,
                      status: "fail",
                      error: errMsg,
                      errorDetail: logBody,
                      runId: item.row.runId,
                    }
              )
            );
            if (localPath && isTauri()) {
              void saveErrorLogFile(
                localPath,
                generateErrorLogRel(item.testCaseId),
                logBody
              )
                .then((errorLogRel) => {
                  setBatchResults((prev) =>
                    prev.map((r) =>
                      r.testCaseId === item.testCaseId ? { ...r, errorLogRel } : r
                    )
                  );
                })
                .catch(() => undefined);
            }
          }
          if (item.genItem) {
            setBatchGenItems((prev) => {
              const rest = prev.filter((g) => g.testCaseId !== item.genItem!.testCaseId);
              return [...rest, item.genItem!];
            });
            setFiles(item.filesSoFar);
            void stageFilesFromGen(
              item.filesSoFar,
              batchModule,
              item.testCaseId,
              batchStagingRunId
            );
            message.success(`Đã gen: ${item.title}`, 2);
          }
        },
        onLog: (line) => pushPhaseLog("generate", line),
      });
      setBatchResults((prev) => {
        const mapped = mapGenToPipeline(cases, rows, genItems, prev);
        return control.getStatus() === "paused"
          ? (markBatchRowsPaused(mapped as BatchPipelineRow[]) as E2eBatchPipelineRow[])
          : mapped;
      });
      setBatchGenItems(genItems);
      setFiles(batchFiles);
      await stageFilesFromGen(
        batchFiles,
        batchModule,
        cases[0]?.id || "",
        batchStagingRunId
      );
      setRun((r) => ({
        ...finishPhase(r, "generate", {
          status: genItems.length > 0 ? "finish" : "error",
          durationMs: Math.round(performance.now() - t0),
        }),
        jobPassed: null,
      }));
      message.success(
        `Generate xong: ${genItems.length}/${cases.length} TC — tiếp theo: Kiểm thử`
      );
      void persistE2eEnv();
      void refreshAuthDiscovery();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, "generate", `ERROR: ${String(e)}\n`), "generate", {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      // If still paused mid-batch (shouldn't happen after pool drain), keep busy.
      if (control.getStatus() === "paused") {
        setBatchProgress((p) =>
          p
            ? { ...p, label: `Tạm dừng · đã gen — có thể Kiểm thử tất cả phần đã gen` }
            : p
        );
      } else {
        control.reset();
        setBusy(false);
        setBatchProgress(null);
      }
    }
  }

  /** S5 — Smoke 10 TC: sequential Gen + taxonomy + Verify ≤3 Spec + G1–G7 report */
  async function runStepSmoke() {
    if (!project?.id || !localPath) {
      message.warning("Cần project + root");
      return;
    }
    if (!aiReady) {
      message.warning("AI chưa Ready");
      return;
    }
    const pool =
      selectedBatchReq && batchCandidates.length > 0
        ? batchCandidates
        : approved.filter((t) => isE2eTestCaseType(t.type));
    if (pool.length === 0) {
      message.warning("Chưa có TC E2E Approved để smoke");
      return;
    }
    const batchModule = selectedBatchReq
      ? resolveBatchModuleFolder(pool, selectedBatchReq.title)
      : resolveBatchModuleFolder(pool, pool[0]?.module || "E2E");

    const control = batchControlRef.current;
    control.start();
    setBusy(true);
    setSmokeReport(null);
    setVerifyMetrics(null);
    setBatchProgress({ current: 0, total: Math.min(10, pool.length), label: "S5 Smoke…" });
    setActivePhase("generate");
    setResultTab("log");
    setRun((r) => setPhaseRunning(r, "generate"));
    pushPhaseLog("generate", `→ S5 Smoke E2E Job · pool=${pool.length}\n`);

    try {
      const t0 = performance.now();
      const result = await runE2eSmokeJob({
        projectId: project.id,
        projectRoot: localPath,
        testCases: pool,
        targetUrl,
        module: batchModule,
        requirementTitle: selectedBatchReq?.title,
        provider: conn?.provider,
        smokeSize: 10,
        verifyMax: 3,
        runVerify: true,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        usePlaywrightInspect,
        skipAuthSeed: Boolean(pickDiscoveredStorageStateRel(authDiscovery)),
        showBrowser,
        authDiscovery,
        waitIfPaused: async () => {
          await control.waitIfPaused();
        },
        onProgress: (p) => {
          setActivePhase(p.phase === "verify" ? "headless" : "generate");
          setBatchProgress({
            current: p.current,
            total: p.total,
            label: p.label,
          });
        },
        onLog: (line) => pushPhaseLog("generate", line),
      });

      setSmokeReport(result.report);
      setBatchSelected(result.smokeCases.map((t) => t.id));
      setBatchGenItems(result.genItems);
      setFiles(result.files);
      setBatchResults(
        mapGenToPipeline(result.smokeCases, result.rows, result.genItems)
      );
      const ms = Math.round(performance.now() - t0);
      pushPhaseLog("generate", result.report.reportText + "\n");
      setRun((r) =>
        finishPhase(r, "generate", {
          status: result.report.taxonomy.genOk > 0 ? "finish" : "error",
          durationMs: ms,
        })
      );
      if (result.report.readyForPerfPlan) {
        message.success(
          `Smoke OK · G1–G6 PASS · Gen ${result.report.taxonomy.genOk}/${result.report.taxonomy.total}`
        );
      } else {
        message.warning(
          `Smoke xong · Gen ${result.report.taxonomy.genOk}/${result.report.taxonomy.total} — xem gate FAIL trong log`
        );
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      pushPhaseLog("generate", `S5 Smoke ERROR: ${msg}\n`);
      message.error(msg);
      setRun((r) =>
        finishPhase(r, "generate", { status: "error", durationMs: 0 })
      );
    } finally {
      control.reset();
      setBusy(false);
      setBatchProgress(null);
    }
  }

  /** Step 3 — Verify Playwright hàng loạt: toàn bộ batchGenItems (Gen OK), không lọc batchSelected/filter bảng. */
  async function runStepVerifyBatch() {
    if (!project?.id || !localPath) {
      message.warning("Cần project + root");
      return;
    }
    if (files.length === 0 || batchGenItems.length === 0) {
      message.warning("Chưa Generate — bấm Chạy E2E Job trước (hoặc chờ TC gen xong)");
      return;
    }
    // Module folder from requirement title; verify set = all generated items this batch.
    const batchModule = selectedBatchReq
      ? resolveBatchModuleFolder(
          batchCandidates.filter((t) =>
            batchGenItems.some((g) => g.testCaseId === t.id)
          ),
          selectedBatchReq.title
        )
      : "E2E";

    const control = batchControlRef.current;
    const preserveGeneratePause = control.getStatus() === "paused";
    setBusy(true);
    if (!preserveGeneratePause) control.start();
    setActivePhase("headless");
    setResultTab("log");
    setBatchProgress({
      current: 0,
      total: batchGenItems.length,
      label: preserveGeneratePause
        ? `Kiểm thử tất cả phần đã gen (${batchGenItems.length} TC)`
        : showBrowser
          ? `Kiểm thử tất cả — Chromium (${batchGenItems.length} TC)…`
          : `Kiểm thử tất cả (${batchGenItems.length} TC)…`,
    });

    try {
      const domSnapshot = inspectCacheRef.current?.promptJson || "";
      if (
        !authDiscovery?.ready &&
        !e2eUsername.trim() &&
        !e2ePassword.trim() &&
        aiReady
      ) {
        await runAuthSeed({ silent: true });
      }
      let session = staging;
      if (isTauri() && session) {
        try {
          session = {
            ...session,
            backups: await captureE2eBackups(localPath, session.files),
          };
          setStaging(session);
          pushPhaseLog("headless", "  đã snapshot AItest (rollback sau Verify)\n");
        } catch {
          /* optional */
        }
      }

      const t0 = performance.now();
      const { rows, okCount, files: outFiles, metrics } = await verifyE2eModuleBatch({
        projectId: project.id,
        projectRoot: localPath,
        module: batchModule,
        targetUrl,
        files,
        genItems: batchGenItems,
        domSnapshot,
        showBrowser,
        provider: conn?.provider,
        healFailures: false,
        maxRetries: 1,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        // Suite path only when genItems share one — else each Spec uses baked path
        featurePath: inspectCacheRef.current?.featurePath,
        priorRows: batchResults.map((r) => ({
          testCaseId: r.testCaseId,
          title: r.title,
          status: r.status === "ok" ? "generated" : "fail",
          error: r.error,
          runId: r.runId,
          files: r.files,
        })),
        onProgress: (p) => {
          setActivePhase("headless");
          setBatchProgress({
            current: p.current,
            total: p.total,
            label: p.label,
          });
        },
        onLog: (line) => pushPhaseLog("headless", line),
      });
      setVerifyMetrics(metrics);
      const logRels = new Map<string, string>();
      if (localPath && isTauri()) {
        for (const vr of rows) {
          if (vr.status === "ok" || !vr.error) continue;
          const logBody = `${new Date().toISOString()} · E2E Verify FAIL · ${vr.testCaseId}\n${vr.title || ""}\n\n${vr.error}`;
          try {
            const rel = await saveErrorLogFile(
              localPath,
              generateErrorLogRel(vr.testCaseId),
              logBody
            );
            logRels.set(vr.testCaseId, rel);
          } catch {
            /* best-effort */
          }
        }
      }
      setBatchResults((prev) => mergeVerifyStatus(prev, rows, logRels));
      setFiles(outFiles);

      if (isTauri() && session && outFiles.length > 0) {
        try {
          session = await refreshE2eOverlayFromFiles(localPath, session, outFiles);
          setStaging(session);
          if (session.backups.length) {
            await rollbackE2eTargets(localPath, session.backups);
            pushPhaseLog("headless", "  đã rollback AItest — chờ Apply từ staging\n");
          }
        } catch (e) {
          pushPhaseLog("headless", `  staging warn: ${String(e)}\n`);
        }
      }
      const allPassed = okCount === batchGenItems.length;
      const firstVerifyError =
        rows.find((r) => r.status !== "ok")?.error || "";
      setRun((r) => ({
        ...finishPhase(r, "headless", {
          status: allPassed ? "finish" : "error",
          durationMs: Math.round(performance.now() - t0),
        }),
        jobPassed: allPassed,
      }));
      setRun((r) => finishPhase(r, "heal", { status: "skip", durationMs: 0 }));
      if (allPassed) {
        message.success(
          `Kiểm thử: ${okCount}/${batchGenItems.length} PASS (${metrics.passRatePct}%)`
        );
      } else {
        setResultTab("log");
        message.error(
          firstVerifyError
            ? `Kiểm thử ${metrics.passRatePct}% PASS — ${metrics.summaryLine}. ${firstVerifyError.slice(0, 120)}`
            : metrics.summaryLine
        );
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, "headless", `ERROR: ${String(e)}\n`), "headless", {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      setBatchProgress(null);
      if (preserveGeneratePause) {
        if (control.getStatus() === "running") control.pause();
        // Keep busy — Generate vẫn chờ Tiếp tục
      } else {
        control.reset();
        setBusy(false);
      }
    }
  }

  /** Step 4 — Heal failed specs (AI + Playwright) */
  async function runStepHealBatch() {
    if (!project?.id || !localPath) {
      message.warning("Cần project + root");
      return;
    }
    if (files.length === 0 || batchGenItems.length === 0) {
      message.warning("Chưa có file Generate");
      return;
    }
    if (run.jobPassed === true) {
      message.info("Không có TC FAIL để Heal");
      return;
    }
    if (!aiReady) {
      message.warning("AI chưa Ready — không Heal được");
      return;
    }
    const batchModule = selectedBatchReq
      ? resolveBatchModuleFolder(
          batchCandidates.filter((t) =>
            batchGenItems.some((g) => g.testCaseId === t.id)
          ),
          selectedBatchReq.title
        )
      : "E2E";

    const control = batchControlRef.current;
    const preserveGeneratePause = control.getStatus() === "paused";
    setBusy(true);
    if (!preserveGeneratePause) control.start();
    setActivePhase("heal");
    setResultTab("log");

    try {
      const t0 = performance.now();
      const { rows, okCount, files: outFiles, metrics } = await verifyE2eModuleBatch({
        projectId: project.id,
        projectRoot: localPath,
        module: batchModule,
        targetUrl,
        files,
        genItems: batchGenItems,
        domSnapshot: inspectCacheRef.current?.promptJson || "",
        showBrowser,
        provider: conn?.provider,
        healFailures: true,
        maxRetries: 2,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        featurePath: inspectCacheRef.current?.featurePath,
        priorRows: batchResults.map((r) => ({
          testCaseId: r.testCaseId,
          title: r.title,
          status: r.status === "ok" ? "generated" : "fail",
          error: r.error,
          runId: r.runId,
          files: r.files,
        })),
        onProgress: (p) => {
          setActivePhase("heal");
          setBatchProgress({
            current: p.current,
            total: p.total,
            label: p.label,
          });
        },
        onLog: (line) => pushPhaseLog("heal", line),
      });
      setVerifyMetrics(metrics);
      const healLogRels = new Map<string, string>();
      if (localPath && isTauri()) {
        for (const vr of rows) {
          if (vr.status === "ok" || !vr.error) continue;
          const logBody = `${new Date().toISOString()} · E2E Heal/Verify FAIL · ${vr.testCaseId}\n${vr.title || ""}\n\n${vr.error}`;
          try {
            const rel = await saveErrorLogFile(
              localPath,
              generateErrorLogRel(vr.testCaseId),
              logBody
            );
            healLogRels.set(vr.testCaseId, rel);
          } catch {
            /* best-effort */
          }
        }
      }
      setBatchResults((prev) => mergeVerifyStatus(prev, rows, healLogRels));
      setFiles(outFiles);
      if (isTauri() && staging && outFiles.length > 0) {
        try {
          const session = await refreshE2eOverlayFromFiles(localPath, staging, outFiles);
          setStaging(session);
        } catch {
          /* optional */
        }
      }
      const allPassed = okCount === batchGenItems.length;
      setRun((r) => ({
        ...finishPhase(r, "heal", {
          status: allPassed ? "finish" : "error",
          durationMs: Math.round(performance.now() - t0),
        }),
        jobPassed: allPassed,
        healCount: allPassed ? 1 : 0,
      }));
      message.success(
        `Heal: ${okCount}/${batchGenItems.length} PASS (${metrics.passRatePct}%) — ${metrics.summaryLine}`
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, "heal", `ERROR: ${String(e)}\n`), "heal", {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      setBatchProgress(null);
      if (preserveGeneratePause) {
        if (control.getStatus() === "running") control.pause();
      } else {
        control.reset();
        setBusy(false);
      }
    }
  }

  /** Single — Generate only */
  async function runStepGenerateSingle() {
    if (!project?.id || !localPath || !testCaseId || !selected) {
      message.warning("Chọn TC + gắn root");
      return;
    }
    if (!aiReady) {
      message.warning("AI chưa Ready");
      return;
    }
    setBusy(true);
    setAppliedPaths([]);
    setVerifyMetrics(null);
    setActivePhase("generate");
    setResultTab("log");
    setRun((r) => setPhaseRunning(r, "generate"));
    try {
      // Single Generate uses inspectPerTc — skip duplicate warm-up Chromium.
      pushPhaseLog(
        "inspect",
        "  skip warm-up Inspect (per-TC Inspect during Generate)\n"
      );
      const t0 = performance.now();
      const gen = await generateE2eForTestCase({
        projectId: project.id,
        projectRoot: localPath,
        testCase: selected,
        targetUrl,
        module: selected.module || undefined,
        provider: conn?.provider,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        inspectPerTc: true,
        usePlaywrightInspect,
        skipAuthSeed: Boolean(pickDiscoveredStorageStateRel(authDiscovery)),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        onLog: (line) => pushPhaseLog("generate", line),
      });
      setSingleRunId(gen.runId);
      setSinglePrimarySpec(gen.primarySpecPath);
      setBatchGenItems([
        {
          testCaseId: selected.id,
          title: selected.title,
          runId: gen.runId,
          primarySpecPath: gen.primarySpecPath,
          files: gen.files,
          authRole: gen.authRole,
          featurePath: gen.featurePath,
          domSnapshot: gen.domSnapshot,
        },
      ]);
      await stageFilesFromGen(
        gen.files,
        selected.module || "E2E",
        selected.id,
        newE2eRunId(selected.id)
      );
      setRun((r) => ({
        ...finishPhase(r, "generate", {
          status: gen.files.length > 0 ? "finish" : "error",
          durationMs: Math.round(performance.now() - t0),
        }),
        jobPassed: null,
      }));
      message.success("Generate xong — bấm Verify để chạy Playwright");
      void persistE2eEnv();
      void refreshAuthDiscovery();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, "generate", `ERROR: ${String(e)}\n`), "generate", {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function runStepVerifySingle(healFailures: boolean) {
    if (!project?.id || !localPath || !selected) {
      message.warning("Chọn TC + gắn root");
      return;
    }
    if (files.length === 0) {
      message.warning("Chưa Generate");
      return;
    }
    const phase: E2ePhaseId = healFailures ? "heal" : "headless";
    setBusy(true);
    setActivePhase(phase);
    setResultTab("log");
    try {
      if (
        !authDiscovery?.ready &&
        !e2eUsername.trim() &&
        !e2ePassword.trim() &&
        aiReady
      ) {
        await runAuthSeed({ silent: true });
      }
      let session = staging;
      if (!healFailures && isTauri() && session) {
        try {
          session = {
            ...session,
            backups: await captureE2eBackups(localPath, session.files),
          };
          setStaging(session);
        } catch {
          /* optional */
        }
      }
      const t0 = performance.now();
      const verified = await verifyE2eForTestCase({
        projectId: project.id,
        projectRoot: localPath,
        testCase: selected,
        targetUrl,
        files,
        primarySpecPath: singlePrimarySpec || undefined,
        runId: singleRunId || undefined,
        domSnapshot: inspectCacheRef.current?.promptJson || "",
        module: selected.module || undefined,
        showBrowser,
        provider: conn?.provider,
        healFailures,
        maxRetries: healFailures ? 2 : 1,
        useStorageState,
        username: e2eUsername,
        password: e2ePassword,
        storageStateRel: pickDiscoveredStorageStateRel(authDiscovery),
        defaultAuthRole: authDiscovery?.defaultRole || undefined,
        featurePath: inspectCacheRef.current?.featurePath,
        onLog: (line) => pushPhaseLog(phase, line),
      });
      setFiles(verified.files);
      if (verified.primarySpecPath) setSinglePrimarySpec(verified.primarySpecPath);
      if (isTauri() && session && verified.files.length > 0) {
        try {
          session = await refreshE2eOverlayFromFiles(localPath, session, verified.files);
          setStaging(session);
          if (!healFailures && session.backups.length) {
            await rollbackE2eTargets(localPath, session.backups);
            pushPhaseLog(phase, "  đã rollback AItest — chờ Apply\n");
          }
        } catch (e) {
          pushPhaseLog(phase, `  staging warn: ${String(e)}\n`);
        }
      }
      const failCategory = verified.passed
        ? undefined
        : classifyE2eFailure(verified.error);
      const metrics = aggregateE2eMetrics([
        {
          testCaseId: selected.id,
          title: selected.title,
          status: verified.passed ? "ok" : "fail",
          error: verified.error,
          failCategory,
        },
      ]);
      setVerifyMetrics(metrics);
      setBatchResults((prev) => {
        if (!prev.length) {
          return [
            {
              key: selected.id,
              testCaseId: selected.id,
              title: selected.title,
              status: "ok" as const,
              files: verified.files.length,
              verifyStatus: verified.passed ? ("pass" as const) : ("fail" as const),
              error: verified.error,
              errorDetail: verified.passed ? undefined : verified.error,
              failCategory,
              ...batchTcSnapshot(selected),
            },
          ];
        }
        return mergeVerifyStatus(prev, [
          {
            testCaseId: selected.id,
            status: verified.passed ? "ok" : "fail",
            error: verified.error,
            failCategory,
          },
        ]);
      });
      setRun((r) => ({
        ...finishPhase(r, phase, {
          status: verified.passed ? "finish" : "error",
          durationMs: Math.round(performance.now() - t0),
        }),
        jobPassed: verified.passed,
        healAttempts: verified.attempts,
        healCount: healFailures && verified.passed ? 1 : r.healCount,
      }));
      if (!healFailures) {
        setRun((r) => finishPhase(r, "heal", { status: "skip", durationMs: 0 }));
      }
      message.success(
        verified.passed
          ? `PASS (${metrics.passRatePct}%)`
          : `FAIL [${failCategory}] — ${metrics.summaryLine}`
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
      setRun((r) =>
        finishPhase(appendPhaseLog(r, phase, `ERROR: ${String(e)}\n`), phase, {
          status: "error",
          durationMs: 0,
        })
      );
    } finally {
      setBusy(false);
    }
  }

  async function onApplyStaging() {
    if (!localPath || !staging) {
      message.warning("Không có staging để Apply");
      return;
    }
    if (run.jobPassed !== true) {
      message.warning("Chỉ Apply sau khi Kiểm thử PASS (giống Unit)");
      return;
    }
    setApplyBusy(true);
    try {
      const result = await applyE2eStaging(localPath, staging);
      setAppliedPaths(result.appliedPaths);
      setBatchResults((prev) =>
        prev.map((r) =>
          r.verifyStatus === "pass" ? { ...r, applyStatus: "done" as const } : r
        )
      );
      setRun((r) =>
        finishPhase(r, "apply", {
          status: "finish",
          durationMs: 0,
          logExtra:
            `→ Applied ${result.appliedPaths.length} file(s) dưới AItest/E2ETest\n` +
            result.appliedPaths.map((p) => `  ✓ ${p}\n`).join("") +
            (result.stagingCleaned
              ? "  staging đã dọn.\n"
              : "  staging cleanup: một phần / bỏ qua.\n") +
            "Done.\n",
        })
      );
      setStaging(null);
      setActivePhase("apply");
      setResultTab("files");
      message.success(
        result.stagingCleaned
          ? `Đã Apply ${result.appliedPaths.length} file · staging đã dọn`
          : `Đã Apply ${result.appliedPaths.length} file`
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setApplyBusy(false);
    }
  }

  function pauseE2eBatch() {
    batchControlRef.current.pause();
    setBatchResults(
      (prev) => markBatchRowsPaused(prev as BatchPipelineRow[]) as E2eBatchPipelineRow[]
    );
    message.info(
      "Đã tạm dừng TC chưa chạy — TC đang gen sẽ xong. Có thể Kiểm thử tất cả phần đã gen."
    );
  }

  function resumeE2eBatch() {
    setBatchResults(
      (prev) => markBatchRowsResumed(prev as BatchPipelineRow[]) as E2eBatchPipelineRow[]
    );
    batchControlRef.current.resume();
  }

  async function onDiscardStaging() {
    if (localPath && e2eStagingRunIdRef.current) {
      try {
        await cleanupWorkspaceRunAfterApply(
          localPath,
          e2eStagingRunIdRef.current,
          e2eStagingSessionRef.current?.packagePrefix
        );
      } catch {
        /* best-effort */
      }
    }
    e2eStagingRunIdRef.current = null;
    e2eStagingSessionRef.current = null;
    setStaging(null);
    setFiles([]);
    setBatchGenItems([]);
    setBatchResults([]);
    setAppliedPaths([]);
    setRun(initialE2eJobRunState());
    message.info("Đã hủy staging E2E");
  }

  function patchE2eFileInMemory(path: string, content: string | null) {
    const norm = (p: string) => p.replace(/\\/g, "/");
    const want = norm(path);
    const match = (p: string) => {
      const a = norm(p);
      return a === want || a.endsWith("/" + want.split("/").pop()) || want.endsWith("/" + a.split("/").pop());
    };
    setFiles((prev) =>
      content === null
        ? prev.filter((f) => !match(f.path))
        : prev.map((f) => (match(f.path) ? { ...f, content } : f))
    );
    setBatchGenItems((prev) =>
      prev.map((g) => ({
        ...g,
        files:
          content === null
            ? g.files.filter((f) => !match(f.path))
            : g.files.map((f) => (match(f.path) ? { ...f, content } : f)),
      }))
    );
  }

  async function onSaveStagingFile(path: string, content: string) {
    patchE2eFileInMemory(path, content);
    if (!localPath || !isTauri()) return;
    const session = e2eStagingSessionRef.current || staging;
    if (!session) return;
    const { session: next, syncedTarget } = await updateE2eStagedFileContent(
      localPath,
      session,
      path,
      content
    );
    e2eStagingSessionRef.current = next;
    setStaging(next);
    if (syncedTarget) {
      /* already messaged in preview */
    }
  }

  async function onDeleteStagingFile(path: string) {
    patchE2eFileInMemory(path, null);
    if (!localPath || !isTauri()) return;
    const session = e2eStagingSessionRef.current || staging;
    if (!session) return;
    const { session: next } = await deleteE2eStagedFile(localPath, session, path);
    e2eStagingSessionRef.current = next;
    setStaging(next);
  }

  const pipelineStep =
    appliedPaths.length > 0 ? 2 : run.jobPassed != null ? 1 : files.length > 0 ? 1 : 0;
  const batchFailCount = batchResults.filter(
    (r) =>
      r.status === "fail" &&
      r.error !== BATCH_NOTE_WAITING &&
      r.error !== BATCH_NOTE_PAUSED &&
      r.error !== BATCH_NOTE_RUNNING
  ).length;
  const genOkCount = batchResults.filter((r) => r.status === "ok").length;

  if (!project) {
    return (
      <div className="page">
        <Alert type="warning" showIcon title="Chọn dự án ở Home / Projects trước." />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            E2E test
          </Typography.Title>
          <Typography.Text type="secondary">
            Giống Unit: E2E Job → Kiểm thử → Apply vào{" "}
            <Typography.Text code style={{ fontSize: 12 }}>
              {"{project root}"}/AItest/E2ETest/
            </Typography.Text>
          </Typography.Text>
        </div>
        <Space>
          <Link to={activityUrl({ tab: "e2e-jobs" })}>
            <Button>E2E Job Board</Button>
          </Link>
          <Link to={ROUTES.unitTest}>
            <Button>Unit test</Button>
          </Link>
        </Space>
      </header>

      <Space orientation="vertical" size="middle" style={{ width: "100%", marginTop: 12 }}>
        <E2eGateBanner
          aiReady={Boolean(aiReady)}
          aiProvider={aiConnectionDisplayLabel(conn)}
          localPath={localPath}
          targetUrl={targetUrl}
          testCaseId={testCaseId || batchSelected[0] || ""}
          authReady={
            Boolean(pickDiscoveredStorageStateRel(authDiscovery)) ||
            Boolean(e2eUsername.trim() && e2ePassword.trim()) ||
            useStorageState ||
            // Discover found role users — still recommend seed for storageState
            Boolean(authDiscovery?.ready)
          }
          authLabel={
            pickDiscoveredStorageStateRel(authDiscovery)
              ? authDiscovery?.defaultRole || "storage"
              : e2eUsername.trim()
                ? "credentials"
                : useStorageState
                  ? "fixtures"
                  : authDiscovery?.ready
                    ? "discovered"
                    : undefined
          }
          authHint={
            pickDiscoveredStorageStateRel(authDiscovery) ||
            (e2eUsername.trim() && e2ePassword.trim()) ||
            useStorageState
              ? undefined
              : authDiscovery?.ready
                ? "Đã discover role nhưng chưa có storageState hợp lệ — trong panel E2E Job mở Auth → bấm «Đồng bộ auth (auto / AI)» (hoặc Override username/password)."
                : "Chưa Auth — trong panel E2E Job mở Auth → «Đồng bộ auth» hoặc Override username/password. Thiếu auth → Inspect login-wall / Verify fail cao (Gen vẫn chạy được)."
          }
          onGateChange={onGateChange}
        />

        {approved.length > 0 && !approved.some((t) => isE2eTestCaseType(t.type)) ? (
          <Alert
            type="info"
            showIcon
            title="Chưa có TC type=E2E"
            description="Đổi loại thành E2E tại Duyệt TC, rồi Approve."
          />
        ) : null}

        <Steps
          current={pipelineStep}
          style={{ marginTop: 8, marginBottom: 8, maxWidth: 640 }}
          items={[
            { title: "E2E Job" },
            { title: "Verify" },
            { title: "Apply" },
          ]}
        />

        <Card
          title={
            <Space>
              <RocketOutlined style={{ color: "#00b4d8" }} />
              E2E Job · AI CLI
            </Space>
          }
        >
          <Radio.Group
            value={inputMode}
            onChange={(e) => setInputMode(e.target.value as "requirement" | "single")}
            style={{ marginBottom: 16 }}
          >
            <Radio.Button value="requirement">
              📌 Theo Requirement (Batch tất cả TC E2E)
            </Radio.Button>
            <Radio.Button value="single">🎯 Theo Test Case (Từng TC lẻ)</Radio.Button>
          </Radio.Group>

          <Collapse
            size="small"
            style={{ marginBottom: 16 }}
            items={[
              {
                key: "env",
                label: "Môi trường · Target URL & trình duyệt",
                children: (
                  <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
                    <div>
                      <Typography.Text strong>Target URL</Typography.Text>
                      <Space.Compact style={{ width: "100%", marginTop: 6 }}>
                        <Input
                          value={targetUrl}
                          onChange={(e) => setTargetUrl(e.target.value)}
                          placeholder="http://localhost:3000"
                          disabled={busy}
                        />
                        <Button
                          icon={<SaveOutlined />}
                          disabled={busy || !project?.id}
                          onClick={() => {
                            void persistE2eEnv().then(() =>
                              message.success("Đã lưu env E2E vào project")
                            );
                          }}
                        >
                          Lưu
                        </Button>
                      </Space.Compact>
                    </div>
                    <div>
                      <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                        Chế độ trình duyệt khi Kiểm thử
                      </Typography.Text>
                      <Segmented
                        options={[
                          {
                            label: (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <DesktopOutlined /> Chromium · xem từng bước
                              </span>
                            ),
                            value: "headed",
                          },
                          {
                            label: (
                              <span style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
                                <EyeInvisibleOutlined /> Chạy ngầm (nhanh)
                              </span>
                            ),
                            value: "headless",
                          },
                        ]}
                        value={showBrowser ? "headed" : "headless"}
                        onChange={(v) => setShowBrowser(v === "headed")}
                        disabled={busy}
                      />
                      {showBrowser ? (
                        <Typography.Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
                          Chế độ cửa sổ dùng slowMo ~0.5s giữa mỗi thao tác (click/fill) để bạn theo dõi được từng bước.
                          Muốn chạy nhanh → chọn «Chạy ngầm».
                        </Typography.Text>
                      ) : null}
                    </div>
                    <Checkbox
                      checked={usePlaywrightInspect}
                      onChange={(e) => setUsePlaywrightInspect(e.target.checked)}
                      disabled={busy}
                    >
                      Quét DOM bằng Playwright Chromium (SPA)
                    </Checkbox>
                    <Checkbox
                      checked={useStorageState}
                      onChange={(e) => setUseStorageState(e.target.checked)}
                      disabled={busy}
                    >
                      Dùng storageState — chỉ bật khi đã có fixtures/storageState.json (tránh ENOENT)
                    </Checkbox>
                    <Alert
                      type={
                        authDiscovery?.ready || (e2eUsername.trim() && e2ePassword.trim())
                          ? "success"
                          : "info"
                      }
                      showIcon
                      style={{ marginBottom: 0 }}
                      title={
                        authDiscovery?.ready
                          ? `Auto auth sẵn sàng (${authDiscovery.roles?.filter((r) => r.hasUsername).length || 0} role)`
                          : e2eUsername.trim() && e2ePassword.trim()
                            ? "Dùng override thủ công"
                            : "Auto auth từ project (JHipster/i18n/.env) — không bắt buộc nhập tay"
                      }
                      description={
                        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                          <Typography.Text style={{ fontSize: 12 }}>
                            Hệ thống tự lấy user từ project (i18n login, JHipster admin/user,
                            <code> .ai-test/auth/&#123;role&#125;.json</code>, <code>.env</code>).
                            TC gắn <code>authRole</code> / <code>roles: a,b</code> → Verify chọn đúng
                            role; multi-role inject <code>E2E_ADMIN_*</code>, <code>E2E_USER_*</code>…
                          </Typography.Text>
                          {authDiscovery?.roles?.length ? (
                            <Typography.Text style={{ fontSize: 12 }}>
                              Roles:{" "}
                              {authDiscovery.roles
                                .filter((r) => r.hasUsername)
                                .map((r) => r.role)
                                .join(", ") || "(chưa có)"}
                            </Typography.Text>
                          ) : null}
                          {authDiscovery?.notes?.length ? (
                            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                              {authDiscovery.notes[authDiscovery.notes.length - 1]}
                            </Typography.Text>
                          ) : null}
                          <Space wrap size={8}>
                            <Button
                              size="small"
                              disabled={busy || !localPath || !project?.id}
                              onClick={() => {
                                void (async () => {
                                  setBusy(true);
                                  try {
                                    await runAuthSeed();
                                  } finally {
                                    setBusy(false);
                                  }
                                })();
                              }}
                            >
                              Đồng bộ auth (auto / AI)
                            </Button>
                            <Button
                              type="link"
                              size="small"
                              style={{ padding: 0, height: "auto" }}
                              onClick={() => setShowAuthOverride((v) => !v)}
                            >
                              {showAuthOverride ? "Ẩn override" : "Override thủ công (tuỳ chọn)"}
                            </Button>
                          </Space>
                          {showAuthOverride ? (
                            <Space.Compact style={{ width: "100%" }}>
                              <Input
                                value={e2eUsername}
                                onChange={(e) => setE2eUsername(e.target.value)}
                                placeholder="Override email/username"
                                disabled={busy}
                                autoComplete="off"
                                style={{ width: "50%" }}
                              />
                              <Input.Password
                                value={e2ePassword}
                                onChange={(e) => setE2ePassword(e.target.value)}
                                placeholder="Override mật khẩu"
                                disabled={busy}
                                autoComplete="new-password"
                                style={{ width: "50%" }}
                              />
                            </Space.Compact>
                          ) : null}
                        </Space>
                      }
                    />
                    <Button
                      size="small"
                      disabled={busy || !localPath || !targetUrl.trim()}
                      onClick={() => void runStepInspect()}
                    >
                      Quét DOM (Inspect) ngay
                    </Button>
                  </Space>
                ),
              },
            ]}
          />

          {inputMode === "requirement" ? (
            <Space orientation="vertical" size={14} style={{ width: "100%" }}>
              <div>
                <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                  1. Chọn Yêu cầu (Requirement) muốn chạy E2E hàng loạt:
                </Typography.Text>
                <Select
                  style={{ width: "100%" }}
                  size="large"
                  placeholder="— Chọn Requirement trong dự án —"
                  value={batchReqId || undefined}
                  options={requirementsList.map((r) => {
                    const linked = approved.filter((t) => tcBelongsToReq(t, r));
                    return {
                      value: r.id,
                      label: `📄 ${r.title} (${linked.length} TC E2E Approved)`,
                    };
                  })}
                  onChange={(id) => {
                    setBatchReqId(id);
                    setBatchResults([]);
                    const req = requirementsList.find((r) => r.id === id);
                    if (req) {
                      setBatchSelected(
                        approved.filter((t) => tcBelongsToReq(t, req)).map((t) => t.id)
                      );
                    } else {
                      setBatchSelected([]);
                    }
                  }}
                  showSearch
                  optionFilterProp="label"
                  disabled={busy}
                  notFoundContent={
                    <div style={{ padding: 12, textAlign: "center" }}>
                      <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
                        Chưa có Requirement.
                      </Typography.Text>
                      <Link to={ROUTES.requirement}>
                        <Button size="small" type="primary">
                          Sang Requirement
                        </Button>
                      </Link>
                    </div>
                  }
                />
              </div>

              {selectedBatchReq ? (
                <Alert
                  type="info"
                  showIcon
                  title={`Yêu cầu: ${selectedBatchReq.title}`}
                  description={
                    <>
                      Tự động sinh code E2E cho tất cả{" "}
                      <strong>{batchCandidates.length} TC E2E Approved</strong> thuộc Requirement
                      này (giống Unit batch).
                    </>
                  }
                />
              ) : (
                <Alert
                  type="warning"
                  showIcon
                  title="Chưa chọn Yêu cầu"
                  description="Chọn 1 Requirement ở ô trên để sinh E2E cho toàn bộ TC Approved."
                />
              )}

              {smokeReport ? (
                <Alert
                  type={smokeReport.readyForPerfPlan ? "success" : "warning"}
                  showIcon
                  style={{ marginTop: 12 }}
                  title={
                    smokeReport.readyForPerfPlan
                      ? `S5 Smoke · G1–G6 PASS · Gen ${smokeReport.taxonomy.genOk}/${smokeReport.taxonomy.total}`
                      : `S5 Smoke · Gen ${smokeReport.taxonomy.genOk}/${smokeReport.taxonomy.total} — chưa đủ gate`
                  }
                  description={
                    <Space orientation="vertical" size={4} style={{ width: "100%" }}>
                      <Typography.Text style={{ fontSize: 12 }}>
                        {smokeReport.taxonomy.summaryLine}
                      </Typography.Text>
                      <Space wrap size={[6, 6]}>
                        {smokeReport.gates.map((g) => (
                          <Tag
                            key={g.id}
                            color={
                              !g.measured ? "default" : g.pass ? "success" : "error"
                            }
                            title={g.detail}
                          >
                            {g.id} {!g.measured ? "—" : g.pass ? "PASS" : "FAIL"}
                          </Tag>
                        ))}
                      </Space>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        Chi tiết trong tab Log. G1–G6 PASS → mới mở Performance plan.
                      </Typography.Text>
                    </Space>
                  }
                />
              ) : null}

              {batchProgress ? (
                <>
                  <Progress
                    percent={Math.round((batchProgress.current / batchProgress.total) * 100)}
                    status={batchStatus === "paused" ? "normal" : "active"}
                    format={() => `${batchProgress.current}/${batchProgress.total}`}
                  />
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {batchStatus === "paused"
                      ? `Tạm dừng · đã ${batchProgress.current}/${batchProgress.total} · có thể Kiểm thử tất cả phần đã gen · chờ Tiếp tục`
                      : `Đang xử lý: ${batchProgress.label}`}
                  </Typography.Text>
                </>
              ) : null}

              <Space wrap>
                <Button
                  type="primary"
                  size="large"
                  icon={<ThunderboltOutlined />}
                  loading={busy && batchStatus === "running" && activePhase === "generate"}
                  disabled={
                    !aiReady ||
                    !selectedBatchReq ||
                    batchCandidates.length === 0 ||
                    !localPath ||
                    batchStatus === "paused" ||
                    (busy && batchStatus === "running")
                  }
                  onClick={() => {
                    setBatchSelected(batchCandidates.map((t) => t.id));
                    void runStepGenerateBatch();
                  }}
                >
                  ⚡ Chạy E2E Job · Tất cả TC E2E trong Requirement ({batchCandidates.length} TC)
                </Button>
                <Button
                  size="large"
                  disabled={
                    !aiReady ||
                    !localPath ||
                    batchStatus === "paused" ||
                    (busy && batchStatus === "running") ||
                    (selectedBatchReq ? batchCandidates.length === 0 : approved.length === 0)
                  }
                  onClick={() => void runStepSmoke()}
                >
                  S5 Smoke · 10 TC + taxonomy + Verify
                </Button>
                {batchStatus === "running" ? (
                  <Button icon={<PauseCircleOutlined />} onClick={() => pauseE2eBatch()}>
                    Dừng / Tạm dừng
                  </Button>
                ) : null}
                {batchStatus === "paused" ? (
                  <Space wrap>
                    <Button type="primary" icon={<PlayCircleOutlined />} onClick={() => resumeE2eBatch()}>
                      Tiếp tục Generate
                    </Button>
                    <Button
                      icon={<PlayCircleOutlined />}
                      disabled={batchGenItems.length === 0}
                      onClick={() => void runStepVerifyBatch()}
                    >
                      Kiểm thử tất cả phần đã gen ({batchGenItems.length})
                    </Button>
                  </Space>
                ) : null}
              </Space>

              {batchResults.length > 0 ? (
                <E2eBatchConsole
                  variant="table"
                  title="1. Kết quả Generate (batch)"
                  rows={batchResults}
                  busy={busy}
                  batchRunStatus={batchStatus}
                  projectRoot={localPath}
                  generateFailCount={batchFailCount}
                  onRetryGenerateFails={() => void runStepGenerateBatch()}
                />
              ) : null}
            </Space>
          ) : (
            <Space orientation="vertical" size={14} style={{ width: "100%" }}>
              <div>
                <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                  1. Chọn Yêu cầu để lọc Test Case (tuỳ chọn):
                </Typography.Text>
                <Select
                  style={{ width: "100%", marginBottom: 12 }}
                  placeholder="— Tất cả Requirement —"
                  value={batchReqId || "__all__"}
                  options={[
                    { value: "__all__", label: `📦 Tất cả Requirement (${requirementsList.length})` },
                    ...requirementsList.map((r) => {
                      const n = approved.filter((t) => tcBelongsToReq(t, r)).length;
                      return { value: r.id, label: `📄 ${r.title} (${n} TC E2E)` };
                    }),
                  ]}
                  onChange={(id) => setBatchReqId(id === "__all__" ? undefined : id)}
                  disabled={busy}
                />
                <Typography.Text strong style={{ display: "block", marginBottom: 6 }}>
                  2. Chọn Test Case E2E Approved:
                </Typography.Text>
                <Select
                  style={{ width: "100%" }}
                  placeholder="Chọn TC E2E"
                  value={testCaseId || undefined}
                  options={singleTcOptions.map((t) => ({
                    value: t.id,
                    label: `${t.title}${t.module ? ` · ${t.module}` : ""}`,
                  }))}
                  onChange={(id) => {
                    setTestCaseId(id);
                    syncUrl(id);
                  }}
                  showSearch
                  optionFilterProp="label"
                  disabled={busy}
                />
              </div>
              <Space wrap>
                <Button
                  type="primary"
                  size="large"
                  icon={<ThunderboltOutlined />}
                  loading={busy && activePhase === "generate"}
                  disabled={busy || !testCaseId || !aiReady || !localPath}
                  onClick={() => void runStepGenerateSingle()}
                >
                  ⚡ Chạy E2E Job
                </Button>
                {files.length > 0 && run.jobPassed == null ? (
                  <Tag color="processing">Đã Generate · tiếp theo: Kiểm thử</Tag>
                ) : null}
              </Space>
            </Space>
          )}
        </Card>

        {(files.length > 0 || genOkCount > 0) && (
          <>
            {inputMode === "requirement" && batchResults.length > 0 ? (
              <E2eBatchStagingPreview
                rows={batchResults}
                genItems={batchGenItems}
                files={files}
                runId={staging?.runId || batchGenItems[0]?.runId}
                selectedPath={stagingPreviewPath}
                onSelectPath={setStagingPreviewPath}
                onSaveFile={onSaveStagingFile}
                onDeleteFile={onDeleteStagingFile}
              />
            ) : files.length > 0 ? (
              <E2eBatchStagingPreview
                rows={
                  batchResults.length
                    ? batchResults
                    : [
                        {
                          key: testCaseId || "single",
                          testCaseId: testCaseId || "single",
                          title: selected?.title || "E2E",
                          status: "ok",
                          files: files.length,
                          runId: staging?.runId,
                        },
                      ]
                }
                genItems={
                  batchGenItems.length
                    ? batchGenItems
                    : [
                        {
                          testCaseId: testCaseId || "single",
                          title: selected?.title || "E2E",
                          runId: staging?.runId || "single",
                          primarySpecPath: files.find((f) => f.kind === "spec")?.path || "",
                          files,
                        },
                      ]
                }
                files={files}
                runId={staging?.runId}
                selectedPath={stagingPreviewPath}
                onSelectPath={setStagingPreviewPath}
                onSaveFile={onSaveStagingFile}
                onDeleteFile={onDeleteStagingFile}
              />
            ) : null}
            {inputMode === "requirement" && batchResults.length > 0 ? (
              <E2eVerifyApplyConsole
                rows={batchResults}
                fileCount={files.length}
                genOkCount={genOkCount}
                busy={busy}
                batchRunStatus={batchStatus}
                jobPassed={run.jobPassed}
                hasStaging={!!staging}
                applied={appliedPaths.length > 0}
                canHeal={run.jobPassed === false}
                canApply={run.jobPassed === true && !!staging && appliedPaths.length === 0}
                verifyLoading={busy && activePhase === "headless"}
                healLoading={busy && activePhase === "heal"}
                applyLoading={applyBusy}
                metrics={verifyMetrics}
                onVerify={() => void runStepVerifyBatch()}
                onHeal={() => void runStepHealBatch()}
                onApply={() => void onApplyStaging()}
                onDiscard={() => void onDiscardStaging()}
              />
            ) : (
              <E2eVerifyApplyConsole
                rows={
                  batchResults.length
                    ? batchResults
                    : [
                        {
                          key: testCaseId || "single",
                          testCaseId: testCaseId || "single",
                          title: selected?.title || "E2E",
                          status: files.length > 0 ? "ok" : "fail",
                          files: files.length,
                          verifyStatus:
                            run.jobPassed === true
                              ? "pass"
                              : run.jobPassed === false
                                ? "fail"
                                : "pending",
                          failCategory:
                            run.jobPassed === false
                              ? verifyMetrics?.rows.find((r) => r.status !== "ok")
                                  ?.failCategory
                              : undefined,
                        },
                      ]
                }
                fileCount={files.length}
                genOkCount={files.length > 0 ? 1 : 0}
                busy={busy}
                batchRunStatus={batchStatus}
                jobPassed={run.jobPassed}
                hasStaging={!!staging}
                applied={appliedPaths.length > 0}
                canHeal={run.jobPassed === false}
                canApply={run.jobPassed === true && !!staging && appliedPaths.length === 0}
                metrics={verifyMetrics}
                verifyLoading={busy && activePhase === "headless"}
                healLoading={busy && activePhase === "heal"}
                applyLoading={applyBusy}
                onVerify={() => void runStepVerifySingle(false)}
                onHeal={() => void runStepVerifySingle(true)}
                onApply={() => void onApplyStaging()}
                onDiscard={() => void onDiscardStaging()}
              />
            )}
          </>
        )}

        <E2ePipelineStrip
          run={run}
          busy={busy}
          activePhase={activePhase}
          onSelectPhase={selectPhase}
          showBrowser={showBrowser}
        />

        {busy && (activePhase === "headless" || activePhase === "heal") ? (
          <Alert
            type={showBrowser ? "info" : "warning"}
            showIcon
            message={
              showBrowser
                ? "Đang mở Chromium · chậm từng bước (slowMo) — theo dõi cửa sổ đến khi test xong."
                : "Đang chạy test headless (không cửa sổ)."
            }
          />
        ) : null}

        {run.jobPassed === true && staging && appliedPaths.length === 0 ? (
          <Alert
            type="success"
            showIcon
            title="Sẵn sàng Apply"
            description="Kiểm thử PASS — bấm Apply trong card Verify & Apply."
          />
        ) : null}

        {staging ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0, fontSize: 12 }}>
            Staging: <code>{stagingDirHint(staging.runId)}</code>
          </Typography.Paragraph>
        ) : null}

        <E2eResultTabs
          files={files}
          run={run}
          activePhase={activePhase}
          onActivePhaseChange={setActivePhase}
          tab={resultTab}
          onTabChange={setResultTab}
          projectRoot={localPath}
          onFilesChange={setFiles}
          editable={Boolean(staging) && appliedPaths.length === 0}
        />
      </Space>
    </div>
  );
}
