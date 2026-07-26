import { useCallback, useEffect, useState } from "react";
import { Alert, App, Button, Card, Input, Space, Table, Typography, Upload } from "antd";
import { Link } from "react-router-dom";
import { reporting } from "../../api";
import { useProject } from "../../state/ProjectContext";

type CovRow = {
  id: string;
  format: string;
  linePct: number;
  branchPct?: number | null;
  fileName?: string | null;
  uploadedAt?: string | null;
};

/** Feature: reporting — P7 Coverage + Report */
export default function ReportsPage() {
  const { message } = App.useApp();
  const { project } = useProject();
  const [rows, setRows] = useState<CovRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [title, setTitle] = useState("Báo cáo kiểm thử");

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const page = await reporting.listCoverage(project.id);
      setRows(page.items);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Tải coverage thất bại");
    } finally {
      setLoading(false);
    }
  }, [project, message]);

  useEffect(() => {
    void load();
  }, [load]);

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
            Báo cáo &amp; Coverage
          </Typography.Title>
          <Typography.Text type="secondary">
            Coverage meta + report. Sau khi <Link to="/run">Chạy test</Link> — không upload source tree.
          </Typography.Text>
        </div>
        <Space>
          <Link to="/run">
            <Button>Chạy test</Button>
          </Link>
          <Button onClick={() => void load()} loading={loading}>
            Tải lại
          </Button>
        </Space>
      </header>

      <Card title="Upload coverage" style={{ marginBottom: 16 }}>
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
          <Button type="primary">Chọn file coverage</Button>
        </Upload>
      </Card>

      <Card title="Lịch sử coverage" style={{ marginBottom: 16 }}>
        <Table
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
              render: (v: number | null | undefined) =>
                v == null ? "—" : `${v}%`,
            },
            { title: "File", dataIndex: "fileName" },
            { title: "Uploaded", dataIndex: "uploadedAt", width: 200 },
          ]}
        />
      </Card>

      <Card title="Tạo report meta">
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
                  meta: { coverageCount: rows.length },
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
