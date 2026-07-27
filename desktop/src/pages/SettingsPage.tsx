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
  ApiOutlined,
  CheckCircleOutlined,
  CloudServerOutlined,
  CodeOutlined,
  LinkOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { connection } from "../api";
import type { Connection } from "../api/types";
import { useProject } from "../state/ProjectContext";
import { Link } from "react-router-dom";
import { ROUTES } from "../lib/productRoutes";

const { Title, Paragraph, Text } = Typography;

const PROVIDERS = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "antigravity", label: "Antigravity (Google API / proxy)" },
] as const;

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
  const [provider, setProvider] = useState("openai");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [runnerMode, setRunnerMode] = useState("API_DIRECT");
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
      setProvider(c.provider || "openai");
      setModelName(c.modelName ?? "");
      setBaseUrl(c.baseUrl ?? "");
      setRunnerMode((c.runnerMode || "API_DIRECT").toUpperCase());
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

  const isCli = runnerMode === "AI_CLI";
  const isOllama = provider === "ollama";
  const isAntigravity = provider === "antigravity";
  const showBaseUrl = !isCli && (isOllama || isAntigravity);
  const apiKeyOptional =
    isCli ||
    isOllama ||
    (isAntigravity &&
      Boolean(baseUrl.trim()) &&
      /127\.0\.0\.1|localhost/i.test(baseUrl));

  const cliHint = useMemo(
    () => CLI_TYPES.find((c) => c.value === cliType)?.hint ?? "",
    [cliType]
  );

  async function onSave() {
    if (!project) return;
    setSaving(true);
    try {
      const c = await connection.save(project.id, {
        provider,
        modelName: modelName.trim() || undefined,
        ...(provider === "ollama" || provider === "antigravity"
          ? { baseUrl: baseUrl.trim() || "" }
          : {}),
        apiKey: apiKey.trim() || undefined,
        runnerMode,
        cliType,
        cliPath: cliPath.trim() || undefined,
      });
      setConn(c);
      setBaseUrl(c.baseUrl ?? "");
      setRunnerMode((c.runnerMode || "API_DIRECT").toUpperCase());
      setCliType(c.cliType || "gemini-cli");
      setCliPath(c.cliPath ?? "");
      setApiKey("");
      message.success("Đã lưu cấu hình AI");
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
      const c = await connection.verify(project.id);
      setConn(c);
      if (c.status === "Ready") {
        message.success(
          isCli ? "CLI sẵn sàng — AI đã Ready" : "Xác minh thành công — AI đã Ready"
        );
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
            Sinh TC &amp; Phân tích · <Text strong>{project.name}</Text>
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
          {conn?.hasApiKey && !isCli ? <Tag color="processing">Key đã lưu</Tag> : null}
          {isCli ? <Tag icon={<CodeOutlined />}>AI CLI</Tag> : <Tag icon={<ApiOutlined />}>API</Tag>}
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
        <div className="settings-ai-block">
          <div className="settings-ai-block-label">Engine</div>
          <div className="settings-engine-grid" role="radiogroup" aria-label="Engine mode">
            <button
              type="button"
              role="radio"
              aria-checked={!isCli}
              className={`settings-engine-card${!isCli ? " is-active" : ""}`}
              onClick={() => setRunnerMode("API_DIRECT")}
              disabled={locked}
            >
              <span className="settings-engine-icon" aria-hidden>
                <CloudServerOutlined />
              </span>
              <span className="settings-engine-body">
                <strong>Direct API</strong>
                <span>REST · API Key</span>
              </span>
            </button>
            <button
              type="button"
              role="radio"
              aria-checked={isCli}
              className={`settings-engine-card${isCli ? " is-active" : ""}`}
              onClick={() => setRunnerMode("AI_CLI")}
              disabled={locked}
            >
              <span className="settings-engine-icon settings-engine-icon--cli" aria-hidden>
                <ThunderboltOutlined />
              </span>
              <span className="settings-engine-body">
                <strong>
                  AI CLI <em className="settings-engine-badge">khuyến nghị</em>
                </strong>
                <span>Subprocess local · tiết kiệm token</span>
              </span>
            </button>
          </div>
        </div>

        <Form
          layout="vertical"
          size="middle"
          requiredMark={false}
          className="settings-ai-form"
          onFinish={() => void onSave()}
        >
          <div className="settings-ai-block">
            <div className="settings-ai-block-label">
              {isCli ? "CLI" : "Nhà cung cấp"}
            </div>

            {isCli ? (
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
            ) : (
              <Row gutter={[12, 0]}>
                <Col xs={24} md={8}>
                  <Form.Item label="Provider" required>
                    <Select
                      value={provider}
                      onChange={setProvider}
                      options={[...PROVIDERS]}
                      disabled={locked}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    label="Model"
                    tooltip={
                      isOllama
                        ? "vd. llama3.2"
                        : isAntigravity
                          ? "vd. gemini-2.0-flash"
                          : "Trống = mặc định"
                    }
                  >
                    <Input
                      value={modelName}
                      onChange={(e) => setModelName(e.target.value)}
                      placeholder={
                        isAntigravity ? "gemini-2.0-flash" : "mặc định"
                      }
                      disabled={locked}
                    />
                  </Form.Item>
                </Col>
                <Col xs={24} md={8}>
                  <Form.Item
                    label={apiKeyOptional ? "API Key (tuỳ chọn)" : "API Key"}
                    required={!apiKeyOptional}
                  >
                    <Input.Password
                      value={apiKey}
                      onChange={(e) => setApiKey(e.target.value)}
                      placeholder={
                        conn?.hasApiKey
                          ? "•••• đã lưu — nhập để thay"
                          : "Nhập API key"
                      }
                      disabled={locked}
                      autoComplete="off"
                    />
                  </Form.Item>
                </Col>
                {showBaseUrl ? (
                  <Col xs={24}>
                    <Form.Item
                      label={
                        isAntigravity ? "Base URL (tuỳ chọn)" : "Base URL"
                      }
                    >
                      <Input
                        value={baseUrl}
                        onChange={(e) => setBaseUrl(e.target.value)}
                        placeholder={
                          isAntigravity
                            ? "http://127.0.0.1:11435/v1"
                            : "http://127.0.0.1:11434"
                        }
                        disabled={locked}
                        prefix={<LinkOutlined />}
                      />
                    </Form.Item>
                  </Col>
                ) : null}
                {isAntigravity ? (
                  <Col xs={24}>
                    <Text
                      type="secondary"
                      className="settings-field-hint settings-field-hint--block"
                    >
                      Antigravity: mặc định giống Gemini (API Key + model). Chỉ điền Base URL khi
                      dùng proxy.
                    </Text>
                  </Col>
                ) : null}
              </Row>
            )}
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
                {isCli ? "Test CLI" : "Xác minh"}
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
              Lưu → Xác minh → Ready trước khi Sinh TC / Phân tích
            </Text>
          </div>
        </Form>
      </section>
    </div>
  );
}
