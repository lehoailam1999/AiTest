/**
 * E2E Verify & Apply — mirror Unit VerifyApplyConsole chrome:
 * Steps (Staging → Playwright → Heal → Apply) + alerts + action row.
 */
import { Alert, Button, Card, Space, Steps, Tag, Typography } from "antd";
import type { StepsProps } from "antd";
import {
  DeleteOutlined,
  PlayCircleOutlined,
  SaveOutlined,
  ToolOutlined,
} from "@ant-design/icons";
import type { BatchRunStatus } from "../../lib/batchRunControl";
import type { E2eBatchPipelineRow } from "./E2eBatchConsole";
import type { E2eRunMetrics } from "../../lib/e2eWorkspace/e2eFailureMetrics";
import { E2E_FAIL_CATEGORY_LABELS } from "../../lib/e2eWorkspace/e2eFailureMetrics";

export const E2E_VERIFY_APPLY_ID = "aitest-e2e-batch-verify-apply";

type Props = {
  rows: E2eBatchPipelineRow[];
  fileCount: number;
  genOkCount: number;
  busy: boolean;
  batchRunStatus: BatchRunStatus;
  jobPassed: boolean | null;
  hasStaging: boolean;
  applied: boolean;
  canHeal: boolean;
  canApply: boolean;
  verifyLoading?: boolean;
  healLoading?: boolean;
  applyLoading?: boolean;
  /** Phase 4 — last Verify metrics */
  metrics?: E2eRunMetrics | null;
  onVerify?: () => void;
  onHeal?: () => void;
  onApply?: () => void;
  onDiscard?: () => void;
};

