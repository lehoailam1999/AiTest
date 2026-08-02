import { useMemo, useRef, useState } from "react";
import {
  App,
  Button,
  Card,
  Collapse,
  Progress,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { BatchRunControl, BatchRunStatus } from "../../lib/batchRunControl";
import { loadManifest, saveManifest } from "../../lib/unitWorkspace/manager";
import { applyManyWorkspacesToRepo } from "../../lib/unitWorkspace/applyManager";
import { runCombinedBatchVerify } from "../../lib/unitWorkspace/combinedBatchVerify";
import { discardWorkspaceRuns } from "../../lib/unitWorkspace/discardManager";
import {
  formatDurationMs,
  parseTestRunSummary,
} from "../../lib/unitWorkspace/parseTestRunSummary";
import type {
  UnitWorkspaceManifest,
  VerifyStageResult,
} from "../../lib/unitWorkspace/types";
import { suggestWorkspaceVerifyCommands } from "../../lib/stackHints";
import type { ProjectMeta, StackInspect } from "../../api/types";
import { isTauri } from "../../tauri/bridge";

/** Queue notes for batch Generate list (Ghi chú column). */
export const BATCH_NOTE_WAITING = "Đang chờ…";
export const BATCH_NOTE_PAUSED = "Tạm dừng — chờ Tiếp tục";
export const BATCH_NOTE_RUNNING = "Đang chạy…";

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

function extractFailedPathTokens(log: string): string[] {
  const out = new Set<string>();
  const push = (raw: string) => {
    const norm = (raw || "").replace(/\\/g, "/").trim();
    if (!norm) return;
    const base = norm.split("/").pop() || norm;
    if (base) out.add(base.toLowerCase());
    out.add(norm.toLowerCase());
  };
  const failLine = /^\s*FAIL\s+(.+)$/gim;
  let m: RegExpExecArray | null;
  while ((m = failLine.exec(log)) !== null) {
    push(m[1] || "");
  }
  const specLine = /^\s*(?:at|in)\s+([^\s]+(?:\.test|\.spec)\.[a-z]+)(?::\d+)?/gim;
  while ((m = specLine.exec(log)) !== null) {
    push(m[1] || "");
  }
  return [...out];
}

function rowMatchesFailedTokens(
  row: BatchPipelineRow,
  manifest: UnitWorkspaceManifest | undefined,
  tokens: string[]
): boolean {
  if (!tokens.length) return false;
  const hay = new Set<string>();
  const add = (s?: string | null) => {
    const norm = (s || "").replace(/\\/g, "/").trim();
    if (!norm) return;
    hay.add(norm.toLowerCase());
    const base = norm.split("/").pop() || norm;
    hay.add(base.toLowerCase());
  };
  add(row.testCaseId);
  add(row.workspaceRunId);
  add(row.title);
  for (const f of manifest?.files || []) {
    add(f.targetRel);
    add(f.workspaceRel);
  }
  for (const t of tokens) {
    for (const h of hay) {
      if (h.includes(t) || t.includes(h)) return true;
    }
  }
  return false;
}

/** Batch verify PASS for one row (shared by table + log units). */
function batchVerifyPass(
  row: BatchPipelineRow,
  manifest: UnitWorkspaceManifest | undefined,
  failedTokens: string[],
  hasMappedFailure: boolean
): boolean {
  if (manifest?.verify?.overallPass) return true;
  if (!hasMappedFailure) return false;
  return !rowMatchesFailedTokens(row, manifest, failedTokens);
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

export type BatchPipelineRow = {
  key: string;
  testCaseId: string;
  title: string;
  /** Generate ok/fail — queue rows use fail + queue note in `error`. */
  status: "ok" | "fail";
  error?: string;
  workspaceRunId?: string;
  packagePrefix?: string;
  verifyStatus?: "pending" | "pass" | "fail" | "skipped";
  applyStatus?: "pending" | "done" | "skipped";
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
   * table — chỉ bảng trạng thái (trong card Generate)
   * verifyApply — mục 3: nút Verify/Apply/Hủy (dưới Staging preview)
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
  const genOk = rows.filter((r) => r.status === "ok" && r.workspaceRunId).length;

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
    const work = rows.filter((r) => r.status === "ok" && r.workspaceRunId);
    if (work.length === 0) {
      message.info("Không có job Generate OK để Verify.");
      return;
    }
    const { preserveGeneratePause } = beginSidePhase();
    setProgress({
      current: 0,
      total: work.length,
      label: preserveGeneratePause
        ? `Verify ${work.length} unit đã gen (Generate đang tạm dừng)`
        : `Staging ${work.length} job → chạy 1 lệnh test`,
      phase: "verify",
    });
    try {
      const manifests = [];
      for (const row of work) {
        const m = await loadManifest(projectRoot, row.workspaceRunId!, row.packagePrefix);
        if (m) manifests.push(m);
      }
      if (manifests.length === 0) {
        message.error("Không load được staging nào.");
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
      const nextRows = rows.map((r) => {
        if (!r.workspaceRunId || r.status !== "ok") {
          return { ...r, verifyStatus: "skipped" as const };
        }
        const m = byRun.get(r.workspaceRunId);
        if (!m) {
          return {
            ...r,
            verifyStatus: "fail" as const,
            error: "Thiếu staging sau verify",
          };
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
        return {
          ...r,
          verifyStatus: (pass ? "pass" : "fail") as "pass" | "fail",
          error: pass ? undefined : "Verify FAIL (batch)",
          applyStatus: r.applyStatus ?? ("pending" as const),
        };
      });
      if (promotions.length) {
        await Promise.all(promotions);
      }
      onRowsChange(nextRows);

      const units = work.map((r) => {
        const m = byRun.get(r.workspaceRunId!);
        const pass = batchVerifyPass(r, m, failedTokens, hasMappedFailure);
        return {
          testCaseId: r.testCaseId,
          title: r.title,
          verifyStatus: (pass ? "pass" : "fail") as "pass" | "fail",
          workspaceRunId: r.workspaceRunId,
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
      message.info("Không có staging để hủy.");
      return;
    }
    modal.confirm({
      title: `Hủy bỏ ${work.length} Unit Job?`,
      content:
        "Không Apply. Xóa file đã gen dưới AItest/ (nếu còn trên đĩa) và dọn toàn bộ staging .ai-test/staging. Production src không bị đụng.",
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
    if (work.length === 0) {
      message.info("Chưa có dòng Verify PASS để Apply.");
      return;
    }
    modal.confirm({
      title: `Apply ${work.length} job vào AItest/?`,
      content:
        "Ghi đủ file vào AItest/, rồi dọn từng staging. Không đụng production src.",
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
                  error: "Thiếu staging",
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
                error: e instanceof Error ? e.message : "Load staging lỗi",
              });
            }
          }
          onRowsChange([...map.values()]);

          if (toApply.length === 0) {
            message.warning("Không có staging để Apply.");
            return;
          }

          setProgress({
            current: toApply.length,
            total: work.length,
            label: `Ghi ${toApply.length} overlay → AItest/`,
            phase: "apply",
          });

          const { results } = await applyManyWorkspacesToRepo(projectRoot, toApply);
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
                // Staging removed with .ai-test — clear pointer so UI doesn't reload ghosts.
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
          message.success(
            `Đã Apply ${okN}/${toApply.length} job vào AItest/ · đã xóa .ai-test staging`
          );
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Apply batch lỗi");
        } finally {
          endSidePhase(preserveGeneratePause);
        }
      },
    });
  }

  if (rows.length === 0) return null;

  const statusSummary = (
    <Space wrap style={{ marginBottom: variant === "table" ? 8 : 12 }}>
      <Typography.Text type="secondary">
        Gen OK {genOk}/{rows.length}
        {" · "}
        Verify {verifyDone}/{genOk}
        {" · "}
        Apply {applyDone}/{verifyDone || genOk}
      </Typography.Text>
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
        {batchRunStatus === "paused" ? "Kiểm thử phần đã gen" : "Kiểm thử"}
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
      <Card
        id="aitest-batch-verify-apply"
        title={title || "3. Verify & Apply"}
        style={{ marginTop: 8 }}
      >
        {statusSummary}
        {progressNode}
        {actionBar}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {batchRunStatus === "paused" ? (
            <>
              Generate đang <strong>tạm dừng</strong> — có thể{" "}
              <strong>Kiểm thử / Apply</strong> các unit đã gen xong, rồi bấm Tiếp tục để gen tiếp.
            </>
          ) : (
            <>
              Verify chạy <strong>một lệnh test</strong> cho toàn bộ file AItest đã sinh trong batch.
              Apply ghi từng job PASS vào AItest/. Hủy bỏ = không Apply + xóa file gen + dọn staging.
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
    );
  }

  return (
    <Card size="small" title={title || "Kết quả batch"} type="inner" style={{ marginTop: 8 }}>
      {statusSummary}
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={visible}
        scroll={{ x: 720 }}
        columns={[
          { title: "TC", dataIndex: "testCaseId", width: 90 },
          { title: "Tiêu đề", dataIndex: "title", ellipsis: true },
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
            title: "Verify",
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
            ellipsis: true,
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
                return (
                  <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                    {r.workspaceRunId?.slice(0, 8) ?? "staging"}
                  </Typography.Text>
                );
              }
              return v;
            },
          },
        ]}
      />
    </Card>
  );
}
