/**
 * Phase U2 — Unit Job Board: workspace runs + campaigns + legacy TC jobs.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Descriptions,
  Drawer,
  Space,
  Table,
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useSearchParams } from "react-router-dom";
import { audit, jobs } from "../api";
import type {
  GenerationCampaignAudit,
  Job,
  WorkspaceRunAudit,
  WorkspaceRunDetail,
} from "../api/types";
import { jobStatusLabel, labelOf } from "../i18n/labels";
import { activityUrl, ROUTES, unitTestUrl } from "../lib/productRoutes";
import { useProject } from "../state/ProjectContext";

const ACTIVE = new Set(["Queued", "PendingWorker", "Running", "Pending"]);

const statusColor: Record<string, string> = {
  Completed: "success",
  Failed: "error",
  Running: "processing",
  Queued: "warning",
  Pending: "warning",
  PendingWorker: "warning",
  Partial: "warning",
  ok: "success",
  fail: "error",
  pass: "success",
  applied: "blue",
  generated: "processing",
  verifying: "processing",
  draft: "default",
  discarded: "default",
};

function parseSummary(raw?: string | null): {
  stages?: Array<{ stage?: string; success?: boolean; command?: string; exitCode?: number }>;
  coverageSync?: {
    uploaded?: number;
    linePct?: number | null;
    format?: string | null;
    junit?: { tests?: number; passed?: number; failed?: number } | null;
  };
} | null {
  if (!raw) return null;
  try {
    const data = JSON.parse(raw) as unknown;
    if (Array.isArray(data)) return { stages: data as never };
    if (data && typeof data === "object") return data as never;
  } catch {
    /* ignore */
  }
  return null;
}

