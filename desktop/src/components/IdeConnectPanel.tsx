/**
 * P2/P5.5 — Connect IDE + live focus (stack-agnostic; VS Code / Cursor / …).
 */
import { useEffect } from "react";
import { Alert, Button, Space, Tag, Typography } from "antd";
import {
  ApiOutlined,
  ClearOutlined,
  DisconnectOutlined,
  LinkOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { dispatchIdeCommand } from "../lib/ideBridge/commandBus";
import { ideFocusReadyForGenerate } from "../lib/ideBridge/fromIdeSemantic";
import { isTauri } from "../tauri/bridge";

type Props = {
  /** Compact strip (legacy); default = hero strip for Generate */
  compact?: boolean;
  onFocusApplied?: (focus: {
    file: string;
    symbol: string;
    method?: string;
  }) => void;
};

export function IdeConnectPanel({ compact, onFocusApplied }: Props) {
  const status = useIdeBridgeSession((s) => s.status);
  const error = useIdeBridgeSession((s) => s.error);
  const ide = useIdeBridgeSession((s) => s.ide);
  const focus = useIdeBridgeSession((s) => s.focus);
  const workspaceRoot = useIdeBridgeSession((s) => s.workspaceRoot);
  const confidence = useIdeBridgeSession((s) => s.confidence);
  const language = useIdeBridgeSession((s) => s.language);
  const connect = useIdeBridgeSession((s) => s.connect);
  const disconnect = useIdeBridgeSession((s) => s.disconnect);
  const clearFocus = useIdeBridgeSession((s) => s.clearFocus);

  useEffect(() => {
    if (focus && onFocusApplied && ideFocusReadyForGenerate(confidence, true)) {
      onFocusApplied({
        file: focus.file,
        symbol: focus.symbol,
        method: focus.method,
      });
    }
  }, [focus, confidence, onFocusApplied]);

  const focusLabel = focus
    ? `${focus.symbol}${focus.method ? `.${focus.method}` : ""}`
    : status === "connected"
      ? "Caret tuỳ chọn (boost)"
      : "IDE offline — Apply vẫn OK";

  const ready =
    status === "connected" && ideFocusReadyForGenerate(confidence, Boolean(focus));
  const tauri = isTauri();

  return (
    <div
      className={`ide-connect-panel${ready ? " ide-connect-panel--ready" : ""}`}
      style={{
        display: "flex",
        flexDirection: "column",
        gap: compact ? 6 : 10,
        padding: compact ? "8px 10px" : "12px 14px",
        borderRadius: 10,
        border: "1px solid var(--border, #e5e7eb)",
        background: ready ? "rgba(82, 196, 26, 0.06)" : "var(--panel, #fafafa)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          flexWrap: "wrap",
        }}
      >
        <Space size={8} wrap>
          <ApiOutlined />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            IDE
          </Typography.Text>
          {status === "connected" ? (
            <Tag color="success">{ide ?? "ide"} · Connected</Tag>
          ) : status === "connecting" ? (
            <Tag>connecting…</Tag>
          ) : status === "error" ? (
            <Tag color="error">offline</Tag>
          ) : (
            <Tag>idle</Tag>
          )}
          {workspaceRoot ? (
            <Tag
              color={
                /aitest$/i.test(workspaceRoot.replace(/\\/g, "/")) ||
                /\/aitest$/i.test(workspaceRoot.replace(/\\/g, "/"))
                  ? "orange"
                  : "blue"
              }
              title={workspaceRoot}
            >
              WS: {workspaceRoot.replace(/\\/g, "/").split("/").slice(-2).join("/")}
            </Tag>
          ) : null}
          <Tag color={ready ? "blue" : "default"}>
            {ready ? "IDE context" : "Local FS fallback"}
          </Tag>
          <Typography.Text strong style={{ fontSize: compact ? 13 : 15 }}>
            Focus: {focusLabel}
          </Typography.Text>
          {focus?.file ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {focus.file}
            </Typography.Text>
          ) : null}
          {workspaceRoot ? (
            <Typography.Text type="secondary" style={{ fontSize: 11 }} title={workspaceRoot}>
              IDE root: {workspaceRoot.replace(/^.*[\\/]/, "")}
            </Typography.Text>
          ) : null}
          {language ? <Tag>{language}</Tag> : null}
          {confidence ? (
            <Tag
              color={
                confidence === "high" ? "blue" : confidence === "medium" ? "gold" : "default"
              }
            >
              {confidence}
            </Tag>
          ) : null}
        </Space>
        <Space wrap>
          {status === "connected" ? (
            <>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void connect()}
                title="Kết nối lại bridge — không tự lấy focus cũ; đặt caret hoặc Làm mới từ IDE"
              >
                Reconnect
              </Button>
              <Button
                size="small"
                icon={<ReloadOutlined />}
                onClick={() => void dispatchIdeCommand({ type: "ide.refreshFocus" })}
              >
                Làm mới từ IDE
              </Button>
              {focus ? (
                <Button
                  size="small"
                  icon={<ClearOutlined />}
                  onClick={() => clearFocus()}
                  title="Xóa caret boost trên Desktop (không đóng IDE). Đặt caret file mới rồi Làm mới từ IDE."
                >
                  Xóa focus
                </Button>
              ) : null}
              <Button size="small" icon={<DisconnectOutlined />} onClick={() => disconnect()}>
                Ngắt
              </Button>
            </>
          ) : (
            <Button
              size="small"
              type="primary"
              icon={<LinkOutlined />}
              loading={status === "connecting"}
              onClick={() => void connect()}
              disabled={!tauri}
            >
              Connect IDE (tuỳ chọn)
            </Button>
          )}
        </Space>
      </div>

      {status !== "connected" ? (
        <Alert
          type={!tauri ? "error" : "warning"}
          showIcon
          title={!tauri ? "Cần cửa sổ AITest Desktop (Tauri)" : "IDE viewer chưa kết nối (tuỳ chọn)"}
          description={
            !tauri ? (
              <span>
                Bạn đang mở UI trên trình duyệt — Connect sẽ không bao giờ thành công.
                Đóng tab Vite, chạy <Typography.Text code>npm run desktop</Typography.Text> và
                dùng cửa sổ <strong>AITest Desktop</strong> (không phải localhost:5173).
              </span>
            ) : (
              <span>
                Không bắt buộc để chạy Unit Job. Cài plugin AITest (Cursor / VS Code /{" "}
                <strong>Antigravity</strong>) chỉ khi muốn mở file / boost — rồi Reload Window.
                Status bar phải có <strong>AITest :port</strong>. Nếu thiếu: Command Palette →{" "}
                <strong>AITest: Start IDE Bridge</strong>, rồi bấm Connect IDE (tuỳ chọn).
                {error ? (
                  <>
                    {" "}
                    Lỗi: <Typography.Text type="danger">{error}</Typography.Text>
                  </>
                ) : null}
              </span>
            )
          }
        />
      ) : null}

      {!compact && status === "connected" && !ready ? (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Caret là boost tuỳ chọn — không bắt buộc để Unit Job. Bấm «Làm mới từ IDE» nếu muốn
          boost confidence.
        </Typography.Text>
      ) : null}
    </div>
  );
}
