import { Alert, Button, Space, Tag, Typography } from "antd";
import { FolderOpenOutlined, ReloadOutlined, SearchOutlined } from "@ant-design/icons";
import { autoDetectCliIds, getAiCliSpec } from "../lib/aiCli/registry";
import type { AiCliDetectResult, AiCliStatus } from "../lib/aiCli/types";
import { useAiCliDetect } from "../state/AiCliContext";

const { Text } = Typography;

function tone(status: AiCliStatus): "success" | "warning" | "error" | "default" {
  if (status === "READY") return "success";
  if (status === "FOUND" || status === "NOT_AUTHENTICATED") return "warning";
  if (status === "INVALID" || status === "ERROR") return "error";
  return "default";
}

function mark(status: AiCliStatus): string {
  if (status === "READY") return "✅ READY";
  if (status === "NOT_FOUND") return "❌ NOT FOUND";
  if (status === "NOT_AUTHENTICATED") return "⚠️ NOT AUTHENTICATED";
  if (status === "FOUND") return "⚠️ FOUND";
  if (status === "INVALID") return "❌ INVALID";
  return "❌ ERROR";
}

function rowFor(
  id: ReturnType<typeof autoDetectCliIds>[number],
  results: AiCliDetectResult[]
): AiCliDetectResult | undefined {
  return results.find((r) => r.provider === id);
}

export function AiCliEnvironmentPanel() {
  const { results, detecting, lastError, refresh, detectOne, selectExecutable } =
    useAiCliDetect();

  return (
    <div className="ai-cli-env" aria-label="AI CLI Environment">
      <div className="settings-ai-block-label">AI CLI Environment</div>
      <Text type="secondary" className="ai-cli-env-lead">
        Detect trên máy này — không gửi path/credential lên Backend.
      </Text>
      {lastError ? (
        <Alert type="error" showIcon className="ai-cli-env-alert" message={lastError} />
      ) : null}
      <div className="ai-cli-env-list">
        {autoDetectCliIds().map((id) => {
          const spec = getAiCliSpec(id);
          const row = rowFor(id, results);
          const status = row?.status ?? "NOT_FOUND";
          return (
            <div key={id} className="ai-cli-env-row">
              <div className="ai-cli-env-row-main">
                <div className="ai-cli-env-name">{spec?.name ?? id}</div>
                <Tag color={tone(status)}>{mark(status)}</Tag>
              </div>
              {row?.version ? (
                <div className="ai-cli-env-meta">
                  Version: <Text code>{row.version}</Text>
                </div>
              ) : null}
              {row?.executablePath ? (
                <div className="ai-cli-env-meta ai-cli-env-path">
                  Path: <Text code>{row.executablePath}</Text>
                </div>
              ) : null}
              {row?.message && status !== "READY" ? (
                <div className="ai-cli-env-meta">{row.message}</div>
              ) : null}
              <Space size={6} wrap className="ai-cli-env-row-actions">
                <Button
                  size="small"
                  icon={<SearchOutlined />}
                  disabled={detecting}
                  onClick={() => void detectOne(id, { clearManual: true })}
                >
                  Auto Detect
                </Button>
                <Button
                  size="small"
                  icon={<FolderOpenOutlined />}
                  disabled={detecting}
                  onClick={() => void selectExecutable(id)}
                >
                  Select Executable
                </Button>
              </Space>
            </div>
          );
        })}
      </div>
      <Button
        icon={<ReloadOutlined />}
        onClick={() => void refresh()}
        loading={detecting}
      >
        Refresh
      </Button>
    </div>
  );
}
