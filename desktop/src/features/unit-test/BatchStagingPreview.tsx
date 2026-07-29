import { useEffect, useMemo } from "react";
import { Alert, Card, List, Space, Tag, Typography } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileAddOutlined,
} from "@ant-design/icons";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../../lib/unitWorkspace/types";
import type { BatchPipelineRow } from "./BatchRunConsole";

export type BatchStagingJob = {
  row: BatchPipelineRow;
  manifest: UnitWorkspaceManifest | null;
  previews: WorkspacePreviewFile[];
};

type FlatFile = {
  key: string;
  targetRel: string;
  testCaseId: string;
  tcTitle: string;
  jobKey: string;
  preview: WorkspacePreviewFile;
  op: string;
};

type Props = {
  jobs: BatchStagingJob[];
  selectedJobKey: string | null;
  selectedTargetRel: string | null;
  onSelectJob: (key: string) => void;
  onSelectFile: (targetRel: string) => void;
};

/**
 * Staging preview batch — mặc định list phẳng mọi file đã sinh (+ TC lỗi trong panel phụ).
 */
export function BatchStagingPreview({
  jobs,
  selectedJobKey,
  selectedTargetRel,
  onSelectJob,
  onSelectFile,
}: Props) {
  const allFiles: FlatFile[] = useMemo(() => {
    const out: FlatFile[] = [];
    for (const job of jobs) {
      if (job.row.status !== "ok" || !job.manifest) continue;
      for (const p of job.previews) {
        if (p.entry.op === "delete") continue;
        out.push({
          key: `${job.row.key}::${p.entry.targetRel}`,
          targetRel: p.entry.targetRel,
          testCaseId: job.row.testCaseId,
          tcTitle: job.row.title,
          jobKey: job.row.key,
          preview: p,
          op: p.entry.op,
        });
      }
    }
    return out;
  }, [jobs]);

  const failJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.row.status === "fail" &&
          j.row.error !== "Đang chờ…" &&
          j.row.error !== "Tạm dừng — chờ Tiếp tục" &&
          j.row.error !== "Đang chạy…"
      ),
    [jobs]
  );

  const selected =
    allFiles.find((f) => f.targetRel === selectedTargetRel) ?? allFiles[0] ?? null;

  useEffect(() => {
    if (!selectedTargetRel && allFiles[0]) {
      onSelectFile(allFiles[0].targetRel);
      onSelectJob(allFiles[0].jobKey);
    }
  }, [allFiles, selectedTargetRel, onSelectFile, onSelectJob]);

  const okCount = jobs.filter((j) => j.row.status === "ok").length;
  const failCount = failJobs.length;
  const waitingCount = jobs.filter(
    (j) =>
      j.row.error === "Đang chờ…" ||
      j.row.error === "Tạm dừng — chờ Tiếp tục" ||
      j.row.error === "Đang chạy…"
  ).length;
  const pausedCount = jobs.filter((j) => j.row.error === "Tạm dừng — chờ Tiếp tục").length;

  return (
    <Card
      id="aitest-batch-staging-preview"
      title="2. Staging preview · Batch"
      style={{ marginTop: 8 }}
      extra={
        <Space wrap>
          <Tag color="blue">{allFiles.length} file</Tag>
          <Tag color="success">{okCount} TC OK</Tag>
          {failCount > 0 ? <Tag color="error">{failCount} lỗi</Tag> : null}
          {pausedCount > 0 ? <Tag color="orange">{pausedCount} tạm dừng</Tag> : null}
          {waitingCount > 0 && pausedCount === 0 ? <Tag>{waitingCount} chờ</Tag> : null}
          {waitingCount > 0 && pausedCount > 0 ? (
            <Tag>{waitingCount - pausedCount} chờ / chạy</Tag>
          ) : null}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title={`Đã sinh ${allFiles.length} file staging từ ${okCount} TC`}
        description="Danh sách bên trái gồm mọi file mới/sửa trong đợt Unit Job (test + jest/tsconfig nếu có). Chọn để xem preview."
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 min(360px, 100%)", maxHeight: 520, overflow: "auto" }}>
          <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
            <FileAddOutlined /> Tất cả file ({allFiles.length})
          </Typography.Text>
          {allFiles.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {waitingCount > 0
                ? "Đang Generate — file sẽ hiện dần khi từng TC xong."
                : "Chưa có file staging."}
            </Typography.Text>
          ) : (
            <List
              size="small"
              dataSource={allFiles}
              renderItem={(item) => {
                const active = item.targetRel === (selected?.targetRel ?? "");
                return (
                  <List.Item
                    onClick={() => {
                      onSelectFile(item.targetRel);
                      onSelectJob(item.jobKey);
                    }}
                    style={{
                      cursor: "pointer",
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: active ? "var(--ant-color-primary-bg, #e6f4ff)" : undefined,
                    }}
                  >
                    <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                      <Space wrap size={4}>
                        <Tag color={item.op === "new" ? "green" : "gold"} style={{ margin: 0 }}>
                          {item.op}
                        </Tag>
                        <Typography.Text code style={{ fontSize: 11 }}>
                          {item.testCaseId}
                        </Typography.Text>
                      </Space>
                      <Typography.Text code style={{ fontSize: 12 }} ellipsis>
                        {item.targetRel}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                );
              }}
            />
          )}

          {failJobs.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
                <CloseCircleOutlined /> TC lỗi ({failJobs.length})
              </Typography.Text>
              <List
                size="small"
                dataSource={failJobs}
                renderItem={(job) => (
                  <List.Item style={{ padding: "6px 8px" }}>
                    <Space orientation="vertical" size={0}>
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {job.row.testCaseId}
                      </Typography.Text>
                      <Typography.Text type="danger" style={{ fontSize: 11 }}>
                        {job.row.error}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          ) : null}
        </div>

        <div style={{ flex: "1 1 280px", minWidth: 200, maxHeight: 520, overflow: "auto" }}>
          {selected ? (
            <>
              <Space wrap style={{ marginBottom: 8 }}>
                <CheckCircleOutlined style={{ color: "var(--ant-color-success)" }} />
                <Typography.Text code style={{ fontSize: 12 }}>
                  {selected.testCaseId}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                  {selected.tcTitle}
                </Typography.Text>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                {selected.targetRel}
              </Typography.Text>
              <pre className="code" style={{ marginTop: 8, maxHeight: 440 }}>
                {selected.preview.content}
              </pre>
            </>
          ) : (
            <Typography.Text type="secondary">Chọn file để xem preview.</Typography.Text>
          )}
        </div>
      </div>
    </Card>
  );
}
