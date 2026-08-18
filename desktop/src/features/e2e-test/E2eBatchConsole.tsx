/**
 * E2E batch console — mirrors Unit BatchRunConsole chrome (table + Verify&Apply).
 */
import { useMemo, useState } from "react";
import {
  App,
  Button,
  Card,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ToolOutlined,
  WarningOutlined,
} from "@ant-design/icons";
import type { BatchRunStatus } from "../../lib/batchRunControl";
import {
  E2E_FAIL_CATEGORY_LABELS,
  type E2eFailCategory,
} from "../../lib/e2eWorkspace/e2eFailureMetrics";
import { labelOf, priorityLabel, typeLabel } from "../../i18n/labels";
import { isTauri, readTextFile } from "../../tauri/bridge";
import {
  BATCH_NOTE_PAUSED,
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
  isBatchQueueNote,
} from "../unit-test/BatchRunConsole";

export type E2eBatchPipelineRow = {
  key: string;
  testCaseId: string;
  title: string;
  /** Generate ok/fail — queue rows use fail + queue note in `error`. */
  status: "ok" | "fail";
  error?: string;
  /** Full generate/verify error body for «Chi tiết lỗi». */
  errorDetail?: string;
  /** Relative path under project root where error log was saved. */
  errorLogRel?: string;
  runId?: string;
  files?: number;
  verifyStatus?: "pending" | "pass" | "fail" | "skipped";
  applyStatus?: "pending" | "done" | "skipped";
  /** Phase 4 — classified Verify failure */
  failCategory?: string;
  /** TC snapshot — Chi tiết Test case */
  module?: string;
  precondition?: string;
  steps?: string;
  expectedResult?: string;
  testData?: string;
  priority?: string;
  severity?: string;
  type?: string;
};

