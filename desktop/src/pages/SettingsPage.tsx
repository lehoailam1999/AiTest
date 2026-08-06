import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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
import { aiConnectionDisplayLabel } from "../lib/aiConnectionLabel";

const { Title, Paragraph, Text } = Typography;

const CLI_TYPES = [
  {
    value: "gemini-cli",
    label: "Gemini CLI",
    hint: "google-gemini CLI · mặc định path: gemini",
  },
  {
    value: "antigravity-cli",
    label: "Antigravity CLI",
    hint: "Google Antigravity CLI (`agy`) — khác Antigravity IDE. Cài: irm https://antigravity.google/cli/install.ps1 | iex · Path: %LOCALAPPDATA%\\agy\\bin\\agy.exe",
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

function providerForCliType(cliType: string): string {
  if (cliType === "ollama") return "ollama";
  if (cliType === "antigravity-cli") return "antigravity";
  return "openai";
}

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
    case "antigravity-cli":
      return "agy";
    case "ollama":
      return "ollama";
    case "custom-script":
      return "C:\\tools\\my-aitest-cli.cmd";
    default:
      return "gemini";
  }
}

/** Basename of a CLI path for mismatch checks (agent.cmd → agent). */
function cliPathBasename(path: string): string {
  const norm = path.trim().replace(/\\/g, "/");
  const base = norm.split("/").pop() || norm;
  return base.replace(/\.(cmd|exe|bat|ps1)$/i, "").toLowerCase();
}

const CLI_DEFAULT_BASENAMES: Record<string, string[]> = {
  "gemini-cli": ["gemini"],
  "antigravity-cli": ["agy", "antigravity"],
  "claude-cli": ["claude"],
  "cursor-cli": ["agent", "cursor-agent", "cursor"],
  ollama: ["ollama"],
};

function applyConnectionToForm(
  c: Connection,
  setters: {
    setConn: (c: Connection) => void;
    setModelName: (v: string) => void;
    setCliType: (v: string) => void;
    setCliPath: (v: string) => void;
  }
) {
  const type = c.cliType || "gemini-cli";
  setters.setConn(c);
  setters.setModelName(c.modelName ?? "");
  setters.setCliType(type);
  setters.setCliPath((c.cliPath ?? "").trim() || cliPathPlaceholder(type));
}

export default function SettingsPage() {
  const { message } = App.useApp();
  const messageRef = useRef(message);
  messageRef.current = message;
  const { project } = useProject();
  const projectId = project?.id ?? null;
  const [conn, setConn] = useState<Connection | null>(null);
  const [modelName, setModelName] = useState("");
  const [cliType, setCliType] = useState("gemini-cli");
  const [cliPath, setCliPath] = useState("");
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [verifying, setVerifying] = useState(false);
  const loadSeq = useRef(0);

  const load = useCallback(async () => {
    if (!projectId) return;
    const seq = ++loadSeq.current;
    setBusy(true);
    try {
      const c = await connection.get(projectId);
      if (seq !== loadSeq.current) return; // stale — bỏ qua, không đè form
      applyConnectionToForm(c, { setConn, setModelName, setCliType, setCliPath });
    } catch (e) {
      if (seq !== loadSeq.current) return;
      messageRef.current.error(
        e instanceof Error ? e.message : "Không tải được cấu hình AI"
      );
    } finally {
      if (seq === loadSeq.current) setBusy(false);
    }
  }, [projectId]);

  useEffect(() => {
    void load();
  }, [load]);

  const cliHint = useMemo(
    () => CLI_TYPES.find((c) => c.value === cliType)?.hint ?? "",
    [cliType]
  );

  function buildSaveBody() {
    const resolvedPath = cliPath.trim() || cliPathPlaceholder(cliType);
    return {
      provider: providerForCliType(cliType),
      modelName: modelName.trim(),
      runnerMode: "AI_CLI" as const,
      cliType,
      // Luôn gửi path — undefined bị JSON bỏ → BE giữ path cũ (agent)
      cliPath: resolvedPath,
    };
  }

  async function onSave() {
    if (!projectId) return;
    setSaving(true);
    // Chặn load() đang bay đè form trong lúc save
    loadSeq.current += 1;
    try {
      const body = buildSaveBody();
      setCliPath(body.cliPath);
      const c = await connection.save(projectId, body);
      applyConnectionToForm(c, { setConn, setModelName, setCliType, setCliPath });
      message.success("Đã lưu cấu hình AI CLI");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  async function onVerify() {
    if (!projectId) return;
    setVerifying(true);
    loadSeq.current += 1;
    try {
      const body = buildSaveBody();
      setCliPath(body.cliPath);
      await connection.save(projectId, body);
      const c = await connection.verify(projectId);
      applyConnectionToForm(c, { setConn, setModelName, setCliType, setCliPath });
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
              {conn.status === "Ready"
                ? `Ready · ${aiConnectionDisplayLabel(conn) || "AI CLI"}`
                : conn.status}
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
                    onChange={(next) => {
                      const prevDefault = cliPathPlaceholder(cliType);
                      const nextDefault = cliPathPlaceholder(next);
                      const cur = cliPath.trim();
                      const curBase = cliPathBasename(cur);
                      const prevBases = CLI_DEFAULT_BASENAMES[cliType] || [
                        cliPathBasename(prevDefault),
                      ];
                      // Đổi vendor → auto đổi Path nếu đang trống hoặc còn path mặc định vendor cũ
                      if (!cur || prevBases.includes(curBase) || cur === prevDefault) {
                        setCliPath(nextDefault);
                      }
                      setCliType(next);
                    }}
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
                  tooltip="Cursor: trống = auto · Antigravity: slug từ `agy models` · Ollama: bắt buộc"
                >
                  <Input
                    value={modelName}
                    onChange={(e) => setModelName(e.target.value)}
                    placeholder={
                      cliType === "ollama"
                        ? "llama3.2"
                        : cliType === "antigravity-cli"
                          ? "gemini-3.5-flash-medium"
                          : "auto"
                    }
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
