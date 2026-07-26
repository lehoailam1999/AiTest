/**
 * V2.1 Agent Run panel — Analyze → Retrieve → Packet → Generate (P0).
 */
import type { ReactNode } from "react";
import { Alert, Button, Card, Progress, Space, Steps, Tag, Typography } from "antd";
import type {
  AgentRunPhase,
  BusinessIntent,
  ConfidenceReport,
  RetrievedFile,
} from "@aitest/ide-protocol";

type Props = {
  phase: AgentRunPhase;
  intent: BusinessIntent | null;
  retrieved: RetrievedFile[];
  confidence: ConfidenceReport | null;
  error?: string | null;
  /** P0 — frozen packet summary */
  packetReady?: boolean;
  primaryPath?: string | null;
  framework?: string | null;
  language?: string | null;
  fileCount?: number;
  override?: boolean;
  onContinueRetrieve?: () => void;
  onGenerate?: () => void;
  onOverrideGenerate?: () => void;
  generateDisabled?: boolean;
  generateLoading?: boolean;
  /** IDE workspace ≠ Root Apply — block retrieve/focus with clear CTA */
  rootsMismatch?: boolean;
  mismatchBanner?: React.ReactNode;
};

const PHASE_INDEX: Record<AgentRunPhase, number> = {
  idle: 0,
  analyzing: 0,
  planning: 1,
  retrieving: 2,
  evaluating: 3,
  needs_user: 3,
  generating: 4,
  done: 4,
  error: 0,
};

export function AgentRunPanel({
  phase,
  intent,
  retrieved,
  confidence,
  error,
  packetReady,
  primaryPath,
  framework,
  language,
  fileCount,
  override,
  onContinueRetrieve,
  onGenerate,
  onOverrideGenerate,
  generateDisabled,
  generateLoading,
  rootsMismatch,
  mismatchBanner,
}: Props) {
  if (phase === "idle" && !intent && !rootsMismatch) return null;

  const step = PHASE_INDEX[phase] ?? 0;
  const enough = confidence?.enough ?? false;
  const blockedByRoots = Boolean(rootsMismatch);

  return (
    <Card
      size="small"
      title="Agent Run — TC → IDE context → Sinh unit"
      style={{ marginTop: 8 }}
      extra={
        phase !== "idle" || blockedByRoots ? (
          <Tag
            color={
              blockedByRoots
                ? "warning"
                : phase === "error"
                  ? "error"
                  : enough
                    ? "success"
                    : "processing"
            }
          >
            {blockedByRoots ? "lệch thư mục" : phase}
          </Tag>
        ) : null
      }
    >
      {blockedByRoots && mismatchBanner ? (
        <div style={{ marginBottom: 12 }}>{mismatchBanner}</div>
      ) : null}

      {blockedByRoots ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="Chưa gắn focus / retrieve IDE vì lệch thư mục"
          description="Khớp Root Apply với folder Cursor (hoặc Open Folder đúng repo) rồi Analyze lại."
        />
      ) : null}

      <Steps
        size="small"
        current={step}
        style={{ marginBottom: 16 }}
        items={[
          { title: "Phân tích TC" },
          { title: "Kế hoạch" },
          { title: "Lấy context IDE" },
          { title: "Packet" },
          { title: "Sinh mã" },
        ]}
      />

      {error ? (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />
      ) : null}

      {intent ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Business intent
          </Typography.Text>
          <Space wrap style={{ display: "flex", marginTop: 6 }}>
            <Tag color="blue">Action: {intent.action}</Tag>
            <Tag color="purple">Entity: {intent.entity}</Tag>
            {intent.expectedResults.slice(0, 4).map((e) => (
              <Tag key={e}>{e.length > 40 ? `${e.slice(0, 40)}…` : e}</Tag>
            ))}
            {intent.externalDeps.map((d) => (
              <Tag key={d} color="orange">
                {d}
              </Tag>
            ))}
          </Space>
          {intent.searchHints.length > 0 ? (
            <Typography.Paragraph
              type="secondary"
              style={{ marginTop: 8, marginBottom: 0, fontSize: 12 }}
            >
              Search hints: {intent.searchHints.slice(0, 8).join(" · ")}
            </Typography.Paragraph>
          ) : null}
        </div>
      ) : null}

      {retrieved.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Retrieved ({retrieved.length})
          </Typography.Text>
          <Space orientation="vertical" size={4} style={{ width: "100%", marginTop: 6 }}>
            {retrieved.map((f) => (
              <Typography.Text key={`${f.path}-${f.role}`} style={{ fontSize: 12 }} code>
                [{f.role}] {f.path}
                {typeof f.score === "number" ? ` · ${(f.score * 100).toFixed(0)}%` : ""}
              </Typography.Text>
            ))}
          </Space>
        </div>
      ) : null}

      {confidence ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Confidence overall {(confidence.overall * 100).toFixed(0)}%
            {confidence.enough ? " · đủ để sinh" : " · cần thêm context / override"}
          </Typography.Text>
          <Progress
            percent={Math.round(confidence.overall * 100)}
            status={confidence.enough ? "success" : "active"}
            size="small"
            style={{ marginTop: 6, maxWidth: 320 }}
          />
          <Space orientation="vertical" size={4} style={{ width: "100%", marginTop: 8 }}>
            {confidence.candidates.slice(0, 5).map((c) => (
              <div key={`${c.path}-${c.symbol}`}>
                <Typography.Text style={{ fontSize: 12 }}>
                  {c.symbol}{" "}
                  <Typography.Text type="secondary">({c.path})</Typography.Text>
                </Typography.Text>
                <Progress percent={Math.round(c.score * 100)} size="small" showInfo={false} />
              </div>
            ))}
          </Space>
          {!confidence.enough && confidence.missingHints.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginTop: 8 }}
              title="Thiếu context"
              description={confidence.missingHints.join(" · ")}
            />
          ) : null}
        </div>
      ) : null}

      {packetReady ? (
        <Alert
          type={enough || override ? "success" : "info"}
          showIcon
          style={{ marginBottom: 12 }}
          title="Context packet đã sẵn sàng cho Sinh unit"
          description={
            <Space orientation="vertical" size={2} style={{ width: "100%" }}>
              <Typography.Text style={{ fontSize: 12 }}>
                Primary: <code>{primaryPath || "—"}</code>
              </Typography.Text>
              <Typography.Text style={{ fontSize: 12 }}>
                {language || "—"} · {framework || "auto"} · {fileCount ?? 0} file trong packet
              </Typography.Text>
              {override && !enough ? (
                <Typography.Text type="warning" style={{ fontSize: 12 }}>
                  Đang Sinh với override (confidence chưa đủ — đã ghi nhận).
                </Typography.Text>
              ) : null}
            </Space>
          }
        />
      ) : phase === "retrieving" || phase === "analyzing" || phase === "planning" ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title="Đang dựng context từ IDE…"
        />
      ) : null}

      <Space wrap>
        {onContinueRetrieve && !enough ? (
          <Button onClick={onContinueRetrieve} disabled={blockedByRoots}>
            Tiếp tục lấy context
          </Button>
        ) : null}
        {onGenerate ? (
          <Button
            type="primary"
            onClick={onGenerate}
            loading={generateLoading}
            disabled={generateDisabled || blockedByRoots}
          >
            Sinh unit từ packet
          </Button>
        ) : null}
        {onOverrideGenerate && packetReady && !enough && !override ? (
          <Button
            onClick={onOverrideGenerate}
            disabled={generateLoading || blockedByRoots}
          >
            Sinh anyway (override)
          </Button>
        ) : null}
      </Space>
    </Card>
  );
}