type Props = {
  title?: string;
  rows: E2eBatchPipelineRow[];
  busy: boolean;
  batchRunStatus: BatchRunStatus;
  /** Project root — used to load saved error logs for «Chi tiết lỗi». */
  projectRoot?: string | null;
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
  projectRoot,
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
  const { message } = App.useApp();
  const [filter, setFilter] = useState<"all" | "unverified" | "fail">("all");
  const [tcDetail, setTcDetail] = useState<E2eBatchPipelineRow | null>(null);
  const [errorDetail, setErrorDetail] = useState<{
    row: E2eBatchPipelineRow;
    body: string;
  } | null>(null);

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

  function resolveErrorBody(r: E2eBatchPipelineRow): string {
    if (r.errorDetail?.trim()) return r.errorDetail.trim();
    if (r.error && !isBatchQueueNote(r.error)) return r.error;
    return "";
  }

  async function openErrorDetail(r: E2eBatchPipelineRow) {
    let body = resolveErrorBody(r);
    if (r.errorLogRel && projectRoot && isTauri()) {
      try {
        const fromDisk = await readTextFile(projectRoot, r.errorLogRel);
        if (fromDisk?.trim()) body = fromDisk.trim();
      } catch {
        // keep in-memory body
      }
    }
    if (!body) {
      message.info("Chưa có chi tiết lỗi cho dòng này.");
      return;
    }
    setErrorDetail({ row: r, body });
  }

  if (rows.length === 0) return null;

  const detailModals = (
    <>
      <Modal
        open={!!tcDetail}
        title={tcDetail ? `Chi tiết ${tcDetail.testCaseId}` : "Chi tiết TC"}
        onCancel={() => setTcDetail(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setTcDetail(null)}>
            Đóng
          </Button>,
        ]}
        width={640}
      >
        {tcDetail ? (
          <div style={{ marginTop: 8 }}>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Tiêu đề</Typography.Text>
              <div style={{ marginTop: 4 }}>{tcDetail.title || "—"}</div>
            </div>
            <Space
              wrap
              style={{ width: "100%", marginBottom: 4 }}
              styles={{ item: { flex: 1, minWidth: 160 } }}
            >
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Module</Typography.Text>
                <div style={{ marginTop: 4 }}>{tcDetail.module?.trim() || "—"}</div>
              </div>
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Loại (engine)</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {labelOf(typeLabel, tcDetail.type || "") || tcDetail.type || "—"}
                </div>
              </div>
              <div style={{ marginBottom: 12, width: "100%" }}>
                <Typography.Text type="secondary">Ưu tiên</Typography.Text>
                <div style={{ marginTop: 4 }}>
                  {labelOf(priorityLabel, tcDetail.priority || "") ||
                    tcDetail.priority ||
                    "—"}
                </div>
              </div>
            </Space>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Tiền điều kiện</Typography.Text>
              <pre className="detail-block">
                {tcDetail.precondition?.trim() || "—"}
              </pre>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Các bước</Typography.Text>
              <pre className="detail-block">{tcDetail.steps?.trim() || "—"}</pre>
            </div>
            <div style={{ marginBottom: 16 }}>
              <Typography.Text type="secondary">Kết quả mong đợi</Typography.Text>
              <pre className="detail-block">
                {tcDetail.expectedResult?.trim() || "—"}
              </pre>
            </div>
            <div style={{ marginBottom: 0 }}>
              <Typography.Text type="secondary">Test data</Typography.Text>
              <pre className="detail-block">{tcDetail.testData?.trim() || "—"}</pre>
            </div>
            {!tcDetail.steps?.trim() && !tcDetail.expectedResult?.trim() ? (
              <Typography.Text type="secondary" style={{ display: "block", marginTop: 12 }}>
                Chưa có snapshot nội dung TC trên dòng này — chạy lại Generate batch để gắn chi
                tiết.
              </Typography.Text>
            ) : null}
          </div>
        ) : null}
      </Modal>
      <Modal
        open={!!errorDetail}
        title={
          errorDetail
            ? `Chi tiết lỗi · ${errorDetail.row.testCaseId} · ${errorDetail.row.title}`
            : "Chi tiết lỗi"
        }
        onCancel={() => setErrorDetail(null)}
        footer={[
          <Button key="close" type="primary" onClick={() => setErrorDetail(null)}>
            Đóng
          </Button>,
        ]}
        width={780}
      >
        {errorDetail?.row.errorLogRel ? (
          <Typography.Paragraph type="secondary" style={{ marginBottom: 8, fontSize: 12 }}>
            Đã lưu:{" "}
            <Typography.Text code style={{ fontSize: 11 }}>
              {errorDetail.row.errorLogRel}
            </Typography.Text>
          </Typography.Paragraph>
        ) : null}
        {errorDetail?.row.failCategory ? (
          <Typography.Paragraph style={{ marginBottom: 8 }}>
            Loại lỗi:{" "}
            <Tag>
              {E2E_FAIL_CATEGORY_LABELS[errorDetail.row.failCategory as E2eFailCategory] ||
                errorDetail.row.failCategory}
            </Tag>
          </Typography.Paragraph>
        ) : null}
        <pre
          className="detail-block"
          style={{ maxHeight: 460, overflow: "auto", margin: 0 }}
        >
          {errorDetail?.body || ""}
        </pre>
      </Modal>
    </>
  );

  const statusSummary = (
    <Space wrap style={{ marginBottom: variant === "table" ? 8 : 12 }}>
      <Typography.Text type="secondary">
        Gen OK {genOk}/{rows.length}
        {" · "}
        Execute {verifyDone}/{genOk}
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
        {batchRunStatus === "paused"
          ? `Kiểm thử tất cả phần đã gen (${genOk})`
          : `Kiểm thử tất cả (${genOk})`}
      </Button>
      {/* {canHeal ? (
        <Button
          icon={<ToolOutlined />}
          onClick={onHeal}
          loading={healLoading}
          disabled={actionsLockedByGenerate || !onHeal}
        >
          Heal (AI sửa)
        </Button>
      ) : null} */}
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
      <Card id="aitest-e2e-batch-verify-apply" title={title || "3. Execute & Apply"} style={{ marginTop: 8 }}>
        {statusSummary}
        {actionBar}
        <Typography.Paragraph type="secondary" style={{ marginTop: 12, marginBottom: 0 }}>
          {batchRunStatus === "paused" ? (
            <>
              Generate đang <strong>tạm dừng</strong> — bấm{" "}
              <strong>Kiểm thử tất cả phần đã gen</strong> / Apply mọi Spec đã Generate (không phụ thuộc
              bộ lọc bảng), rồi bấm Tiếp tục để gen tiếp.
            </>
          ) : (
            <>
              <strong>Kiểm thử tất cả</strong> chạy Playwright cho{" "}
              <strong>mọi Spec đã Generate</strong> trong batch — không phụ thuộc bộ lọc bảng. Heal
              chỉ khi FAIL. Apply chỉ sau PASS — ghi vào <code>AItest/E2ETest/</code>.
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
        scroll={{ x: 900 }}
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
            title: "Execute",
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
            title: "Loại lỗi",
            width: 110,
            render: (_, r) =>
              r.verifyStatus === "fail" && r.failCategory ? (
                <Tag>
                  {E2E_FAIL_CATEGORY_LABELS[r.failCategory as E2eFailCategory] ||
                    r.failCategory}
                </Tag>
              ) : (
                <Typography.Text type="secondary">—</Typography.Text>
              ),
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
          {
            title: "Chi tiết",
            width: 180,
            fixed: "right",
            render: (_, r) => {
              const hasErr = Boolean(resolveErrorBody(r) || r.errorLogRel);
              return (
                <Space size={0} wrap>
                  <Button
                    type="link"
                    size="small"
                    icon={<EyeOutlined />}
                    onClick={() => setTcDetail(r)}
                  >
                    Test case
                  </Button>
                  <Button
                    type="link"
                    size="small"
                    danger={hasErr}
                    disabled={!hasErr}
                    icon={<WarningOutlined />}
                    onClick={() => void openErrorDetail(r)}
                  >
                    Lỗi
                  </Button>
                </Space>
              );
            },
          },
        ]}
      />
      {detailModals}
    </Card>
  );
}
