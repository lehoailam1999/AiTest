import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Col,
  Empty,
  Form,
  Input,
  Row,
  Select,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CodeOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
} from "@ant-design/icons";
import { connection } from "../api";
import type { Connection } from "../api/types";
import { useProject } from "../state/ProjectContext";
import { Link } from "react-router-dom";
import { ROUTES } from "../lib/productRoutes";

const { Title, Paragraph, Text } = Typography;

const CLI_TYPES = [
  {
    value: "gemini-cli",
    label: "Gemini CLI",
    hint: "google-gemini CLI · mặc định path: gemini",
  },
  {
    value: "claude-cli",
    label: "Claude Code CLI",
    hint: "Anthropic Claude Code · path: claude",
  },
  {
    value: "cursor-cli",
    label: "Cursor Agent CLI",
    hint: "agent / cursor-agent · khuyến nghị Pro + model auto",
  },
  { value: "ollama", label: "Ollama CLI", hint: "ollama run <model>" },
  {
    value: "custom-script",
    label: "Custom Script",
    hint: "Executable / script tùy chỉnh",
  },
] as const;

function statusTone(status?: string | null): "success" | "warning" | "error" | "default" {
  const s = (status || "").toLowerCase();
  if (s === "ready") return "success";
  if (s === "error" || s === "failed") return "error";
  if (s === "pending" || s === "verifying") return "warning";
  return "default";
}