export default function JobsPage() {
  const { project } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();
  const tabParam = searchParams.get("tab") || "unit-jobs";
  const runParam = searchParams.get("run");
  const moduleFilter = searchParams.get("module") || "";

  const [tab, setTab] = useState(tabParam);
  const [items, setItems] = useState<Job[]>([]);
  const [campaigns, setCampaigns] = useState<GenerationCampaignAudit[]>([]);
  const [runs, setRuns] = useState<WorkspaceRunAudit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setTab(tabParam);
  }, [tabParam]);

  const loadJobs = useCallback(async () => {
    if (!project) return;
    const page = await jobs.list(project.id);
    setItems(page.items);
  }, [project]);

  const loadAll = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [jobPage, campPage, runPage] = await Promise.all([
        jobs.list(project.id),
        audit.listCampaigns(project.id),
        audit.listWorkspaceRuns(project.id, 1, 80),
      ]);
      setItems(jobPage.items);
      setCampaigns(campPage.items);
      setRuns(runPage.items);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void loadAll();
  }, [loadAll]);

  useEffect(() => {
    const hasActive =
      items.some((j) => ACTIVE.has(j.status)) ||
      campaigns.some((c) => c.status === "Running") ||
      runs.some((r) => r.status === "verifying" || r.status === "generated");
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (hasActive) {
      timer.current = window.setTimeout(() => void loadAll(), 4000);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [items, campaigns, runs, loadAll]);

  const openDetail = useCallback(
    async (runKey: string) => {
      if (!project) return;
      setDetailLoading(true);
      try {
        const d = await audit.getWorkspaceRunDetail(project.id, runKey);
        setDetail(d);
        const q = new URLSearchParams(searchParams);
        q.set("tab", "unit-jobs");
        q.set("run", d.run.localRunId || d.run.id);
        setSearchParams(q, { replace: true });
      } catch (e) {
        setError(e instanceof Error ? e.message : "Không tải được chi tiết job");
      } finally {
        setDetailLoading(false);
      }
    },
    [project, searchParams, setSearchParams]
  );

  const openedRunRef = useRef<string | null>(null);

  useEffect(() => {
    if (!runParam || !project) return;
    if (openedRunRef.current === runParam) return;
    openedRunRef.current = runParam;
    void openDetail(runParam);
  }, [runParam, project, openDetail]);

  const filteredRuns = useMemo(() => {
    if (!moduleFilter) return runs;
    const m = moduleFilter.toLowerCase();
    return runs.filter((r) => (r.module || "").toLowerCase().includes(m));
  }, [runs, moduleFilter]);

  const onTabChange = (key: string) => {
    setTab(key);
    const q = new URLSearchParams(searchParams);
    q.set("tab", key);
    if (key !== "unit-jobs") q.delete("run");
    setSearchParams(q, { replace: true });
  };

  const closeDetail = () => {
    setDetail(null);
    const q = new URLSearchParams(searchParams);
    q.delete("run");
    setSearchParams(q, { replace: true });
  };

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2}>Unit Job Board</Typography.Title>
        <Alert type="error" showIcon title="Chưa chọn dự án. Vào tab Projects để chọn." />
      </div>
    );
  }

  const latestSummary = detail?.verifies[0]
    ? parseSummary(detail.verifies[0].summaryJson)
    : null;

  const runColumns: ColumnsType<WorkspaceRunAudit> = [
    {
      title: "Job",
      dataIndex: "localRunId",
      key: "run",
      width: 120,
      render: (v: string, r) => (
        <Button type="link" size="small" style={{ padding: 0 }} onClick={() => void openDetail(r.id)}>
          {v.slice(0, 12)}
        </Button>
      ),
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      key: "status",
      width: 110,
      render: (s: string) => <Tag color={statusColor[s] ?? "default"}>{s}</Tag>,
    },
    {
      title: "Verify",
      key: "verify",
      width: 100,
      render: (_, r) => {
        const v = r.latestVerify;
        if (!v) return <Typography.Text type="secondary">—</Typography.Text>;
        return (
          <Tag color={v.overallPass ? "success" : "error"}>
            {v.overallPass ? "PASS" : "FAIL"}
          </Tag>
        );
      },
    },
    {
      title: "Coverage",
      key: "cov",
      width: 110,
      render: (_, r) => {
        const summary = parseSummary(r.latestVerify?.summaryJson ?? null);
        const pct = summary?.coverageSync?.linePct;
        if (pct == null) {
          return (
            <Typography.Text type="secondary">
              {r.latestVerify?.coverageStatus || "—"}
            </Typography.Text>
          );
        }
        return <Tag color="blue">{pct}%</Tag>;
      },
    },
    {
      title: "Module",
      dataIndex: "module",
      key: "module",
      ellipsis: true,
      render: (v) => v ?? "—",
    },
    {
      title: "Context",
      dataIndex: "contextSource",
      key: "ctx",
      width: 100,
      render: (v) => v || "—",
    },
    {
      title: "Cập nhật",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 160,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: "",
      key: "open",
      width: 90,
      render: (_, r) => (
        <Link to={unitTestUrl({ mode: "single", testCaseId: r.testCaseId || undefined })}>
          Mở Unit
        </Link>
      ),
    },
  ];

  const campaignColumns: ColumnsType<GenerationCampaignAudit> = [
    {
      title: "Loại",
      dataIndex: "kind",
      key: "kind",
      width: 80,
      render: (k: string) => <Tag>{k}</Tag>,
    },
    {
      title: "Phạm vi",
      key: "scope",
      render: (_, c) => `${c.scopeLevel ?? "—"} · ${c.scopeLabel ?? "—"}`,
      ellipsis: true,
    },
    {
      title: "Trạng thái",
      dataIndex: "status",
      key: "status",
      render: (s: string) => <Tag color={statusColor[s] ?? "default"}>{s}</Tag>,
    },
    {
      title: "Tasks",
      key: "tasks",
      width: 90,
      render: (_, c) => {
        const ok = c.tasks.filter((t) => t.status === "ok").length;
        return `${ok}/${c.tasks.length}`;
      },
    },
    {
      title: "Bắt đầu",
      dataIndex: "startedAt",
      key: "startedAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
    {
      title: "",
      key: "goto",
      width: 120,
      render: (_, c) =>
        c.scopeLabel ? (
          <Link to={unitTestUrl({ mode: "module", module: c.scopeLabel })}>Chạy lại module</Link>
        ) : (
          <Link to={ROUTES.unitTest}>Unit Job</Link>
        ),
    },
  ];

  const jobColumns: ColumnsType<Job> = [
    {
      title: "Mã job",
      dataIndex: "id",
      key: "id",
      width: 110,
      render: (id: string) => id.slice(0, 8),
    },
    { title: "Backend", dataIndex: "backendType", key: "backend", render: (v) => v ?? "—" },
    {
      title: "Trạng thái",
      dataIndex: "status",
      key: "status",
      render: (s: string) => (
        <Tag color={statusColor[s] ?? "default"}>{labelOf(jobStatusLabel, s)}</Tag>
      ),
    },
    { title: "Lỗi", dataIndex: "error", key: "error", render: (v) => v ?? "—", ellipsis: true },
    {
      title: "Tạo lúc",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 180,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Unit Job Board
          </Typography.Title>
          <Typography.Text type="secondary">
            Theo dõi Unit Job (gen → verify → coverage → apply) · campaign module · không cần IDE.
          </Typography.Text>
        </div>
        <Space wrap>
          <Link to={unitTestUrl()}>
            <Button type="primary">Chạy Unit Job</Button>
          </Link>
          <Button onClick={() => void loadAll()}>Làm mới</Button>
        </Space>
      </header>

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}

      {moduleFilter ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Lọc module: ${moduleFilter}`}
          action={
            <Button
              size="small"
              onClick={() => {
                const q = new URLSearchParams(searchParams);
                q.delete("module");
                setSearchParams(q, { replace: true });
              }}
            >
              Bỏ lọc
            </Button>
          }
        />
      ) : null}

      <Tabs
        activeKey={tab}
        onChange={onTabChange}
        items={[
          {
            key: "unit-jobs",
            label: `Unit Jobs (${filteredRuns.length})`,
            children: (
              <Table
                rowKey="id"
                loading={loading || detailLoading}
                columns={runColumns}
                dataSource={filteredRuns}
                pagination={{ pageSize: 12, showSizeChanger: true, pageSizeOptions: [12, 25, 50] }}
                locale={{
                  emptyText: (
                    <span>
                      Chưa có Unit Job —{" "}
                      <Link to={unitTestUrl()}>Chạy Unit Job</Link> từ TC Approved.
                    </span>
                  ),
                }}
              />
            ),
          },
          {
            key: "campaigns",
            label: `Campaigns (${campaigns.length})`,
            children: (
              <Table
                rowKey="id"
                loading={loading}
                columns={campaignColumns}
                dataSource={campaigns}
                expandable={{
                  expandedRowRender: (c) => (
                    <Table
                      size="small"
                      rowKey="id"
                      pagination={false}
                      dataSource={c.tasks}
                      columns={[
                        {
                          title: "TC",
                          dataIndex: "testCaseId",
                          render: (v) => (v ? String(v).slice(0, 8) : "—"),
                        },
                        {
                          title: "Run",
                          dataIndex: "localRunId",
                          render: (v: string | null | undefined) =>
                            v ? (
                              <Button
                                type="link"
                                size="small"
                                style={{ padding: 0 }}
                                onClick={() => {
                                  onTabChange("unit-jobs");
                                  void openDetail(v);
                                }}
                              >
                                {v.slice(0, 10)}
                              </Button>
                            ) : (
                              "—"
                            ),
                        },
                        {
                          title: "Trạng thái",
                          dataIndex: "status",
                          render: (s: string) => (
                            <Tag color={statusColor[s] ?? "default"}>{s}</Tag>
                          ),
                        },
                        { title: "Lỗi", dataIndex: "error", ellipsis: true },
                      ]}
                    />
                  ),
                }}
                pagination={{ pageSize: 8, showSizeChanger: true }}
                locale={{ emptyText: "Chưa có campaign — Chạy Unit Job · module." }}
              />
            ),
          },
          {
            key: "legacy-jobs",
            label: "Legacy TC jobs",
            children: (
              <Table
                rowKey="id"
                loading={loading}
                columns={jobColumns}
                dataSource={items}
                pagination={{ pageSize: 10 }}
                locale={{ emptyText: "Không còn dùng cho Unit CLI — xem tab Unit Jobs." }}
              />
            ),
          },
        ]}
      />

      <Drawer
        title={
          detail
            ? `Unit Job · ${detail.run.localRunId.slice(0, 14)}`
            : "Chi tiết Unit Job"
        }
        width={520}
        open={Boolean(detail)}
        onClose={closeDetail}
        destroyOnClose
      >
        {detail ? (
          <Space orientation="vertical" size={16} style={{ width: "100%" }}>
            <Descriptions size="small" column={1} bordered>
              <Descriptions.Item label="Status">
                <Tag color={statusColor[detail.run.status] ?? "default"}>
                  {detail.run.status}
                </Tag>
              </Descriptions.Item>
              <Descriptions.Item label="Module">{detail.run.module || "—"}</Descriptions.Item>
              <Descriptions.Item label="Context">
                {detail.run.contextSource || "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Provider">{detail.run.provider || "—"}</Descriptions.Item>
              <Descriptions.Item label="Test case">
                {detail.run.testCaseId ? (
                  <Link to={unitTestUrl({ testCaseId: detail.run.testCaseId })}>
                    {detail.run.testCaseId.slice(0, 8)}…
                  </Link>
                ) : (
                  "—"
                )}
              </Descriptions.Item>
            </Descriptions>

            {detail.verifies[0] ? (
              <>
                <Typography.Text strong>Verify gần nhất</Typography.Text>
                <Space wrap>
                  <Tag color={detail.verifies[0].overallPass ? "success" : "error"}>
                    {detail.verifies[0].overallPass ? "PASS" : "FAIL"}
                  </Tag>
                  {detail.verifies[0].compileStatus ? (
                    <Tag>compile: {detail.verifies[0].compileStatus}</Tag>
                  ) : null}
                  {detail.verifies[0].testStatus ? (
                    <Tag>test: {detail.verifies[0].testStatus}</Tag>
                  ) : null}
                  {detail.verifies[0].coverageStatus ? (
                    <Tag>coverage: {detail.verifies[0].coverageStatus}</Tag>
                  ) : null}
                </Space>
                {latestSummary?.stages?.length ? (
                  <Table
                    size="small"
                    pagination={false}
                    rowKey={(_, i) => String(i)}
                    dataSource={latestSummary.stages}
                    columns={[
                      { title: "Stage", dataIndex: "stage", width: 90 },
                      {
                        title: "OK",
                        dataIndex: "success",
                        width: 60,
                        render: (ok: boolean) => (
                          <Tag color={ok ? "success" : "error"}>{ok ? "pass" : "fail"}</Tag>
                        ),
                      },
                      { title: "Cmd", dataIndex: "command", ellipsis: true },
                      { title: "Exit", dataIndex: "exitCode", width: 60 },
                    ]}
                  />
                ) : null}
                {latestSummary?.coverageSync && latestSummary.coverageSync.uploaded ? (
                  <Alert
                    type="success"
                    showIcon
                    title="Coverage sync"
                    description={
                      <Space wrap>
                        {latestSummary.coverageSync.linePct != null ? (
                          <Tag color="blue">Line {latestSummary.coverageSync.linePct}%</Tag>
                        ) : null}
                        {latestSummary.coverageSync.junit?.tests != null ? (
                          <Tag>
                            JUnit {latestSummary.coverageSync.junit.passed ?? 0}/
                            {latestSummary.coverageSync.junit.tests}
                          </Tag>
                        ) : null}
                        <Link to={ROUTES.reports}>Reports</Link>
                      </Space>
                    }
                  />
                ) : null}
              </>
            ) : (
              <Alert type="info" showIcon title="Chưa có verify report — chạy Verify trên Unit test." />
            )}

            {detail.applies.length ? (
              <>
                <Typography.Text strong>Apply</Typography.Text>
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {detail.applies[0]?.filesApplied?.map((f) => (
                    <li key={f}>
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {f}
                      </Typography.Text>
                    </li>
                  ))}
                </ul>
              </>
            ) : null}

            <Space wrap>
              <Link
                to={unitTestUrl({
                  mode: "single",
                  testCaseId: detail.run.testCaseId || undefined,
                })}
              >
                <Button type="primary">Mở Unit Job</Button>
              </Link>
              <Link to={activityUrl({ tab: "unit-jobs" })}>
                <Button onClick={closeDetail}>Đóng</Button>
              </Link>
            </Space>
          </Space>
        ) : null}
      </Drawer>
    </div>
  );
}
