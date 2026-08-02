/**
 * E2E Staging preview — mirror Unit BatchStagingPreview:
 * left file list (new tags) + right code preview.
 */
import { useEffect, useMemo } from "react";
import { Alert, Card, List, Space, Tag, Typography } from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  FileAddOutlined,
} from "@ant-design/icons";
import type { E2EFileDto } from "../../api";
import { stagingDirHint } from "../../lib/e2eWorkspace/stagingApply";
import type { E2eGenItem } from "../../lib/e2eWorkspace";
import {
  BATCH_NOTE_PAUSED,
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
} from "../unit-test/BatchRunConsole";
import type { E2eBatchPipelineRow } from "./E2eBatchConsole";

type Props = {
  rows: E2eBatchPipelineRow[];
  genItems: E2eGenItem[];
  files: E2EFileDto[];
  /** Staging run id (overlay) when available */
  runId?: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string) => void;
};

type FlatFile = {
  path: string;
  kind: string;
  content: string;
  testCaseId: string;
  tcTitle: string;
  op: "new" | "modify";
};

export function E2eBatchStagingPreview({
  rows,
  genItems,
  files,
  runId,
  selectedPath,
  onSelectPath,
}: Props) {
  const okCount = rows.filter((r) => r.status === "ok").length;
  const failJobs = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.status === "fail" &&
          r.error !== BATCH_NOTE_WAITING &&
          r.error !== BATCH_NOTE_PAUSED &&
          r.error !== BATCH_NOTE_RUNNING
      ),
    [rows]
  );
  const waitingCount = rows.filter(
    (r) =>
      r.error === BATCH_NOTE_WAITING ||
      r.error === BATCH_NOTE_PAUSED ||
      r.error === BATCH_NOTE_RUNNING
  ).length;
  const pausedCount = rows.filter((r) => r.error === BATCH_NOTE_PAUSED).length;

  const allFiles: FlatFile[] = useMemo(() => {
    const byTc = new Map(genItems.map((g) => [g.testCaseId, g]));
    return files.map((f) => {
      const owner =
        [...byTc.values()].find((g) => g.files.some((x) => x.path === f.path)) ||
        null;
      return {
        path: f.path,
        kind: f.kind || "spec",
        content: f.content || "",
        testCaseId: owner?.testCaseId || "",
        tcTitle: owner?.title || "",
        op: "new" as const,
      };
    });
  }, [files, genItems]);

  const selected =
    allFiles.find((f) => f.path === selectedPath) ?? allFiles[0] ?? null;

  useEffect(() => {
    if (!selectedPath && allFiles[0]) {
      onSelectPath(allFiles[0].path);
    }
  }, [allFiles, selectedPath, onSelectPath]);

  if (rows.length === 0 && files.length === 0) return null;

  const hintRun = runId || genItems[0]?.runId || "batch";

  return (
    <Card
      id="aitest-e2e-batch-staging-preview"
      title="2. Staging preview"
      style={{ marginTop: 8 }}
      extra={
        <Space wrap>
          <Tag color="blue">run: {String(hintRun).slice(0, 28)}</Tag>
          <Tag>{okCount > 0 ? "generated" : waitingCount > 0 ? "generating" : "idle"}</Tag>
          <Tag color="blue">{allFiles.length} file</Tag>
          <Tag color="success">{okCount} TC OK</Tag>
          {failJobs.length > 0 ? <Tag color="error">{failJobs.length} lỗi</Tag> : null}
          {pausedCount > 0 ? <Tag color="orange">{pausedCount} tạm dừng</Tag> : null}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="File staging — chưa ghi vào source"
        description={
          <>
            Tạm trong{" "}
            <Typography.Text code style={{ fontSize: 12 }}>
              {stagingDirHint(String(hintRun))}
            </Typography.Text>
            . Chạy <strong>Verify</strong> (Playwright) trước khi{" "}
            <strong>Apply</strong> vào <code>AItest/E2ETest/</code>. File hiện dần khi mỗi TC
            Generate xong.
          </>
        }
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 min(360px, 100%)", maxHeight: 520, overflow: "auto" }}>
          <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
            <FileAddOutlined /> New Files ({allFiles.length})
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
                const active = item.path === (selected?.path ?? "");
                return (
                  <List.Item
                    onClick={() => onSelectPath(item.path)}
                    style={{
                      cursor: "pointer",
                      padding: "8px 10px",
                      borderRadius: 6,
                      background: active
                        ? "var(--ant-color-primary-bg, #e6f4ff)"
                        : undefined,
                    }}
                  >
                    <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                      <Space wrap size={4} style={{ width: "100%", justifyContent: "space-between" }}>
                        <Space size={4}>
                          <CheckCircleOutlined style={{ color: "var(--ant-color-success)" }} />
                          <Typography.Text code style={{ fontSize: 11 }} ellipsis>
                            {item.path}
                          </Typography.Text>
                        </Space>
                        <Tag color="green" style={{ margin: 0 }}>
                          new
                        </Tag>
                      </Space>
                      {item.tcTitle ? (
                        <Typography.Text type="secondary" style={{ fontSize: 11 }} ellipsis>
                          {item.tcTitle}
                        </Typography.Text>
                      ) : null}
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
                      <Typography.Text style={{ fontSize: 12 }}>{job.title}</Typography.Text>
                      <Typography.Text type="danger" style={{ fontSize: 11 }}>
                        {job.error}
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
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                Preview: {selected.path}
              </Typography.Text>
              <pre
                className="code"
                style={{
                  marginTop: 8,
                  maxHeight: 460,
                  overflow: "auto",
                  background: "#1e1e1e",
                  color: "#d4d4d4",
                  padding: 12,
                  borderRadius: 8,
                  fontSize: 12,
                  lineHeight: 1.45,
                }}
              >
                {selected.content || "(empty)"}
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