function cliPathPlaceholder(cliType: string): string {
  switch (cliType) {
    case "claude-cli":
      return "claude";
    case "cursor-cli":
      return "agent";
    case "ollama":
      return "ollama";
    case "custom-script":
      return "C:\\tools\\my-aitest-cli.cmd";
    default:
      return "gemini";
  }
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const { project } = useProject();
  const [conn, setConn] = useState<Connection | null>(null);
  const [modelName, setModelName] = useState("");
  const [cliType, setCliType] = useState("gemini-cli");
  const [cliPath, setCliPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    if (!project) return;
    setBusy(true);
    try {
      const c = await connection.get(project.id);
      setConn(c);
      setModelName(c.modelName ?? "");
      setCliType(c.cliType || "gemini-cli");
      setCliPath(c.cliPath ?? "");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Không tải được cấu hình AI");
    } finally {
      setBusy(false);
    }
  }, [project, message]);

  useEffect(() => {
    void load();
  }, [load]);

  const cliHint = useMemo(
    () => CLI_TYPES.find((c) => c.value === cliType)?.hint ?? "",
    [cliType]
  );

  async function onSave() {
    if (!project) return;
    setSaving(true);
    try {
      const c = await connection.save(project.id, {
        provider: cliType === "ollama" ? "ollama" : "openai",
        modelName: modelName.trim() || undefined,
        runnerMode: "AI_CLI",
        cliType,
        cliPath: cliPath.trim() || undefined,
      });
      setConn(c);
      setCliType(c.cliType || "gemini-cli");
      setCliPath(c.cliPath ?? "");
      setModelName(c.modelName ?? "");
      message.success("Đã lưu cấu hình AI CLI");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  async function onVerify() {
    if (!project) return;
    setVerifying(true);
    try {
      // Always persist AI_CLI before verify (legacy Direct API configs must migrate)
      await connection.save(project.id, {
        provider: cliType === "ollama" ? "ollama" : "openai",
        modelName: modelName.trim() || undefined,
        runnerMode: "AI_CLI",
        cliType,
        cliPath: cliPath.trim() || undefined,
      });
      const c = await connection.verify(project.id);
      setConn(c);
      setCliType(c.cliType || "gemini-cli");
      setCliPath(c.cliPath ?? "");
      setModelName(c.modelName ?? "");
      if (c.status === "Ready") {
        message.success("CLI sẵn sàng — AI đã Ready");
      } else {
        message.warning(`Trạng thái: ${c.status}`);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Xác minh thất bại");
    } finally {
      setVerifying(false);
    }
  }

  if (!project) {
    return (
      <div className="page settings-ai-page">
        <header className="page-head settings-ai-head">
          <div>
            <Title level={3} className="settings-ai-title">
              Cấu hình AI
            </Title>
            <Paragraph type="secondary" className="page-lead">
              Chọn dự án trước khi thiết lập.
            </Paragraph>
          </div>
        </header>
        <Empty description="Chưa chọn dự án" className="settings-ai-empty">
          <Link to={ROUTES.projects}>
            <Button type="primary" size="middle">
              Đến tab Dự án
            </Button>
          </Link>
        </Empty>
      </div>
    );
  }

  const locked = busy || saving || verifying;

  return (
    <div className="page settings-ai-page">
      <header className="page-head settings-ai-head">
        <div>
          <Title level={3} className="settings-ai-title">
            Cấu hình AI
          </Title>
          <Paragraph type="secondary" className="page-lead">
            AI CLI · Sinh TC &amp; Phân tích · <Text strong>{project.name}</Text>
          </Paragraph>
        </div>
        <Space size={6} wrap className="page-head-actions">
          {conn ? (
            <Tag
              color={statusTone(conn.status)}
              icon={
                conn.status === "Ready" ? <CheckCircleOutlined /> : <SafetyCertificateOutlined />
              }
            >
              {conn.status}
            </Tag>
          ) : null}
          <Tag icon={<CodeOutlined />}>AI CLI</Tag>
        </Space>
      </header>

      {conn?.lastError ? (
        <Alert
          type="error"
          showIcon
          closable
          className="settings-ai-alert"
          message={conn.lastError}
        />
      ) : null}

      <section className="settings-ai-shell" aria-label="Cấu hình AI">
        <Form
          layout="vertical"
          size="middle"
          requiredMark={false}
          className="settings-ai-form"
          onFinish={() => void onSave()}
        >
          <div className="settings-ai-block">
            <div className="settings-ai-block-label">CLI</div>
            <Row gutter={[12, 0]}>
              <Col xs={24} md={8}>
                <Form.Item label="Vendor" required>
                  <Select
                    value={cliType}
                    onChange={setCliType}
                    options={CLI_TYPES.map((p) => ({
                      value: p.value,
                      label: p.label,
                    }))}
                    disabled={locked}
                  />
                </Form.Item>
                {cliHint ? (
                  <Text type="secondary" className="settings-field-hint">
                    {cliHint}
                  </Text>
                ) : null}
              </Col>
              <Col xs={24} md={8}>
                <Form.Item label="Path" required>
                  <Input
                    value={cliPath}
                    onChange={(e) => setCliPath(e.target.value)}
                    placeholder={cliPathPlaceholder(cliType)}
                    disabled={locked}
                    prefix={<CodeOutlined />}
                  />
                </Form.Item>
              </Col>
              <Col xs={24} md={8}>
                <Form.Item
                  label="Model"
                  tooltip="Cursor: trống = auto · Ollama: bắt buộc"
                >
                  <Input
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder={cliType === "ollama" ? "llama3.2" : "auto"}
                    disabled={locked}
                  />
                </Form.Item>
              </Col>
            </Row>
          </div>

          <div className="settings-ai-actions">
            <Space size={8} wrap>
              <Button type="primary" htmlType="submit" loading={saving} disabled={locked && !saving}>
                Lưu
              </Button>
              <Button
                icon={<SafetyCertificateOutlined />}
                onClick={() => void onVerify()}
                loading={verifying}
                disabled={locked && !verifying}
              >
                Test CLI
              </Button>
              <Button
                type="text"
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void load()}
                disabled={locked}
              >
                Tải lại
              </Button>
            </Space>
            <Text type="secondary" className="settings-ai-actions-hint">
              Lưu → Test CLI → Ready trước khi Sinh TC / Phân tích
            </Text>
          </div>
        </Form>
      </section>
    </div>
  );
}
