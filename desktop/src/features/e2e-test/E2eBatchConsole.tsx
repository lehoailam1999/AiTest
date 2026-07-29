/**
 * E2E batch console — mirrors Unit BatchRunConsole chrome (table + Verify&Apply).
 */
import { useMemo, useState } from "react";
import {
  Button,
  Card,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DeleteOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { BatchRunStatus } from "../../lib/batchRunControl";
import {
  BATCH_NOTE_PAUSED,
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
} from "../unit-test/BatchRunConsole";

export type E2eBatchPipelineRow = {
  key: string;
  testCaseId: string;
  title: string;
  /** Generate ok/fail — queue rows use fail + queue note in `error`. */
  status: "ok" | "fail";
  error?: string;
  runId?: string;
  files?: number;
  verifyStatus?: "pending" | "pass" | "fail" | "skipped";
  applyStatus?: "pending" | "done" | "skipped";
};

type Props = {
  title?: string;
  rows: E2eBatchPipelineRow[];
  busy: boolean;
  batchRunStatus: BatchRunStatus;
  variant?: "table" | "verifyApply";
  generateFailCount?: number;
  onRetryGenerateFails?: () => void;
  onVerify?: () => void;
  onHeal?: () => void;
  onApply?: () => void;
  onDiscard?: () => void;
  verifyLoading?: boolean;
  healLoading?: boolean;
  applyLoading?: boolean;
  canHeal?: boolean;
  canApply?: boolean;
  hasStaging?: boolean;
};

export function E2eBatchConsole({
  title,
  rows,
  busy,
  batchRunStatus,
  variant = "table",
  generateFailCount = 0,
  onRetryGenerateFails,
  onVerify,
  onHeal,
  onApply,
  onDiscard,
  verifyLoading,
  healLoading,
  applyLoading,
  canHeal,
  canApply,
  hasStaging,
}: Props) {
  const [filter, setFilter] = useState<"all" | "unverified" | "fail">("all");

  const genOk = rows.filter((r) => r.status === "ok").length;
  const verifyDone = rows.filter((r) => r.verifyStatus === "pass").length;
  const applyDone = rows.filter((r) => r.applyStatus === "done").length;

  const visible = useMemo(() => {
    if (filter === "unverified") {
      return rows.filter(
        (r) => r.status === "ok" && r.verifyStatus !== "pass" && r.verifyStatus !== "fail"
      );
    }
    if (filter === "fail") {
      return rows.filter(
        (r) =>
          (r.status === "fail" &&
            r.error !== BATCH_NOTE_WAITING &&
            r.error !== BATCH_NOTE_PAUSED &&
            r.error !== BATCH_NOTE_RUNNING) ||
          r.verifyStatus === "fail"
      );
    }
    return rows;
  }, [rows, filter]);

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

  const actionsLockedByGenerate = busy && batchRunStatus === "running";

  const actionBar = (
    <Space wrap style={{ marginBottom: variant === "verifyApply" ? 0 : 8 }}>
      <Button
        type="primary"
        icon={<PlayCircleOutlined />}
        onClick={onVerify}
        loading={verifyLoading}
        disabled={genOk === 0 || actionsLockedByGenerate || !onVerify}
      >
        {batchRunStatus === "paused" ? "Kiểm thử phần đã gen" : "Kiểm thử"}
      </Button>
      {canHeal ? (
        <Button
          icon={<ToolOutlined />}
          onClick={onHeal}
          loading={healLoading}
          disabled={actionsLockedByGenerate || !onHeal}
        >
          Heal (AI sửa)
        </Button>
      ) : null}
      <Button
        icon={<SaveOutlined />}
        onClick={onApply}
        loading={applyLoading}
        disabled={!canApply || actionsLockedByGenerate || !onApply}
      >
        Áp dụng vào AItest/E2ETest
      </Button>
      {hasStaging && onDiscard ? (
        <Button
          danger
          icon={<DeleteOutlined />}
          onClick={onDiscard}
          disabled={actionsLockedByGenerate}
        >
          Hủy bỏ & xóa staging
        </Button>
      ) : null}
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

  if (variant === "verifyApply") {
    return (
      <Card id="aitest-e2e-batch-verify-apply" title={title || "3. Verify & Apply"} style={{ marginTop: 8 }}>
        {statusSummary}
        {actionBar}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {batchRunStatus === "paused" ? (
            <>
              Generate đang <strong>tạm dừng</strong> — có thể{" "}
              <strong>Kiểm thử / Apply</strong> các TC đã gen xong, rồi bấm Tiếp tục để gen tiếp.
            </>
          ) : (
            <>
              Kiểm thử chạy Playwright cho specs đã Generate. Heal chỉ khi FAIL. Apply chỉ sau PASS
              — ghi vào <code>AItest/E2ETest/</code>.
            </>
          )}
        </Typography.Paragraph>
      </Card>
    );
  }

  return (
    <Card size="small" title={title || "Kết quả Generate (batch)"} type="inner" style={{ marginTop: 8 }}>
      {statusSummary}
      <Table
        size="small"
        pagination={false}
        rowKey="key"
        dataSource={visible}
        scroll={{ x: 720 }}
        columns={[
          { title: "TC", dataIndex: "title", ellipsis: true },
          {
            title: "Generate",
            width: 100,
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
                    {r.runId?.slice(0, 8) ?? "staging"}
                    {r.files != null ? ` · ${r.files} file` : ""}
                  </Typography.Text>
                );
              }
              return v || "—";
            },
          },
        ]}
      />
    </Card>
  );
}