export function E2eVerifyApplyConsole({
  rows,
  fileCount,
  genOkCount,
  busy,
  batchRunStatus,
  jobPassed,
  hasStaging,
  applied,
  canHeal,
  canApply,
  verifyLoading,
  healLoading,
  applyLoading,
  metrics,
  onVerify,
  onHeal,
  onApply,
  onDiscard,
}: Props) {
  const verifyPass = rows.filter((r) => r.verifyStatus === "pass").length;
  const verifyFail = rows.filter((r) => r.verifyStatus === "fail").length;
  const actionsLockedByGenerate = busy && batchRunStatus === "running";
  const suggestVerify = jobPassed == null && genOkCount > 0 && fileCount > 0;

  const stagingSt: StepsProps["status"] =
    fileCount > 0 ? "finish" : "wait";
  let playwrightSt: StepsProps["status"] = "wait";
  let playwrightDesc = "Chưa chạy";
  if (verifyLoading) {
    playwrightSt = "process";
    playwrightDesc = "Đang chạy";
  } else if (jobPassed === true) {
    playwrightSt = "finish";
    playwrightDesc = `${verifyPass}/${genOkCount || fileCount} PASS`;
  } else if (jobPassed === false) {
    playwrightSt = "error";
    playwrightDesc = verifyFail > 0 ? `${verifyFail} FAIL` : "FAIL";
  }

  let healSt: StepsProps["status"] = "wait";
  let healDesc = "Khi fail";
  if (healLoading) {
    healSt = "process";
    healDesc = "Đang heal";
  } else if (jobPassed === true && canHeal === false && verifyFail === 0) {
    healSt = "finish";
    healDesc = "Không cần";
  } else if (jobPassed === false) {
    healSt = "error";
    healDesc = "Sẵn sàng";
  }

  let applySt: StepsProps["status"] = "wait";
  let applyDesc: string | undefined;
  if (applied) {
    applySt = "finish";
    applyDesc = "Xong";
  } else if (jobPassed === true) {
    applySt = "process";
    applyDesc = "Sẵn sàng";
  }

  const current =
    applied
      ? 3
      : healLoading
        ? 2
        : verifyLoading
          ? 1
          : jobPassed === true
            ? 3
            : jobPassed === false
              ? 2
              : fileCount > 0
                ? 0
                : 0;

  return (
    <Card
      id={E2E_VERIFY_APPLY_ID}
      title="3. Execute & Apply"
      style={{ marginTop: 8 }}
      extra={
        suggestVerify ? (
          <Tag color="processing">Tiếp theo: Kiểm thử tất cả</Tag>
        ) : applied ? (
          <Tag color="success">Đã Apply</Tag>
        ) : jobPassed === true ? (
          <Tag color="success">PASS · sẵn sàng Apply</Tag>
        ) : jobPassed === false ? (
          <Tag color="error">FAIL</Tag>
        ) : null
      }
    >
      <Steps
        size="small"
        current={current}
        style={{ marginBottom: 16 }}
        items={[
          {
            title: "Staging",
            status: stagingSt,
            description: fileCount > 0 ? `${fileCount} file` : "Chưa có",
          },
          {
            title: "Playwright",
            status: playwrightSt,
            description: playwrightDesc,
          },
          {
            title: "Heal",
            status: healSt,
            description: healDesc,
          },
          {
            title: "Apply",
            status: applySt,
            description: applyDesc,
          },
        ]}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 10 }}
        title="Verify trên AItest/E2ETest — Apply ghi bền"
        description="Giống Unit: copy staging vào AItest/E2ETest, chạy Playwright, rồi rollback đến khi Apply. Apply ghi AItest/E2ETest/ trên disk — không đụng src production."
      />

      {metrics && metrics.total > 0 ? (
        <Alert
          type={metrics.failed === 0 ? "success" : "warning"}
          showIcon
          style={{ marginBottom: 12 }}
          title={metrics.summaryLine}
          description={
            metrics.failed === 0 ? (
              "Suite PASS — không có fail category."
            ) : (
              <Space wrap size={[6, 6]} style={{ marginTop: 4 }}>
                {(
                  Object.entries(metrics.failByCategory) as [keyof typeof E2E_FAIL_CATEGORY_LABELS, number][]
                )
                  .sort((a, b) => b[1] - a[1])
                  .map(([cat, n]) => (
                    <Tag key={cat}>
                      {E2E_FAIL_CATEGORY_LABELS[cat]}: {n} (
                      {metrics.failSharePct[cat]}% fails · {metrics.suiteSharePct[cat]}%
                      suite)
                    </Tag>
                  ))}
              </Space>
            )
          }
        />
      ) : null}

      {jobPassed == null ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title={
            batchRunStatus === "paused"
              ? "Generate đang tạm dừng — có thể Kiểm thử tất cả phần đã gen"
              : "Chưa chạy Kiểm thử tất cả"
          }
          description={
            batchRunStatus === "paused"
              ? `Bấm Kiểm thử tất cả phần đã gen (${genOkCount} TC). PASS xong mới Apply.`
              : `Bấm Kiểm thử tất cả (${genOkCount}) để chạy Playwright cho mọi Spec đã Generate trong batch. PASS xong mới Apply vào AItest/E2ETest/.`
          }
        />
      ) : null}

      <Space
        wrap
        style={{ width: "100%", justifyContent: "space-between", marginBottom: 12 }}
      >
        <Space>
          <Typography.Text type="secondary">Runner</Typography.Text>
          <Tag>Playwright</Tag>
        </Space>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Gen OK {genOkCount}/{rows.length || genOkCount}
          {" · "}
          Verify {verifyPass}/{genOkCount}
        </Typography.Text>
      </Space>

      <Space wrap>
        <Button
          type="primary"
          icon={<PlayCircleOutlined />}
          onClick={onVerify}
          loading={verifyLoading}
          disabled={genOkCount === 0 || actionsLockedByGenerate || !onVerify}
        >
          {batchRunStatus === "paused"
            ? `Kiểm thử tất cả phần đã gen (${genOkCount})`
            : `Kiểm thử tất cả (${genOkCount})`}
        </Button>
        <Button
          icon={<ToolOutlined />}
          onClick={onHeal}
          loading={healLoading}
          disabled={!canHeal || actionsLockedByGenerate || !onHeal}
        >
          Heal (AI sửa)
        </Button>
        <Button
          icon={<SaveOutlined />}
          onClick={onApply}
          loading={applyLoading}
          disabled={!canApply || actionsLockedByGenerate || !onApply}
        >
          Apply vào AItest/E2ETest
        </Button>
        {hasStaging && onDiscard ? (
          <Button
            danger
            icon={<DeleteOutlined />}
            onClick={onDiscard}
            disabled={actionsLockedByGenerate}
          >
            Không Apply — Hủy bỏ
          </Button>
        ) : null}
      </Space>
    </Card>
  );
}
