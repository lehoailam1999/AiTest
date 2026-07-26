import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Space, Table, Tabs, Tag, Typography } from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link } from "react-router-dom";
import { audit, jobs } from "../api";
import type { GenerationCampaignAudit, Job, WorkspaceRunAudit } from "../api/types";
import { jobStatusLabel, labelOf } from "../i18n/labels";
import { ROUTES } from "../lib/productRoutes";
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
};

export default function JobsPage() {
  const { project } = useProject();
  const [tab, setTab] = useState("jobs");
  const [items, setItems] = useState<Job[]>([]);
  const [campaigns, setCampaigns] = useState<GenerationCampaignAudit[]>([]);
  const [runs, setRuns] = useState<WorkspaceRunAudit[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

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
        audit.listWorkspaceRuns(project.id),
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
    const hasActive = items.some((j) => ACTIVE.has(j.status));
    if (timer.current) {
      window.clearTimeout(timer.current);
      timer.current = null;
    }
    if (hasActive && tab === "jobs") {
      timer.current = window.setTimeout(() => void loadJobs(), 2500);
    }
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [items, loadJobs, tab]);

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2}>Công việc AI</Typography.Title>
        <Alert type="error" showIcon title="Chưa chọn dự án. Vào tab Dự án để chọn." />
      </div>
    );
  }

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
  ];

  const runColumns: ColumnsType<WorkspaceRunAudit> = [
    {
      title: "Run",
      dataIndex: "localRunId",
      key: "run",
      width: 120,
      render: (v: string) => v.slice(0, 10),
    },
    { title: "Loại", dataIndex: "testType", key: "type", width: 70 },
    {
      title: "Trạng thái",
      dataIndex: "status",
      key: "status",
      render: (s: string) => <Tag color={statusColor[s] ?? "default"}>{s}</Tag>,
    },
    {
      title: "Module",
      dataIndex: "module",
      key: "module",
      ellipsis: true,
      render: (v) => v ?? "—",
    },
    {
      title: "Provider",
      dataIndex: "provider",
      key: "provider",
      width: 90,
      render: (v) => v ?? "—",
    },
    {
      title: "Cập nhật",
      dataIndex: "createdAt",
      key: "createdAt",
      width: 170,
      render: (v: string) => new Date(v).toLocaleString(),
    },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Activity
          </Typography.Title>
          <Typography.Text type="secondary">
            Job TC · campaign batch · Agent Staging runs (meta PG, không lưu source).
          </Typography.Text>
        </div>
        <Space>
          <Link to={ROUTES.unitTest}>
            <Button>Unit test</Button>
          </Link>
          <Button onClick={() => void loadAll()}>Làm mới</Button>
        </Space>
      </header>

      {error ? <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} /> : null}

      {(campaigns.some((c) => c.status === "Failed" || c.status === "Running") ||
        items.some((j) => ACTIVE.has(j.status) || j.status === "Failed")) && (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="Có job/campaign đang chạy hoặc lỗi — mở tab tương ứng để Retry / theo dõi."
        />
      )}

      <Tabs
        activeKey={tab}
        onChange={setTab}
        items={[
          {
            key: "jobs",
            label: "Job TC",
            children: (
              <Table
                rowKey="id"
                loading={loading}
                columns={jobColumns}
                dataSource={items}
                pagination={{ pageSize: 10, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100] }}
                locale={{ emptyText: "Chưa có job. Sinh TC từ wizard hoặc Spec." }}
              />
            ),
          },
          {
            key: "campaigns",
            label: "Campaign",
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
                        { title: "TC", dataIndex: "testCaseId", render: (v) => (v ? String(v).slice(0, 8) : "—") },
                        { title: "Run", dataIndex: "localRunId", render: (v) => v?.slice(0, 10) ?? "—" },
                        {
                          title: "Trạng thái",
                          dataIndex: "status",
                          render: (s: string) => <Tag color={statusColor[s] ?? "default"}>{s}</Tag>,
                        },
                        { title: "Lỗi", dataIndex: "error", ellipsis: true },
                      ]}
                    />
                  ),
                }}
                pagination={{ pageSize: 8, showSizeChanger: true, pageSizeOptions: [8, 20, 50] }}
                locale={{ emptyText: "Chưa có campaign — sinh theo module trên Unit test." }}
              />
            ),
          },
          {
            key: "runs",
            label: "Agent Staging runs",
            children: (
              <Table
                rowKey="id"
                loading={loading}
                columns={runColumns}
                dataSource={runs}
                pagination={{ pageSize: 12, showSizeChanger: true, pageSizeOptions: [12, 25, 50, 100] }}
                locale={{ emptyText: "Chưa có run — sinh + Verify/Apply trên Desktop." }}
              />
            ),
          },
        ]}
      />
    </div>
  );
}
