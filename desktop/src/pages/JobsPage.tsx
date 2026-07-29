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
import { activityUrl, e2eTestUrl, ROUTES, unitTestUrl } from "../lib/productRoutes";
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
  const [unitRuns, setUnitRuns] = useState<WorkspaceRunAudit[]>([]);
  const [e2eRuns, setE2eRuns] = useState<WorkspaceRunAudit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [detail, setDetail] = useState<WorkspaceRunDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const timer = useRef<number | null>(null);

  useEffect(() => {
    setTab(tabParam);
  }, [tabParam]);

  const loadAll = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [jobPage, campPage, unitPage, e2ePage] = await Promise.all([
        jobs.list(project.id),
        audit.listCampaigns(project.id),
        audit.listWorkspaceRuns(project.id, 1, 80, { testType: "unit" }),
        audit.listWorkspaceRuns(project.id, 1, 80, { testType: "e2e" }),
      ]);
      setItems(jobPage.items);
      setCampaigns(campPage.items);
      setUnitRuns(unitPage.items);
      setE2eRuns(e2ePage.items);
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
      unitRuns.some((r) => r.status === "verifying" || r.status === "generated") ||
      e2eRuns.some((r) => r.status === "verifying" || r.status === "generated");
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
  }, [items, campaigns, unitRuns, e2eRuns, loadAll]);

  const openDetail = useCallback(
    async (runKey: string, boardTab: "unit-jobs" | "e2e-jobs" = "unit-jobs") => {
      if (!project) return;
      setDetailLoading(true);
      try {
        const d = await audit.getWorkspaceRunDetail(project.id, runKey);
        setDetail(d);
        const q = new URLSearchParams(searchParams);
        q.set("tab", boardTab);
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
    const board: "unit-jobs" | "e2e-jobs" =
      tabParam === "e2e-jobs" ? "e2e-jobs" : "unit-jobs";
    void openDetail(runParam, board);
  }, [runParam, project, openDetail, tabParam]);

  const filterByModule = useCallback(
    (list: WorkspaceRunAudit[]) => {
      if (!moduleFilter) return list;
      const m = moduleFilter.toLowerCase();
      return list.filter((r) => (r.module || "").toLowerCase().includes(m));
    },
    [moduleFilter]
  );

  const filteredUnitRuns = useMemo(
    () => filterByModule(unitRuns),
    [unitRuns, filterByModule]
  );
  const filteredE2eRuns = useMemo(
    () => filterByModule(e2eRuns),
    [e2eRuns, filterByModule]
  );

  const onTabChange = (key: string) => {
    setTab(key);
    const q = new URLSearchParams(searchParams);
    q.set("tab", key);
    if (key !== "unit-jobs" && key !== "e2e-jobs") q.delete("run");
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
        <Typography.Title level={2}>Job Board</Typography.Title>
        <Alert type="error" showIcon title="Chưa chọn dự án. Vào tab Projects để chọn." />
      </div>
    );
  }

  const latestSummary = detail?.verifies[0]
    ? parseSummary(detail.verifies[0].summaryJson)
    : null;

  function buildRunColumns(
    board: "unit-jobs" | "e2e-jobs"
  ): ColumnsType<WorkspaceRunAudit> {
    const isE2e = board === "e2e-jobs";
    return [
      {
        title: "Job",
        dataIndex: "localRunId",
        key: "run",
        width: 120,
        render: (v: string, r) => (
          <Button
            type="link"
            size="small"
            style={{ padding: 0 }}
            onClick={() => void openDetail(r.id, board)}
          >
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
        title: isE2e ? "Headless" : "Verify",
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
        title: isE2e ? "Artifacts" : "Coverage",
        key: "cov",
        width: 110,
        render: (_, r) => {
          const summary = parseSummary(r.latestVerify?.summaryJson ?? null);
          if (isE2e) {
            const uploaded = summary?.coverageSync?.uploaded;
            if (uploaded == null) {
              return (
                <Typography.Text type="secondary">
                  {r.latestVerify?.coverageStatus || "—"}
                </Typography.Text>
              );
            }
            return <Tag color="blue">{uploaded}</Tag>;
          }
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
        title: "Cập nhật",
        dataIndex: "createdAt",
        key: "createdAt",
        width: 160,
        render: (v: string) => new Date(v).toLocaleString(),
      },
      {
        title: "",
        key: "open",
        width: 100,
        render: (_, r) =>
          isE2e ? (
            <Link
              to={e2eTestUrl({
                testCaseId: r.testCaseId || undefined,
                module: r.module || undefined,
              })}
            >
              Mở E2E
            </Link>
          ) : (
            <Link
              to={unitTestUrl({
                mode: "single",
                testCaseId: r.testCaseId || undefined,
              })}
            >
              Mở Unit
            </Link>
          ),
      },
    ];
  }

  const unitRunColumns = buildRunColumns("unit-jobs");
  const e2eRunColumns = buildRunColumns("e2e-jobs");

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
      width: 140,
      render: (_, c) => {
        if (c.kind === "e2e") {
          return c.scopeLabel ? (
            <Link to={e2eTestUrl({ module: c.scopeLabel })}>Chạy lại module</Link>
          ) : (
            <Link to={ROUTES.e2eTest}>E2E Job</Link>
          );
        }
        return c.scopeLabel ? (
          <Link to={unitTestUrl({ mode: "module", module: c.scopeLabel })}>
            Chạy lại module
          </Link>
        ) : (
          <Link to={ROUTES.unitTest}>Unit Job</Link>
        );
      },
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
      width: 120,
      render: (s: string) => (
        <Tag color={statusColor[s] ?? "default"}>{labelOf(jobStatusLabel, s)}</Tag>
      ),
    },
    {
      title: "Tiến độ",
      dataIndex: "progressMessage",
      key: "progress",
      ellipsis: true,
      render: (v: string | null | undefined, r) => {
        const msg = (v || "").trim();
        if (msg) return msg;
        if (ACTIVE.has(r.status)) return "Đang chạy…";
        return "—";
      },
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
            Job Board
          </Typography.Title>
          <Typography.Text type="secondary">
            Unit Jobs · E2E Jobs · campaigns · lịch sử trên PostgreSQL (không cần đọc log máy).
          </Typography.Text>
        </div>
        <Space wrap>
          <Link to={unitTestUrl()}>
            <Button type="primary">Chạy Unit Job</Button>
          </Link>
          <Link to={ROUTES.e2eTest}>
            <Button>Chạy E2E Job</Button>
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
            label: `Unit Jobs (${filteredUnitRuns.length})`,
            children: (
              <Table
                rowKey="id"
                loading={loading || detailLoading}
                columns={unitRunColumns}
                dataSource={filteredUnitRuns}
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
            key: "e2e-jobs",
            label: `E2E Jobs (${filteredE2eRuns.length})`,
            children: (
              <Table
                rowKey="id"
                loading={loading || detailLoading}
                columns={e2eRunColumns}
                dataSource={filteredE2eRuns}
                pagination={{ pageSize: 12, showSizeChanger: true, pageSizeOptions: [12, 25, 50] }}
                locale={{
                  emptyText: (
                    <span>
                      Chưa có E2E Job —{" "}
                      <Link to={ROUTES.e2eTest}>Chạy E2E Job</Link> từ TC Approved type=E2E.
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
                          render: (v) =>
                            v ? (
                              <Button
                                type="link"
                                size="small"
                                style={{ padding: 0 }}
                                onClick={() => {
                                  onTabChange(
                                    c.kind === "e2e" ? "e2e-jobs" : "unit-jobs"
                                  );
                                  void openDetail(
                                    String(v),
                                    c.kind === "e2e" ? "e2e-jobs" : "unit-jobs"
                                  );
                                }}
                              >
                                {String(v).slice(0, 12)}
                              </Button>
                            ) : (
                              "—"
                            ),
                        },
                        { title: "Status", dataIndex: "status" },
                        {
                          title: "Lỗi",
                          dataIndex: "error",
                          ellipsis: true,
                          render: (v) => v || "—",
                        },
                      ]}
                    />
                  ),
                }}
                pagination={{ pageSize: 10 }}
                locale={{ emptyText: "Chưa có campaign." }}
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
            ? `${detail.run.testType === "e2e" ? "E2E" : "Unit"} Job · ${detail.run.localRunId.slice(0, 14)}`
            : "Chi tiết Job"
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
              <Descriptions.Item label="Loại">{detail.run.testType || "unit"}</Descriptions.Item>
              <Descriptions.Item label="Module">{detail.run.module || "—"}</Descriptions.Item>
              <Descriptions.Item label="Context">
                {detail.run.contextSource || "—"}
              </Descriptions.Item>
              <Descriptions.Item label="Provider">{detail.run.provider || "—"}</Descriptions.Item>
              <Descriptions.Item label="Test case">
                {detail.run.testCaseId ? (
                  <Link
                    to={
                      detail.run.testType === "e2e"
                        ? e2eTestUrl({
                            testCaseId: detail.run.testCaseId,
                            module: detail.run.module || undefined,
                          })
                        : unitTestUrl({ testCaseId: detail.run.testCaseId })
                    }
                  >
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
              <Alert
                type="info"
                showIcon
                title={
                  detail.run.testType === "e2e"
                    ? "Chưa có verify report — chạy E2E Job trên console."
                    : "Chưa có verify report — chạy Verify trên Unit test."
                }
              />
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
