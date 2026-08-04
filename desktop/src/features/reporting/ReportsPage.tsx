import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Input,
  Row,
  Space,
  Statistic,
  Table,
  Tag,
  Typography,
  Upload,
} from "antd";
import { Link } from "react-router-dom";
import { executions, reporting } from "../../api";
import type { Execution } from "../../api/types";
import { classifyExecutionLane, summarizeExecutions } from "../../lib/runCenter";
import { ROUTES } from "../../lib/productRoutes";
import { useProject } from "../../state/ProjectContext";

type CovRow = {
  id: string;
  format: string;
  linePct: number;
  branchPct?: number | null;
  fileName?: string | null;
  uploadedAt?: string | null;
};

/**
 * Báo cáo — tổng hợp Execution (Unit/E2E regression) + Coverage phụ.
 * Không đụng Generate / Verify / Apply.
 */
export default function ReportsPage() {
  const { message } = App.useApp();
  const { project } = useProject();
  const [rows, setRows] = useState<CovRow[]>([]);
  const [history, setHistory] = useState<Execution[]>([]);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("Báo cáo kiểm thử");

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const [cov, exec] = await Promise.all([
        reporting.listCoverage(project.id),
        executions.list(project.id, 1, 50),
      ]);
      setRows(cov.items);
      setHistory(exec.items);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Tải báo cáo thất bại");
    } finally {
      setLoading(false);
    }
  }, [project, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const summary = useMemo(() => summarizeExecutions(history), [history]);

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2}>Báo cáo</Typography.Title>
        <Alert type="warning" showIcon title="Chọn dự án trước." />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Báo cáo
          </Typography.Title>
          <Typography.Text type="secondary">
            Kết quả regression sau <Link to={ROUTES.run}>Chạy test</Link> (Unit / E2E đã Apply) — không
            sinh TC hay code tại đây.
          </Typography.Text>
        </div>
        <Space>
          <Link to={`${ROUTES.run}?lane=unit`}>
            <Button type="primary">Chạy Unit</Button>
          </Link>
          <Link to={`${ROUTES.run}?lane=e2e`}>
            <Button>Chạy E2E</Button>
          </Link>
          <Button onClick={() => void load()} loading={loading}>
            Tải lại
          </Button>
        </Space>
      </header>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Phạm vi sản phẩm"
        description="Hệ thống hiện hỗ trợ Unit + E2E. Coverage line/branch chủ yếu gắn Unit; E2E theo dõi pass rate journey."
      />

      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="Lần chạy" value={summary.totalRuns} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Run pass"
              value={summary.passedRuns}
              valueStyle={{ color: "#3f8600" }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Run fail"
              value={summary.failedRuns}
              valueStyle={{ color: summary.failedRuns > 0 ? "#cf1322" : undefined }}
            />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="Unit runs" value={summary.unitRuns} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic title="E2E runs" value={summary.e2eRuns} />
          </Card>
        </Col>
        <Col xs={12} sm={8} md={4}>
          <Card size="small">
            <Statistic
              title="Tests P/F"
              value={`${summary.testsPassed}/${summary.testsFailed}`}
            />
          </Card>
        </Col>
      </Row>

      <Card title="Lịch sử chạy (Execution)" style={{ marginBottom: 16 }}>
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          dataSource={history}
          pagination={{ pageSize: 10 }}
          columns={[
            {
              title: "Lane",
              width: 90,
              render: (_: unknown, row: Execution) => {
                const l = classifyExecutionLane(row.command);
                return (
                  <Tag color={l === "e2e" ? "purple" : l === "unit" ? "blue" : "default"}>
                    {l}
                  </Tag>
                );
              },
            },
            {
              title: "Status",
              dataIndex: "status",
              width: 90,
              render: (s: string) => (
                <Tag color={s === "Passed" ? "success" : s === "Failed" ? "error" : "warning"}>
                  {s}
                </Tag>
              ),
            },
            {
              title: "P/F/S/T",
              width: 110,
              render: (_: unknown, row: Execution) =>
                `${row.passed}/${row.failed}/${row.skipped}/${row.total}`,
            },
            { title: "Command", dataIndex: "command", ellipsis: true },
            {
              title: "Finished",
              dataIndex: "finishedAt",
              width: 180,
              render: (v: string) => (v ? new Date(v).toLocaleString() : "—"),
            },
          ]}
        />
      </Card>

      <Card title="Coverage (Unit — phụ)" style={{ marginBottom: 16 }}>
        <Typography.Paragraph type="secondary" style={{ marginTop: 0 }}>
          Upload LCOV/Cobertura sau khi chạy Unit có coverage, hoặc lấy từ Verify Unit. Không bắt buộc
          cho E2E.
        </Typography.Paragraph>
        <Upload
          accept=".info,.lcov,.xml,.txt"
          beforeUpload={async (file) => {
            try {
              const content = await file.text();
              const fmt = file.name.endsWith(".xml") ? "cobertura" : "lcov";
              await reporting.uploadCoverage(project.id, {
                format: fmt,
                content,
                fileName: file.name,
              });
              message.success("Đã upload coverage");
              await load();
            } catch (e) {
              message.error(e instanceof Error ? e.message : "Upload thất bại");
            }
            return false;
          }}
          showUploadList={false}
        >
          <Button>Chọn file coverage</Button>
        </Upload>
        <Table
          style={{ marginTop: 16 }}
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={false}
          columns={[
            { title: "Format", dataIndex: "format", width: 100 },
            {
              title: "Line %",
              dataIndex: "linePct",
              width: 100,
              render: (v: number) => `${v}%`,
            },
            {
              title: "Branch %",
              dataIndex: "branchPct",
              width: 100,
              render: (v: number | null | undefined) => (v == null ? "—" : `${v}%`),
            },
            { title: "File", dataIndex: "fileName" },
            { title: "Uploaded", dataIndex: "uploadedAt", width: 200 },
          ]}
        />
      </Card>

      <Card title="Lưu report meta">
        <Space>
          <Input
            style={{ width: 280 }}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Tiêu đề báo cáo"
          />
          <Button
            onClick={async () => {
              try {
                await reporting.createReport(project.id, {
                  title,
                  format: "html",
                  meta: {
                    coverageCount: rows.length,
                    executionCount: history.length,
                    ...summary,
                  },
                });
                message.success("Đã tạo report meta");
              } catch (e) {
                message.error(e instanceof Error ? e.message : "Tạo report thất bại");
              }
            }}
          >
            Lưu report
          </Button>
        </Space>
      </Card>
    </div>
  );
}
