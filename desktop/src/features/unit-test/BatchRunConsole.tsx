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
import { loadManifest } from "../../lib/unitWorkspace/manager";
import { applyWorkspaceToRepo } from "../../lib/unitWorkspace/applyManager";
import { runCombinedBatchVerify } from "../../lib/unitWorkspace/combinedBatchVerify";
import { discardWorkspaceRuns } from "../../lib/unitWorkspace/discardManager";
import {
  formatDurationMs,
  parseTestRunSummary,
} from "../../lib/unitWorkspace/parseTestRunSummary";
import type { VerifyStageResult } from "../../lib/unitWorkspace/types";
import { suggestWorkspaceVerifyCommands } from "../../lib/stackHints";
import type { ProjectMeta, StackInspect } from "../../api/types";
import { isTauri } from "../../tauri/bridge";

export type BatchPipelineRow = {
  key: string;
  testCaseId: string;
  title: string;
  /** Generate ok/fail */
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

  const hints = useMemo(
    () =>
      suggestWorkspaceVerifyCommands({
        language,
        framework: framework === "auto" ? "" : framework,
        meta,
        targetRelPaths: [],
        packagePrefix: rows.find((r) => r.packagePrefix)?.packagePrefix,
        stackInspect,
      }),
    [language, framework, meta, rows, stackInspect]
  );

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

  async function applyOne(row: BatchPipelineRow): Promise<BatchPipelineRow> {
    if (row.verifyStatus !== "pass" || !row.workspaceRunId) {
      return { ...row, applyStatus: "skipped" };
    }
    const manifest = await loadManifest(
      projectRoot,
      row.workspaceRunId,
      row.packagePrefix
    );
    if (!manifest || manifest.status !== "pass") {
      // Allow apply if verify just passed but status on disk is pass
      if (!manifest || !manifest.verify?.overallPass) {
        return { ...row, applyStatus: "skipped", error: "Chưa Verify PASS" };
      }
    }
    const toApply =
      manifest.status === "pass"
        ? manifest
        : { ...manifest, status: "pass" as const };
    await applyWorkspaceToRepo(projectRoot, toApply);
    return { ...row, applyStatus: "done", error: undefined };
  }

  async function runVerifyAll() {
    if (!isTauri()) return;
    const work = rows.filter((r) => r.status === "ok" && r.workspaceRunId);
    if (work.length === 0) {
      message.info("Không có job Generate OK để Verify.");
      return;
    }
    if (!hints.test.trim()) {
      message.error("Chưa có lệnh test — kiểm tra framework / stack.");
      return;
    }
    onBusy(true);
    batchControl.start();
    setProgress({
      current: 0,
      total: work.length,
      label: `Staging ${work.length} job → chạy 1 lệnh test`,
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
      setProgress({
        current: manifests.length,
        total: work.length,
        label: "Đang chạy test toàn bộ AItest…",
        phase: "verify",
      });
      const result = await runCombinedBatchVerify({
        projectRoot,
        manifests,
        compileCommand: hints.compile,
        testCommand: hints.test,
      });
      const byRun = new Map(result.updatedManifests.map((m) => [m.runId, m]));
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
        return {
          ...r,
          verifyStatus: (m.verify?.overallPass ? "pass" : "fail") as "pass" | "fail",
          error: m.verify?.overallPass ? undefined : "Verify FAIL (batch)",
          applyStatus: r.applyStatus ?? ("pending" as const),
        };
      });
      onRowsChange(nextRows);

      const units = work.map((r) => {
        const m = byRun.get(r.workspaceRunId!);
        const pass = Boolean(m?.verify?.overallPass);
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
      batchControl.reset();
      setProgress(null);
      onBusy(false);
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
        "Không Apply. Xóa file đã gen dưới AItest/ (nếu còn trên đĩa) và dọn toàn bộ staging .ai-test/workspace. Production src không bị đụng.",
      okText: "Hủy bỏ & xóa file gen",
      okType: "danger",
      onOk: async () => {
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
          onBusy(false);
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
        "Mỗi job ghi file dưới AItest/ và dọn staging. Không đụng production src.",
      okText: "Apply tất cả",
      onOk: async () => {
        onBusy(true);
        batchControl.start();
        setProgress({
          current: 0,
          total: work.length,
          label: work[0].title,
          phase: "apply",
        });
        const map = new Map(rows.map((r) => [r.key, r]));
        try {
          for (let i = 0; i < work.length; i++) {
            await batchControl.waitIfPaused();
            const row = work[i];
            setProgress({
              current: i + 1,
              total: work.length,
              label: row.title,
              phase: "apply",
            });
            try {
              const next = await applyOne(map.get(row.key) || row);
              map.set(row.key, next);
            } catch (e) {
              map.set(row.key, {
                ...(map.get(row.key) || row),
                applyStatus: "skipped",
                error: e instanceof Error ? e.message : "Apply lỗi",
              });
            }
            onRowsChange([...map.values()]);
          }
          message.success("Đã Apply xong các job PASS.");
        } finally {
          batchControl.reset();
          setProgress(null);
          onBusy(false);
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
          batchRunStatus === "paused" ||
          (busy && batchRunStatus === "running")
        }
      >
        Kiểm thử
      </Button>
      <Button
        icon={<SaveOutlined />}
        onClick={() => void runApplyAll()}
        loading={busy && progress?.phase === "apply"}
        disabled={
          !isTauri() ||
          verifyDone === 0 ||
          batchRunStatus === "paused" ||
          (busy && batchRunStatus === "running")
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
          (busy && batchRunStatus === "running")
        }
      >
        Hủy bỏ & xóa file đã sinh
      </Button>
      {generateFailCount > 0 && onRetryGenerateFails ? (
        <Button onClick={onRetryGenerateFails} disabled={busy}>
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
          Verify chạy <strong>một lệnh test</strong> cho toàn bộ file AItest đã sinh trong batch.
          Apply ghi từng job PASS vào AItest/. Hủy bỏ = không Apply + xóa file gen + dọn staging.
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
              {logSummary.hasCounts ? (
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
              <Typography.Text type="secondary">
                {formatDurationMs(logSummary.durationMs)}
              </Typography.Text>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                {new Date(verifyLog.ranAt).toLocaleString()}
              </Typography.Text>
            </Space>

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
              ) : r.error === "Đang chờ…" ? (
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
            render: (v, r) =>
              r.status === "ok" && !r.error ? (
                <Typography.Text type="secondary" code style={{ fontSize: 11 }}>
                  {r.workspaceRunId?.slice(0, 8) ?? "staging"}
                </Typography.Text>
              ) : (
                v
              ),
          },
        ]}
      />
    </Card>
  );
}
