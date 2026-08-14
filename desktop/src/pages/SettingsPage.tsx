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
import { AiCliEnvironmentPanel } from "../components/AiCliEnvironmentPanel";

const { Title, Paragraph, Text } = Typography;

/** Path ngầm theo vendor — không hiện trên UI; resolve qua PATH hệ thống. */
const CLI_DEFAULT_PATH: Record<string, string> = {
  "gemini-cli": "gemini",
  "cursor-cli": "agent",
  "claude-cli": "claude",
  "antigravity-cli": "agy",
  ollama: "ollama",
  "custom-script": "gemini",
};

const CLI_TYPES = [
  {
    value: "gemini-cli",
    label: "Gemini CLI",
    hint: "Lệnh: gemini (trên PATH)",
  },
  {
    value: "cursor-cli",
    label: "Cursor Agent CLI",
    hint: "Lệnh: agent (trên PATH) · khuyến nghị Pro + model auto",
  },
  {
    value: "claude-cli",
    label: "Claude Code CLI",
    hint: "Lệnh: claude (trên PATH)",
  },
  {
    value: "antigravity-cli",
    label: "Antigravity CLI",
    hint: "Lệnh: agy (trên PATH) · khác Antigravity IDE",
  },
  {
    value: "ollama",
    label: "Ollama CLI",
    hint: "Lệnh: ollama (trên PATH)",
  },
  {
    value: "custom-script",
    label: "Custom Script",
    hint: "Dùng vendor khác nếu cần CLI tùy chỉnh trên PATH",
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

function defaultCliPath(cliType: string): string {
  return CLI_DEFAULT_PATH[cliType] || "gemini";
}

function applyConnectionToForm(
  c: Connection,
  setters: {
    setConn: (c: Connection) => void;
    setModelName: (v: string) => void;
    setCliType: (v: string) => void;
  }
) {
  const type = c.cliType || "gemini-cli";
  setters.setConn(c);
  setters.setModelName(c.modelName ?? "");
  setters.setCliType(type);
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
      applyConnectionToForm(c, { setConn, setModelName, setCliType });
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
    return {
      provider: providerForCliType(cliType),
      modelName: modelName.trim(),
      runnerMode: "AI_CLI" as const,
      cliType,
      // Path ẩn: luôn tên lệnh mặc định theo vendor (gemini / agent / …)
      cliPath: defaultCliPath(cliType),
    };
  }

  async function onSaveOnly() {
    if (!projectId) return;
    setSaving(true);
    // Chặn load() đang bay đè form trong lúc save
    loadSeq.current += 1;
    try {
      const body = buildSaveBody();
      const c = await connection.save(projectId, body);
      applyConnectionToForm(c, { setConn, setModelName, setCliType });
      message.success("Đã lưu cấu hình AI CLI");
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Lưu thất bại");
    } finally {
      setSaving(false);
    }
  }

  /** Lưu cấu hình rồi verify CLI — một bước đến Ready. */
  async function onSaveAndTestCli() {
    if (!projectId) return;
    setVerifying(true);
    loadSeq.current += 1;
    try {
      const body = buildSaveBody();
      await connection.save(projectId, body);
      const c = await connection.verify(projectId);
      applyConnectionToForm(c, { setConn, setModelName, setCliType });
      if (c.status === "Ready") {
        message.success("Đã lưu · CLI Ready");
      } else {
        message.warning(`Đã lưu · trạng thái: ${c.status}`);
      }
    } catch (err) {
      message.error(err instanceof Error ? err.message : "Lưu & Test CLI thất bại");
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
  const savedCliType = conn?.cliType || "gemini-cli";
  const selectionChanged = cliType !== savedCliType;

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
              color={selectionChanged ? "warning" : statusTone(conn.status)}
              icon={
                !selectionChanged && conn.status === "Ready" ? (
                  <CheckCircleOutlined />
                ) : (
                  <SafetyCertificateOutlined />
                )
              }
            >
              {selectionChanged
                ? "CLI đã đổi · Chưa lưu"
                : conn.status === "Ready"
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
          onFinish={() => void onSaveAndTestCli()}
        >
          <div className="settings-ai-block">
            <div className="settings-ai-block-label">CLI</div>
            <Row gutter={[12, 0]}>
              <Col xs={24} md={12}>
                <Form.Item label="Vendor" required>
                  <Select
                    value={cliType}
                    onChange={(next) => setCliType(next)}
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
              <Col xs={24} md={12}>
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
              <Button
                type="primary"
                htmlType="submit"
                icon={<SafetyCertificateOutlined />}
                loading={verifying}
                disabled={locked && !verifying}
              >
                Lưu &amp; Test CLI
              </Button>
              <Button
                type="text"
                size="small"
                onClick={() => void onSaveOnly()}
                loading={saving}
                disabled={locked && !saving}
              >
                Chỉ lưu
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
              Một bước: lưu cấu hình + xác minh CLI đến Ready trước khi Sinh TC / Phân tích
            </Text>
          </div>
        </Form>
        <AiCliEnvironmentPanel
          cliType={cliType}
          backendReady={!selectionChanged && conn?.status === "Ready"}
          verifying={verifying}
          onVerify={onSaveAndTestCli}
        />
      </section>
    </div>
  );
}
