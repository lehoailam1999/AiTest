import { useMemo, useRef, useState, type ReactElement } from "react";
import {
  App,
  Button,
  Card,
  Collapse,
  Modal,
  Progress,
  Space,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { BatchRunControl, BatchRunStatus } from "../../lib/batchRunControl";
import { loadManifest, saveManifest } from "../../lib/unitWorkspace/manager";
import { applyManyWorkspacesToRepo } from "../../lib/unitWorkspace/applyManager";
import { runCombinedBatchVerify } from "../../lib/unitWorkspace/combinedBatchVerify";
import { discardWorkspaceRuns } from "../../lib/unitWorkspace/discardManager";
import {
  emptiedDraftRowCount,
  rowsWithPendingDraft,
  type DraftEntryCounts,
} from "../../lib/unitWorkspace/draftInventory";
import {
  batchVerifyPass,
  extractFailedPathTokens,
  extractUnitFailureExcerpt,
} from "../../lib/unitWorkspace/batchVerifyFailureMap";
import {
  formatVerifyStagesLog,
  readErrorLogFile,
  saveErrorLogFile,
  unitErrorLogRel,
  unitVerifyLogRel,
} from "../../lib/unitWorkspace/errorLogStore";
import {
  formatDurationMs,
  parseTestRunSummary,
} from "../../lib/unitWorkspace/parseTestRunSummary";
import type {
  UnitWorkspaceManifest,
  VerifyStageResult,
} from "../../lib/unitWorkspace/types";
import { suggestWorkspaceVerifyCommands } from "../../lib/stackHints";
import type { ProjectMeta, StackInspect, TestCase } from "../../api/types";
import { isTauri } from "../../tauri/bridge";
import { labelOf, priorityLabel, typeLabel } from "../../i18n/labels";
import { unitJobMetricByJobId } from "../../lib/unitJobMetrics";

/** Queue notes for batch Generate list (Ghi chú column). */
export const BATCH_NOTE_WAITING = "Đang chờ…";
export const BATCH_NOTE_PAUSED = "Tạm dừng — chờ Tiếp tục";
export const BATCH_NOTE_RUNNING = "Đang chạy…";

/**
 * Long generate/verify errors used to widen the whole page: a `max-content`
 * table cannot wrap them, so the cell must cap its own width instead.
 */
function ClampedCell({
  text,
  lines,
}: {
  text: string;
  lines: 1 | 2;
}): ReactElement {
  return (
    <Tooltip title={text} placement="topLeft">
      <div className={`batch-clamp batch-clamp-${lines}`}>{text}</div>
    </Tooltip>
  );
}

export function isBatchQueueNote(error?: string | null): boolean {
  return (
    error === BATCH_NOTE_WAITING ||
    error === BATCH_NOTE_PAUSED ||
    error === BATCH_NOTE_RUNNING
  );
}

export function isBatchWaitingOrPaused(error?: string | null): boolean {
  return error === BATCH_NOTE_WAITING || error === BATCH_NOTE_PAUSED;
}

/** Mark not-yet-started rows as paused (current RUNNING row keeps running until done). */
export function markBatchRowsPaused(rows: BatchPipelineRow[]): BatchPipelineRow[] {
  return rows.map((r) =>
    r.status === "fail" && r.error === BATCH_NOTE_WAITING
      ? { ...r, error: BATCH_NOTE_PAUSED }
      : r
  );
}

/** Restore paused rows to waiting before resume. */
export function markBatchRowsResumed(rows: BatchPipelineRow[]): BatchPipelineRow[] {
  return rows.map((r) =>
    r.status === "fail" && r.error === BATCH_NOTE_PAUSED
      ? { ...r, error: BATCH_NOTE_WAITING }
      : r
  );
}

/** Snapshot TC fields onto a batch row for «Chi tiết Test case». */
export function batchTcSnapshot(tc: Pick<
  TestCase,
  | "module"
  | "precondition"
  | "steps"
  | "expectedResult"
  | "testData"
  | "priority"
  | "severity"
  | "type"
>): Pick<
  BatchPipelineRow,
  | "module"
  | "precondition"
  | "steps"
  | "expectedResult"
  | "testData"
  | "priority"
  | "severity"
  | "type"
> {
  return {
    module: tc.module ?? undefined,
    precondition: tc.precondition ?? undefined,
    steps: tc.steps,
    expectedResult: tc.expectedResult,
    testData: tc.testData ?? undefined,
    priority: tc.priority,
    severity: tc.severity,
    type: tc.type,
  };
}

export type BatchPipelineRow = {
  key: string;
  testCaseId: string;
  title: string;
  /** Generate ok/fail — queue rows use fail + queue note in `error`. */
  status: "ok" | "fail";
  error?: string;
  /** Unit jobId (Gen → Verify correlation id) for performance / diagnostics. */
  unitJobId?: string | null;
  /** Full generate/verify error body for «Chi tiết lỗi» (may be longer than Ghi chú). */
  errorDetail?: string;
  /** Relative path under project root where error log was saved (e.g. …/logs/error.log). */
  errorLogRel?: string;
  workspaceRunId?: string;
  packagePrefix?: string;
  verifyStatus?: "pending" | "pass" | "fail" | "skipped";
  applyStatus?: "pending" | "done" | "skipped";
  /** TC snapshot — Chi tiết Test case */
  module?: string;
  precondition?: string;
  steps?: string;
  expectedResult?: string;
  testData?: string;
  priority?: string;
  severity?: string;
  type?: string;
};

type BatchVerifyLog = {
  ranAt: string;
  success: boolean;
  stages: VerifyStageResult[];
  units: Array<{
    testCaseId: string;
    title: string;
    verifyStatus: "pass" | "fail";
    workspaceRunId?: string;
    errorDetail?: string;
    errorLogRel?: string;
  }>;
};

type Props = {
  title: string;
  rows: BatchPipelineRow[];
  onRowsChange: (rows: BatchPipelineRow[]) => void;
  projectRoot: string;
  language?: string | null;
  framework?: string | null;
  meta?: ProjectMeta | null;
  stackInspect?: StackInspect | null;
  busy: boolean;
  onBusy: (v: boolean) => void;
  batchControl: BatchRunControl;
  batchRunStatus: BatchRunStatus;
  /** Optional: re-run generate fails only */
  onRetryGenerateFails?: () => void;
  generateFailCount?: number;
  onDiscarded?: () => void;
  /**
   * rowKey → draft entries còn lại (Sửa/Xóa trong Tool draft làm số này đổi).
   * Thiếu key = chưa load manifest → coi như còn việc, không chặn Verify/Update.
   */
  draftEntryCounts?: DraftEntryCounts;
  /**
   * table — chỉ bảng trạng thái (trong card Generate)
   * verifyApply — mục 3: nút Verify/Update/Hủy (dưới Tool draft preview)
   */
  variant?: "table" | "verifyApply";
};

/**
 * U5c — Batch Verify / Apply queue under Requirement or Module results table.
 */
export function BatchRunConsole({
  title,
  rows,
  onRowsChange,
  projectRoot,
  language,
  framework,
  meta,
  stackInspect,
  busy,
  onBusy,
  batchControl,
  batchRunStatus,
  onRetryGenerateFails,
  generateFailCount = 0,
  onDiscarded,
  draftEntryCounts,
  variant = "table",
}: Props) {
  const { message, modal } = App.useApp();
  const logAnchorRef = useRef<HTMLDivElement | null>(null);
  const [progress, setProgress] = useState<{
    current: number;
    total: number;
    label: string;
    phase: "verify" | "apply" | "discard";
  } | null>(null);
  const [filter, setFilter] = useState<"all" | "unverified" | "fail">("all");
  const [verifyLog, setVerifyLog] = useState<BatchVerifyLog | null>(null);
  const [logTab, setLogTab] = useState<"units" | "summary" | "full">("units");
  const [activeLogStage, setActiveLogStage] = useState<string>("test");
  const [tcDetail, setTcDetail] = useState<BatchPipelineRow | null>(null);
  const [errorDetail, setErrorDetail] = useState<{
    row: BatchPipelineRow;
    body: string;
  } | null>(null);

  const unitPerfMap = useMemo(() => {
    const map = new Map<string, ReturnType<typeof unitJobMetricByJobId>>();
    for (const r of rows) {
      const id = (r.unitJobId || "").trim();
      if (!id) continue;
      if (map.has(id)) continue;
      map.set(id, unitJobMetricByJobId(id));
    }
    return map;
  }, [rows]);

  const visible = useMemo(() => {
    if (filter === "unverified") {
      return rows.filter(
        (r) =>
          r.status === "ok" &&
          r.workspaceRunId &&
          (!r.verifyStatus || r.verifyStatus === "pending")
      );
    }
    if (filter === "fail") {
      return rows.filter(
        (r) => r.status === "fail" || r.verifyStatus === "fail"
      );
    }
    return rows;
  }, [rows, filter]);

  const verifyDone = rows.filter((r) => r.verifyStatus === "pass").length;
  const applyDone = rows.filter((r) => r.applyStatus === "done").length;
  const genOkRows = useMemo(
    () => rowsWithPendingDraft(rows, draftEntryCounts),
    [rows, draftEntryCounts]
  );
  const genOk = genOkRows.length;
  const emptiedDrafts = useMemo(
    () => emptiedDraftRowCount(rows, draftEntryCounts),
    [rows, draftEntryCounts]
  );

  const logSummary = useMemo(
    () =>
      parseTestRunSummary({
        stages: verifyLog?.stages,
        framework,
        language,
      }),
    [verifyLog?.stages, framework, language]
  );

  /** Prefer unit-job counts (table) over raw Jest line — batch may overwrite same path. */
  const unitSummary = useMemo(() => {
    const units = verifyLog?.units || [];
    if (!units.length) return null;
    const passed = units.filter((u) => u.verifyStatus === "pass").length;
    const failed = units.filter((u) => u.verifyStatus === "fail").length;
    return { passed, failed, total: units.length };
  }, [verifyLog?.units]);

  const runnerMismatch = Boolean(
    unitSummary &&
      logSummary.hasCounts &&
      logSummary.total > 0 &&
      logSummary.total < unitSummary.total
  );

  /**
   * Khi Generate đang tạm dừng: giữ batchControl + busy, chỉ Verify/Apply phần đã gen.
   * Không start/reset — tránh đánh thức / kết thúc sớm vòng Generate.
   */
  function beginSidePhase(): { preserveGeneratePause: boolean } {
    const preserveGeneratePause = batchControl.getStatus() === "paused";
    onBusy(true);
    if (!preserveGeneratePause) batchControl.start();
    return { preserveGeneratePause };
  }

  function endSidePhase(preserveGeneratePause: boolean) {
    setProgress(null);
    if (preserveGeneratePause) {
      // Generate vẫn chờ «Tiếp tục» — giữ paused + busy.
      if (batchControl.getStatus() === "running") batchControl.pause();
      return;
    }
    batchControl.reset();
    onBusy(false);
  }

  async function runVerifyAll() {
    if (!isTauri()) return;
    const work = genOkRows;
    if (work.length === 0) {
      message.info(
        emptiedDrafts > 0
          ? "Mọi Tool draft đã bị xóa hết file — Gen lại trước khi Verify."
          : "Không có job Generate OK để Verify."
      );
      return;
    }
    const { preserveGeneratePause } = beginSidePhase();
    setProgress({
      current: 0,
      total: work.length,
      label: preserveGeneratePause
        ? `Verify ${work.length} unit đã gen (Generate đang tạm dừng)`
        : `Nạp ${work.length} Tool draft → chạy 1 lệnh test`,
      phase: "verify",
    });
    try {
      const manifests = [];
      for (const row of work) {
        const m = await loadManifest(projectRoot, row.workspaceRunId!, row.packagePrefix);
        if (m) manifests.push(m);
      }
      if (manifests.length === 0) {
        message.error("Không load được Tool draft nào.");
        return;
      }
      // Resolve commands from real overlay paths (batch UI often has targetRelPaths=[]).
      const targetRelPaths = manifests.flatMap((m) =>
        m.files.filter((f) => f.op !== "delete").map((f) => f.targetRel)
      );
      const packagePrefix =
        manifests.find((m) => m.packagePrefix)?.packagePrefix ||
        rows.find((r) => r.packagePrefix)?.packagePrefix;
      const verifyHints = suggestWorkspaceVerifyCommands({
        language,
        framework: framework === "auto" ? "" : framework,
        meta,
        targetRelPaths,
        packagePrefix,
        stackInspect,
      });
      if (!verifyHints.test.trim()) {
        message.error("Chưa có lệnh test — kiểm tra framework / stack.");
        return;
      }
      setProgress({
        current: manifests.length,
        total: work.length,
        label: "Đang chạy test toàn bộ AItest…",
        phase: "verify",
      });
      const result = await runCombinedBatchVerify({
        projectRoot,
        manifests,
        compileCommand: verifyHints.compile,
        testCommand: verifyHints.test,
      });
      const byRun = new Map(result.updatedManifests.map((m) => [m.runId, m]));
      const testStageLog =
        result.stages.find((s) => s.stage === "test")?.logExcerpt || "";
      const failedTokens = extractFailedPathTokens(testStageLog);
      const hasMappedFailure = failedTokens.length > 0;

      const promotions: Promise<void>[] = [];
      const fullVerifyLog = formatVerifyStagesLog(result.stages);
      const nextRows: BatchPipelineRow[] = [];
      const workKeys = new Set(work.map((r) => r.key));
      for (const r of rows) {
        if (!r.workspaceRunId || r.status !== "ok") {
          nextRows.push({ ...r, verifyStatus: "skipped" as const });
          continue;
        }
        if (!workKeys.has(r.key)) {
          nextRows.push({
            ...r,
            verifyStatus: "skipped" as const,
            error: "Tool draft trống — đã xóa hết file gen",
          });
          continue;
        }
        const m = byRun.get(r.workspaceRunId);
        if (!m) {
          nextRows.push({
            ...r,
            verifyStatus: "fail" as const,
            error: "Thiếu Tool draft sau verify",
            errorDetail: "Thiếu Tool draft sau verify",
          });
          continue;
        }
        const pass = batchVerifyPass(r, m, failedTokens, hasMappedFailure);
        if (pass && !m.verify?.overallPass) {
          promotions.push(
            saveManifest(projectRoot, {
              ...m,
              status: "pass",
              verify: {
                ...(m.verify || {
                  ranAt: new Date().toISOString(),
                  overallPass: false,
                  stages: [],
                }),
                overallPass: true,
              },
            })
          );
        }
        const excerpt = pass
          ? undefined
          : extractUnitFailureExcerpt(testStageLog, r, m, failedTokens) ||
            (hasMappedFailure
              ? undefined
              : testStageLog.trim().slice(0, 6000) || undefined);
        let errorLogRel: string | undefined;
        try {
          await saveErrorLogFile(
            projectRoot,
            unitVerifyLogRel(r.workspaceRunId, r.packagePrefix || m.packagePrefix),
            fullVerifyLog
          );
          if (!pass) {
            const errBody =
              excerpt?.trim() ||
              `Verify FAIL (batch)\n\n${fullVerifyLog.slice(-12_000)}`;
            errorLogRel = await saveErrorLogFile(
              projectRoot,
              unitErrorLogRel(r.workspaceRunId, r.packagePrefix || m.packagePrefix),
              errBody
            );
          }
        } catch {
          // best-effort persist
        }
        nextRows.push({
          ...r,
          verifyStatus: (pass ? "pass" : "fail") as "pass" | "fail",
          error: pass ? undefined : "Verify FAIL (batch)",
          errorDetail: pass
            ? undefined
            : excerpt || fullVerifyLog.slice(-12_000) || r.errorDetail,
          errorLogRel: pass ? undefined : errorLogRel || r.errorLogRel,
          applyStatus: r.applyStatus ?? ("pending" as const),
        });
      }
      if (promotions.length) {
        await Promise.all(promotions);
      }
      onRowsChange(nextRows);

      const units = work.map((r) => {
        const m = byRun.get(r.workspaceRunId!);
        const pass = batchVerifyPass(r, m, failedTokens, hasMappedFailure);
        const next = nextRows.find((x) => x.key === r.key || x.workspaceRunId === r.workspaceRunId);
        const excerpt = pass
          ? undefined
          : extractUnitFailureExcerpt(testStageLog, r, m, failedTokens) ||
            next?.errorDetail ||
            undefined;
        return {
          testCaseId: r.testCaseId,
          title: r.title,
          verifyStatus: (pass ? "pass" : "fail") as "pass" | "fail",
          workspaceRunId: r.workspaceRunId,
          errorDetail: excerpt,
          errorLogRel: next?.errorLogRel,
        };
      });
      setVerifyLog({
        ranAt: new Date().toISOString(),
        success: result.success,
        stages: result.stages,
        units,
      });
      setLogTab(result.success ? "units" : "full");
      setActiveLogStage(
        result.stages.some((s) => s.stage === "test" && !s.success)
          ? "test"
          : result.stages.find((s) => !s.success)?.stage || "test"
      );
      requestAnimationFrame(() => {
        logAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
      });

      if (result.success) {
        message.success(
          `Verify PASS · ${manifests.length} job · 1 lệnh test cho toàn bộ unit đã sinh`
        );
      } else {
        message.warning(
          `Verify FAIL · đã chạy chung ${manifests.length} unit — xem log bên dưới`
        );
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Verify batch thất bại");
    } finally {
      endSidePhase(preserveGeneratePause);
    }
  }

  async function runDiscardAll() {
    if (!isTauri()) return;
    const work = rows.filter((r) => r.workspaceRunId);
    if (work.length === 0) {
      message.info("Không có Tool draft để hủy.");
      return;
    }
    modal.confirm({
      title: `Hủy bỏ ${work.length} Unit Job?`,
      content:
        "Không Update/Apply. Chỉ xóa Tool draft; source AItest/ không thay đổi.",
      okText: "Hủy bỏ & xóa file gen",
      okType: "danger",
      onOk: async () => {
        const preserveGeneratePause = batchControl.getStatus() === "paused";
        onBusy(true);
        setProgress({
          current: 0,
          total: work.length,
          label: "Đang hủy…",
          phase: "discard",
        });
        try {
          const res = await discardWorkspaceRuns(
            projectRoot,
            work.map((r) => ({
              runId: r.workspaceRunId!,
              packagePrefix: r.packagePrefix,
            }))
          );
          onRowsChange(
            rows.map((r) =>
              r.workspaceRunId
                ? {
                    ...r,
                    status: "fail" as const,
                    error: "Đã hủy bỏ",
                    verifyStatus: "skipped" as const,
                    applyStatus: "skipped" as const,
                    workspaceRunId: undefined,
                  }
                : r
            )
          );
          setVerifyLog(null);
          onDiscarded?.();
          message.success(
            `Đã hủy ${res.runs} job · xóa ${res.removedTargets.length} file trên AItest/ (nếu có)`
          );
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Hủy bỏ thất bại");
        } finally {
          setProgress(null);
          if (!preserveGeneratePause) onBusy(false);
        }
      },
    });
  }

  async function runApplyAll() {
    if (!isTauri()) return;
    const work = rows.filter((r) => r.verifyStatus === "pass");
    const failedUnits = rows
      .filter(
        (r) =>
          r.status === "fail" &&
          !isBatchQueueNote(r.error) &&
          r.error !== "Đã hủy bỏ"
      )
      .map((r) => ({
        // row.key is the stable TestCase id stored in UnitWorkspaceManifest.
        testCaseId: r.key,
        packagePrefix: r.packagePrefix,
      }));
    if (work.length === 0) {
      message.info("Chưa có dòng Verify PASS để Apply.");
      return;
    }
    modal.confirm({
      title: `Apply ${work.length} job vào AItest/?`,
      content:
        `Update đủ file vào AItest/UnitTest, rồi dọn Tool draft. ` +
        (failedUnits.length
          ? `${failedUnits.length} TC Generate lỗi sẽ tự xóa file test cũ do chính TC đó sở hữu. `
          : "") +
        "File dùng chung với TC thành công được giữ nguyên. Không đụng production src.",
      okText: "Apply tất cả",
      onOk: async () => {
        const { preserveGeneratePause } = beginSidePhase();
        setProgress({
          current: 0,
          total: work.length,
          label: "Chuẩn bị overlay…",
          phase: "apply",
        });
        const map = new Map(rows.map((r) => [r.key, r]));
        try {
          if (!preserveGeneratePause) await batchControl.waitIfPaused();

          const toApply: UnitWorkspaceManifest[] = [];
          const runKey = new Map<string, string>(); // runId → row.key

          for (const row of work) {
            const cur = map.get(row.key) || row;
            if (!cur.workspaceRunId) {
              map.set(row.key, { ...cur, applyStatus: "skipped" });
              continue;
            }
            try {
              const manifest = await loadManifest(
                projectRoot,
                cur.workspaceRunId,
                cur.packagePrefix
              );
              if (!manifest) {
                map.set(row.key, {
                  ...cur,
                  applyStatus: "skipped",
                  error: "Thiếu Tool draft",
                });
                continue;
              }
              // Gate PASS nằm trong applyMany (prepare) — tránh check trùng ở UI.
              toApply.push(manifest);
              runKey.set(manifest.runId, row.key);
            } catch (e) {
              map.set(row.key, {
                ...cur,
                applyStatus: "skipped",
                error: e instanceof Error ? e.message : "Load Tool draft lỗi",
              });
            }
          }
          onRowsChange([...map.values()]);

          if (toApply.length === 0) {
            message.warning("Không có Tool draft để Update.");
            return;
          }

          setProgress({
            current: toApply.length,
            total: work.length,
            label: `Ghi ${toApply.length} overlay → AItest/`,
            phase: "apply",
          });

          const {
            results,
            deletedFailedPaths,
            failedCleanupErrors,
          } = await applyManyWorkspacesToRepo(projectRoot, toApply, {
            failedUnits,
          });
          for (const r of results) {
            const key = runKey.get(r.runId);
            if (!key) continue;
            const cur = map.get(key);
            if (!cur) continue;
            if (r.ok) {
              map.set(key, {
                ...cur,
                applyStatus: "done",
                error: undefined,
                // Tool draft was removed — clear pointer so UI does not reload ghosts.
                workspaceRunId: undefined,
              });
            } else {
              map.set(key, {
                ...cur,
                applyStatus: "skipped",
                error: r.error || "Apply lỗi",
              });
            }
          }
          onRowsChange([...map.values()]);
          const okN = results.filter((r) => r.ok).length;
          if (failedCleanupErrors.length) {
            message.warning(
              `Đã Update ${okN}/${toApply.length} job; xóa ${deletedFailedPaths.length} file của TC lỗi, ` +
                `${failedCleanupErrors.length} file chưa xóa được và sẽ thử lại ở lần Apply sau.`
            );
          } else {
            message.success(
              `Đã Update ${okN}/${toApply.length} job vào AItest/UnitTest · ` +
                `xóa ${deletedFailedPaths.length} file của ${failedUnits.length} TC Generate lỗi · ` +
                "đã dọn Tool draft"
            );
          }
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Apply batch lỗi");
        } finally {
          endSidePhase(preserveGeneratePause);
        }
      },
    });
  }

  if (rows.length === 0) return null;

  function resolveErrorBody(r: BatchPipelineRow): string {
    if (r.errorDetail?.trim()) return r.errorDetail.trim();
    if (r.error && !isBatchQueueNote(r.error)) return r.error;
    return "";
  }

  async function openErrorDetail(r: BatchPipelineRow) {
    let body = resolveErrorBody(r);
    if (r.errorLogRel && isTauri()) {
      try {
        const fromDisk = await readErrorLogFile(projectRoot, r.errorLogRel);
        if (fromDisk?.trim()) body = fromDisk.trim();
      } catch {
        // keep in-memory body
      }
    }
    if (!body) {
      message.info("Chưa có chi tiết lỗi cho dòng này.");
      return;
    }
    setErrorDetail({ row: r, body });
  }

  const detailModals = (
    <>
      <Modal
        open={!!tcDetail}
        title={tcDetail ? `Chi tiết ${tcDetail.testCaseId}` : "Chi tiết TC"}
        onCancel={() => setTcDetail(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setTcDetail(null)}>
            Đóng
          </Button>,
        ]}
        width={640}
      >
        {tcDetail ? (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Tiêu đề</Typography.Text>
              <div style={{ marginTop: 4 }}>{tcDetail.title || "—"}</div>
            </div>
            <Space
              wrap
              style={{ width: "100%", marginBottom: 4 }}
              styles={{ item: { flex: 1, minWidth: 160 } }}
            >
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Module</Typography.Text>
                <div style={{ marginTop: 4 }}>{tcDetail.module?.trim() || "—"}</div>
              </div>
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Loại (engine)</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {labelOf(typeLabel, tcDetail.type || "") || tcDetail.type || "—"}
                </div>
              </div>
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Ưu tiên</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {labelOf(priorityLabel, tcDetail.priority || "") ||
                    tcDetail.priority ||
                    "—"}
                </div>
              </div>
            </Space>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Tiền điều kiện</Typography.Text>
              <pre className="detail-block">
                {tcDetail.precondition?.trim() || "—"}
              </pre>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Các bước</Typography.Text>
              <pre className="detail-block">{tcDetail.steps?.trim() || "—"}</pre>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Kết quả mong đợi</Typography.Text>
              <pre className="detail-block">
                {tcDetail.expectedResult?.trim() || "—"}
              </pre>
            </div>
            <div style={{ marginBottom: 0 }}>
              <Typography.Text type="secondary">Test data</Typography.Text>
              <pre className="detail-block">{tcDetail.testData?.trim() || "—"}</pre>
            </div>
            {!tcDetail.steps?.trim() && !tcDetail.expectedResult?.trim() ? (
              <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
                Chưa có snapshot nội dung TC trên dòng này — chạy lại Generate batch để gắn chi
                tiết.
              </Typography.Text>
            ) : null}
          </div>
        ) : null}
      </Modal>
      <Modal
        open={!!errorDetail}
        title={
          errorDetail
            ? `Chi tiết lỗi · ${errorDetail.row.testCaseId} · ${errorDetail.row.title}`
            : "Chi tiết lỗi"
        }
        onCancel={() => setErrorDetail(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setErrorDetail(null)}>
            Đóng
          </Button>,
        ]}
        width={780}
      >
        {errorDetail?.row.errorLogRel ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
            Đã lưu:{" "}
            <Typography.Text code style={{ fontSize: 11 }}>
              {errorDetail.row.errorLogRel}
            </Typography.Text>
          </Typography.Paragraph>
        ) : null}
        <pre
          className="detail-block"
          style={{ maxHeight: 460, overflow: "auto", margin: 0 }}
        >
          {errorDetail?.body || ""}
        </pre>
      </Modal>
    </>
  );

  const actionColumn = {
    title: "Chi tiết",
    width: 180,
    fixed: "right" as const,
    render: (_: unknown, r: BatchPipelineRow) => {
      const hasErr = Boolean(resolveErrorBody(r) || r.errorLogRel);
      return (
        <Space size={0} wrap>
          <Button
            type="link"
            size="small"
            icon={<EyeOutlined />}
            onClick={() => setTcDetail(r)}
          >
            Test case
          </Button>
          <Button
            type="link"
            size="small"
            danger={hasErr}
            disabled={!hasErr}
            icon={<WarningOutlined />}
            onClick={() => void openErrorDetail(r)}
          >
            Lỗi
          </Button>
        </Space>
      );
    },
  };

  const statusSummary = (
    <Space wrap style={{ marginBottom: variant === "table" ? 8 : 12 }}>
      <Typography.Text type="secondary">
        Gen OK {genOk}/{rows.length}
        {" · "}
        Verify {verifyDone}/{genOk}
        {" · "}
        Apply {applyDone}/{verifyDone || genOk}
      </Typography.Text>
      {emptiedDrafts > 0 ? (
        <Tooltip title="Đã xóa hết file gen trong Tool draft — Gen lại nếu vẫn cần test case này.">
          <Tag color="warning">{emptiedDrafts} TC draft trống</Tag>
        </Tooltip>
      ) : null}
      {variant === "table" ? (
        <>
          <Button
            size="small"
            type={filter === "all" ? "primary" : "default"}
            onClick={() => setFilter("all")}
          >
            Tất cả
          </Button>
          <Button
            size="small"
            type={filter === "unverified" ? "primary" : "default"}
            onClick={() => setFilter("unverified")}
          >
            Chưa Verify
          </Button>
          <Button
            size="small"
            type={filter === "fail" ? "primary" : "default"}
            onClick={() => setFilter("fail")}
          >
            Lỗi
          </Button>
        </>
      ) : null}
    </Space>
  );

  const sidePhaseBusy = Boolean(progress);
  const actionsLockedByGenerate =
    busy && batchRunStatus === "running" && !sidePhaseBusy;

  const actionBar = (
    <Space wrap style={{ marginBottom: variant === "verifyApply" ? 0 : 8 }}>
      <Button
        type="primary"
        icon={<PlayCircleOutlined />}
        onClick={() => void runVerifyAll()}
        loading={busy && progress?.phase === "verify"}
        disabled={
          !isTauri() ||
          genOk === 0 ||
          actionsLockedByGenerate ||
          sidePhaseBusy
        }
      >
        {batchRunStatus === "paused"
          ? `Kiểm thử tất cả phần đã gen (${genOk})`
          : `Kiểm thử tất cả (${genOk})`}
      </Button>
      <Button
        icon={<SaveOutlined />}
        onClick={() => void runApplyAll()}
        loading={busy && progress?.phase === "apply"}
        disabled={
          !isTauri() ||
          verifyDone === 0 ||
          actionsLockedByGenerate ||
          sidePhaseBusy
        }
      >
        Áp dụng các unit
      </Button>
      <Button
        danger
        icon={<DeleteOutlined />}
        onClick={() => void runDiscardAll()}
        loading={busy && progress?.phase === "discard"}
        disabled={
          !isTauri() ||
          rows.every((r) => !r.workspaceRunId) ||
          actionsLockedByGenerate ||
          sidePhaseBusy
        }
      >
        Hủy bỏ & xóa file đã sinh
      </Button>
      {generateFailCount > 0 && onRetryGenerateFails ? (
        <Button
          onClick={onRetryGenerateFails}
          disabled={busy || batchRunStatus === "paused"}
        >
          Thử lại Generate lỗi ({generateFailCount})
        </Button>
      ) : null}
    </Space>
  );

  const progressNode = progress ? (
    <Progress
      percent={Math.round((progress.current / progress.total) * 100)}
      status={batchRunStatus === "paused" ? "normal" : "active"}
      format={() => `${progress.phase} ${progress.current}/${progress.total}`}
      style={{ marginBottom: 8 }}
    />
  ) : null;

  if (variant === "verifyApply") {
    return (
      <>
      <Card
        id="aitest-batch-verify-apply"
        title={title || "3. Execute & Apply"}
        style={{ marginTop: 8 }}
      >
        {statusSummary}
        {progressNode}
        {actionBar}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {batchRunStatus === "paused" ? (
            <>
              Generate đang <strong>tạm dừng</strong> — bấm{" "}
              <strong>Kiểm thử tất cả phần đã gen</strong> / Apply các unit đã gen xong (không phụ thuộc
              bộ lọc bảng), rồi bấm Tiếp tục để gen tiếp.
            </>
          ) : (
            <>
              <strong>Kiểm thử tất cả</strong> chạy <strong>một lệnh test</strong> cho toàn bộ unit
              Generate OK trong batch — không phụ thuộc bộ lọc bảng. Apply ghi từng job PASS vào
              AItest/UnitTest. Hủy bỏ = không Update + xóa Tool draft.
            </>
          )}
        </Typography.Paragraph>

        {verifyLog ? (
          <div ref={logAnchorRef} style={{ marginTop: 16 }}>
            <Typography.Title level={5} style={{ marginTop: 0, marginBottom: 8 }}>
              Log Verify · {verifyLog.units.length} unit đã chạy
            </Typography.Title>
            <Space wrap style={{ marginBottom: 8 }}>
              <Tag color={verifyLog.success ? "success" : "error"}>
                {verifyLog.success ? "PASS" : "FAIL"}
              </Tag>
              {unitSummary ? (
                <>
                  <Tag color="success">{unitSummary.passed} unit passed</Tag>
                  <Tag color={unitSummary.failed ? "error" : "default"}>
                    {unitSummary.failed} unit failed
                  </Tag>
                  <Tag>{unitSummary.total} unit total</Tag>
                </>
              ) : logSummary.hasCounts ? (
                <>
                  <Tag color="success">{logSummary.passed} passed</Tag>
                  <Tag color={logSummary.failed ? "error" : "default"}>
                    {logSummary.failed} failed
                  </Tag>
                  {logSummary.skipped > 0 ? <Tag>{logSummary.skipped} skipped</Tag> : null}
                  <Tag>{logSummary.total} total</Tag>
                </>
              ) : null}
              <Tag>{logSummary.runnerLabel}</Tag>
              {logSummary.hasCounts && unitSummary ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {logSummary.runnerLabel} log: {logSummary.passed} passed / {logSummary.total}{" "}
                  total
                </Typography.Text>
              ) : null}
              <Typography.Text type="secondary">
                {formatDurationMs(logSummary.durationMs)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(verifyLog.ranAt).toLocaleString()}
              </Typography.Text>
            </Space>

            {runnerMismatch ? (
              <Typography.Paragraph
                style={{
                  marginBottom: 8,
                  fontSize: 12,
                  color: "var(--ant-color-warning)",
                }}
              >
                {logSummary.runnerLabel} chỉ thấy {logSummary.total} test file trong log — có thể
                nhiều TC đang ghi đè cùng một path. Gen lại để mỗi TC có file riêng (…tcId.test.ts),
                rồi Verify lại.
              </Typography.Paragraph>
            ) : null}

            {logSummary.failedNames.length > 0 ? (
              <Typography.Paragraph style={{ marginBottom: 8, color: "var(--ant-color-warning)" }}>
                Test fail (trích từ log): {logSummary.failedNames.join(" · ")}
              </Typography.Paragraph>
            ) : null}

            <Tabs
              size="small"
              activeKey={logTab}
              onChange={(k) =>
                setLogTab(k === "summary" ? "summary" : k === "full" ? "full" : "units")
              }
              items={[
                {
                  key: "units",
                  label: `Unit đã chạy (${verifyLog.units.length})`,
                  children: (
                    <Table
                      size="small"
                      pagination={false}
                      rowKey={(r) => r.workspaceRunId || r.testCaseId}
                      dataSource={verifyLog.units}
                      columns={[
                        { title: "TC", dataIndex: "testCaseId", width: 100 },
                        { title: "Tiêu đề", dataIndex: "title", ellipsis: true },
                        {
                          title: "Verify",
                          width: 90,
                          render: (_, r) =>
                            r.verifyStatus === "pass" ? (
                              <Tag icon={<CheckCircleOutlined />} color="success">
                                PASS
                              </Tag>
                            ) : (
                              <Tag color="error">FAIL</Tag>
                            ),
                        },
                        {
                          title: "Chi tiết",
                          width: 100,
                          render: (_, r) =>
                            r.verifyStatus === "fail" &&
                            (r.errorDetail || r.errorLogRel) ? (
                              <Button
                                type="link"
                                size="small"
                                danger
                                icon={<WarningOutlined />}
                                onClick={() =>
                                  void openErrorDetail({
                                    key: r.workspaceRunId || r.testCaseId,
                                    testCaseId: r.testCaseId,
                                    title: r.title,
                                    status: "fail",
                                    error: "Verify FAIL (batch)",
                                    errorDetail: r.errorDetail,
                                    errorLogRel: r.errorLogRel,
                                    workspaceRunId: r.workspaceRunId,
                                  })
                                }
                              >
                                Lỗi
                              </Button>
                            ) : (
                              <Typography.Text type="secondary">—</Typography.Text>
                            ),
                        },
                      ]}
                    />
                  ),
                },
                {
                  key: "summary",
                  label: "Tóm tắt lệnh",
                  children: (
                    <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                      {verifyLog.stages.map((s) => (
                        <div key={s.stage}>
                          <Tag color={s.success ? "success" : "error"}>{s.stage}</Tag>
                          <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                            exit {s.exitCode} · {formatDurationMs(s.durationMs)}
                          </Typography.Text>
                          <div>
                            <Typography.Text code style={{ fontSize: 12 }}>
                              {s.command || "(skip)"}
                            </Typography.Text>
                          </div>
                        </div>
                      ))}
                    </Space>
                  ),
                },
                {
                  key: "full",
                  label: "Log đầy đủ",
                  children: (
                    <Collapse
                      activeKey={[activeLogStage]}
                      onChange={(keys) => {
                        const k = Array.isArray(keys) ? keys[0] : keys;
                        if (k) setActiveLogStage(String(k));
                      }}
                      items={verifyLog.stages.map((s) => ({
                        key: s.stage,
                        label: (
                          <Space wrap>
                            <Tag color={s.success ? "success" : "error"}>
                              {s.stage.toUpperCase()}
                            </Tag>
                            <Typography.Text code style={{ fontSize: 12 }}>
                              {s.command || "(skip)"}
                            </Typography.Text>
                            <Typography.Text type="secondary">
                              exit {s.exitCode} · {formatDurationMs(s.durationMs)}
                            </Typography.Text>
                          </Space>
                        ),
                        children: (
                          <pre className="code" style={{ maxHeight: 360, margin: 0, overflow: "auto" }}>
                            {s.logExcerpt || "(không có log)"}
                          </pre>
                        ),
                      }))}
                    />
                  ),
                },
              ]}
            />
          </div>
        ) : null}
      </Card>
      {detailModals}
    </>
    );
  }

  return (
    <Card size="small" title={title || "Kết quả batch"} type="inner" style={{ marginTop: 8 }}>
      {statusSummary}
      <Table
        size="small"
        className="batch-run-table"
        pagination={false}
        rowKey="key"
        dataSource={visible}
        // Content-sized so short rows never scroll; the text columns cap their
        // own width so a long note cannot widen the page.
        scroll={{ x: "max-content" }}
        columns={[
          { title: "TC", dataIndex: "testCaseId", width: 90 },
          {
            title: "Tiêu đề",
            dataIndex: "title",
            width: 260,
            render: (v: string) => <ClampedCell text={v || ""} lines={1} />,
          },
          {
            title: "Generate",
            width: 90,
            render: (_, r) =>
              r.status === "ok" ? (
                <Tag color="success">OK</Tag>
              ) : r.error === BATCH_NOTE_PAUSED ? (
                <Tag color="orange">Tạm dừng</Tag>
              ) : r.error === BATCH_NOTE_RUNNING ? (
                <Tag color="processing">Đang chạy</Tag>
              ) : r.error === BATCH_NOTE_WAITING ? (
                <Tag>Chờ</Tag>
              ) : (
                <Tag color="error">Lỗi</Tag>
              ),
          },
          {
            title: "Execute",
            width: 90,
            render: (_, r) => {
              if (r.verifyStatus === "pass")
                return (
                  <Tag icon={<CheckCircleOutlined />} color="success">
                    PASS
                  </Tag>
                );
              if (r.verifyStatus === "fail") return <Tag color="error">FAIL</Tag>;
              if (r.verifyStatus === "skipped") return <Tag>Skip</Tag>;
              if (r.status === "ok") return <Tag>Chờ</Tag>;
              return <Tag>—</Tag>;
            },
          },
          {
            title: "Apply",
            width: 90,
            render: (_, r) => {
              if (r.applyStatus === "done") return <Tag color="blue">Done</Tag>;
              if (r.applyStatus === "skipped") return <Tag>Skip</Tag>;
              if (r.verifyStatus === "pass") return <Tag>Chờ</Tag>;
              return <Tag>—</Tag>;
            },
          },
          {
            title: "Ghi chú",
            dataIndex: "error",
            width: 320,
            render: (v, r) => {
              if (r.error === BATCH_NOTE_PAUSED) {
                return <Typography.Text type="warning">{BATCH_NOTE_PAUSED}</Typography.Text>;
              }
              if (r.error === BATCH_NOTE_RUNNING) {
                return <Typography.Text type="secondary">{BATCH_NOTE_RUNNING}</Typography.Text>;
              }
              if (r.error === BATCH_NOTE_WAITING) {
                return <Typography.Text type="secondary">{BATCH_NOTE_WAITING}</Typography.Text>;
              }
              if (r.status === "ok" && !r.error) {
                const perf = r.unitJobId ? unitPerfMap.get(r.unitJobId) ?? null : null;
                return (
                  <Space size={0} wrap>
                    <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                      {r.workspaceRunId?.slice(0, 8) ?? "draft"}
                    </Typography.Text>
                    {perf?.cliTimeMs != null ? (
                      <Tag color="blue" style={{ fontSize: 11 }}>
                        cli {perf.cliTimeMs}ms
                      </Tag>
                    ) : null}
                    {perf?.promptChars != null ? (
                      <Tag style={{ fontSize: 11 }}>prompt {perf.promptChars}</Tag>
                    ) : null}
                    {perf?.contextSize != null ? (
                      <Tag style={{ fontSize: 11 }}>ctx {perf.contextSize}</Tag>
                    ) : null}
                    {perf?.retrievedFiles != null ? (
                      <Tag style={{ fontSize: 11 }}>files {perf.retrievedFiles}</Tag>
                    ) : null}
                  </Space>
                );
              }
              return <ClampedCell text={String(v ?? "")} lines={2} />;
            },
          },
          actionColumn,
        ]}
      />
      {detailModals}
    </Card>
  );
}
