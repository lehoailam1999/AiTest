/**
 * P2/P5.5 — Connect IDE + live focus (stack-agnostic; VS Code / Cursor / …).
 * Primary home: Modal Tạo/Sửa dự án (cùng gắn source root). Unit/E2E link về Dự án → Sửa.
 */
import { useEffect } from "react";
import { Alert, Button, Space, Tag, Typography } from "antd";
import {
  ApiOutlined,
  ClearOutlined,
  ReloadOutlined,
} from "@ant-design/icons";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { dispatchIdeCommand } from "../lib/ideBridge/commandBus";
import { ideFocusReadyForGenerate } from "../lib/ideBridge/fromIdeSemantic";
import { isTauri } from "../tauri/bridge";
import { DownloadOutlined } from "@ant-design/icons";
import { App } from "antd";

type Props = {
  /** Compact strip (legacy); default = hero strip for Generate */
  compact?: boolean;
  /** Optional project root path to auto-check against IDE workspace */
  projectPath?: string | null;
  onFocusApplied?: (focus: {
    file: string;
    symbol: string;
    method?: string;
  }) => void;
};

function formatIdeName(raw?: string | null): string {
  if (!raw) return "IDE";
  const lower = raw.toLowerCase();
  if (lower === "antigravity") return "Antigravity IDE";
  if (lower === "cursor") return "Cursor";
  if (lower === "vscode") return "VS Code";
  return raw.charAt(0).toUpperCase() + raw.slice(1);
}

export function IdeConnectPanel({ compact, projectPath, onFocusApplied }: Props) {
  const { message } = App.useApp();
  const status = useIdeBridgeSession((s) => s.status);
  const error = useIdeBridgeSession((s) => s.error);
  const ide = useIdeBridgeSession((s) => s.ide);
  const focus = useIdeBridgeSession((s) => s.focus);
  const workspaceRoot = useIdeBridgeSession((s) => s.workspaceRoot);
  const confidence = useIdeBridgeSession((s) => s.confidence);
  const language = useIdeBridgeSession((s) => s.language);
  const detectedIde = useIdeBridgeSession((s) => s.detectedIde);
  const detectedWorkspaceRoot = useIdeBridgeSession((s) => s.detectedWorkspaceRoot);
  const extensionMissing = useIdeBridgeSession((s) => s.extensionMissing);
  const installingExtension = useIdeBridgeSession((s) => s.installingExtension);
  const pendingIdeReload = useIdeBridgeSession((s) => s.pendingIdeReload);
  const lastInstallMessage = useIdeBridgeSession((s) => s.lastInstallMessage);
  const installError = useIdeBridgeSession((s) => s.installError);
  const extensionPath = useIdeBridgeSession((s) => s.extensionPath);
  const availableIDEs = useIdeBridgeSession((s) => s.availableIDEs);
  const connectToDiscovery = useIdeBridgeSession((s) => s.connectToDiscovery);
  const autoConnectIfMatching = useIdeBridgeSession((s) => s.autoConnectIfMatching);
  const installExtension = useIdeBridgeSession((s) => s.installExtension);
  const clearFocus = useIdeBridgeSession((s) => s.clearFocus);
  const disconnect = useIdeBridgeSession((s) => s.disconnect);

  const tauri = isTauri();

  useEffect(() => {
    if (!projectPath || !projectPath.trim()) {
      if (status === "connected" || status === "connecting") {
        disconnect();
      }
      return;
    }
    if (!tauri) return;
    void autoConnectIfMatching(projectPath);
    if (status !== "connected") {
      const timer = setInterval(() => {
        void autoConnectIfMatching(projectPath);
      }, 3000);
      return () => clearInterval(timer);
    }
  }, [tauri, projectPath, status, autoConnectIfMatching, disconnect]);

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
            <Tag color="success">{formatIdeName(ide)} · Connected</Tag>
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
        {status === "connected" ? (
          <Space wrap>
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
                title="Xóa caret boost trên Desktop (không đóng IDE)."
              >
                Xóa focus
              </Button>
            ) : null}
          </Space>
        ) : null}
      </div>

      {extensionMissing && status !== "connected" && tauri ? (
        <Alert
          type="info"
          showIcon
          message="Chưa tìm thấy Extension aitest-ide trong IDE (Cursor / VS Code / Antigravity)"
          description={
            <div style={{ marginTop: 4 }}>
              <Typography.Text style={{ fontSize: 13, display: "block", marginBottom: 6 }}>
                Tool đang tự cài Extension <Typography.Text code>aitest-ide</Typography.Text> vào
                các trình soạn thảo trên máy bạn — không cần gõ lệnh. Nếu chưa xong, bấm nút dưới
                để cài lại.
              </Typography.Text>
              <Button
                type="primary"
                size="small"
                icon={<DownloadOutlined />}
                loading={installingExtension}
                onClick={async () => {
                  try {
                    const msg = await installExtension();
                    message.success(msg);
                  } catch (e) {
                    message.error(
                      e instanceof Error ? e.message : "Tự động cài đặt thất bại"
                    );
                  }
                }}
              >
                ⚡ Tự động cài đặt Extension ngay
              </Button>
            </div>
          }
        />
      ) : null}

      {pendingIdeReload && status !== "connected" ? (
        <Alert
          type="success"
          showIcon
          message="Đã cài Extension — cần reload IDE để bridge khởi động"
          description={
            <div style={{ marginTop: 4 }}>
              <Typography.Text style={{ fontSize: 13, display: "block" }}>
                Trong Cursor / VS Code / Antigravity: Command Palette (Ctrl+Shift+P) →{" "}
                <Typography.Text code>Developer: Reload Window</Typography.Text>, hoặc chạy{" "}
                <Typography.Text code>AITest: Start IDE Bridge</Typography.Text>. Status bar sẽ
                hiện <Typography.Text code>AITest :port</Typography.Text> và Desktop tự kết nối
                ngay sau đó.
              </Typography.Text>
              {lastInstallMessage ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {lastInstallMessage}
                </Typography.Text>
              ) : null}
            </div>
          }
        />
      ) : null}

      {status !== "connected" && !extensionMissing && !pendingIdeReload ? (
        <Alert
          type={!tauri ? "error" : "warning"}
          showIcon
          title={
            !tauri
              ? "Cần cửa sổ AITest Desktop (Tauri)"
              : detectedWorkspaceRoot && detectedWorkspaceRoot.trim()
                ? `Chưa mở thư mục ${projectPath?.split(/[\\/]/).pop() || "dự án"} trong ${formatIdeName(detectedIde)}`
                : "Tự động chờ kết nối từ IDE..."
          }
          description={
            !tauri ? (
              <span>
                Bạn đang mở UI trên trình duyệt — Tự động kết nối chỉ hoạt động trên cửa sổ <strong>AITest Desktop App</strong>.
              </span>
            ) : !projectPath || !projectPath.trim() ? (
              <span>
                Nhập hoặc chọn <strong>Thư mục source (project root)</strong> ở trên để hệ thống tự động nhận diện và kết nối IDE.
              </span>
            ) : detectedWorkspaceRoot && detectedWorkspaceRoot.trim() ? (
              <span>
                Trình soạn thảo <strong>{formatIdeName(detectedIde)}</strong> hiện đang mở thư mục khác: <Typography.Text code>{detectedWorkspaceRoot}</Typography.Text>.<br />
                Mở thư mục <Typography.Text code>{projectPath.trim()}</Typography.Text> trong <strong>{formatIdeName(detectedIde)} / Cursor / VS Code</strong> để tự động nhận diện & kết nối live context!
              </span>
            ) : (
              <span>
                Hệ thống sẽ tự động nhận diện và kết nối ngay khi bạn mở thư mục <Typography.Text code>{projectPath.trim()}</Typography.Text> trong Cursor / VS Code / Antigravity IDE.
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

      {tauri && status !== "connected" ? (
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 10,
            flexWrap: "wrap",
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }} title={extensionPath ?? ""}>
            Extension aitest-ide:{" "}
            {extensionMissing
              ? "chưa cài"
              : extensionPath
                ? `đã cài (${extensionPath.replace(/^.*[\\/]/, "")})`
                : "đã cài"}
          </Typography.Text>
          <Button
            size="small"
            icon={<DownloadOutlined />}
            loading={installingExtension}
            onClick={async () => {
              try {
                const msg = await installExtension();
                message.success(msg);
              } catch (e) {
                message.error(e instanceof Error ? e.message : "Cài Extension thất bại");
              }
            }}
          >
            {extensionMissing ? "Cài Extension" : "Cài lại Extension"}
          </Button>
        </div>
      ) : null}

      {installError ? (
        <Alert
          type="error"
          showIcon
          message="Tự động cài Extension thất bại"
          description={installError}
        />
      ) : null}

      {availableIDEs.length > 0 ? (
        <div
          style={{
            marginTop: 4,
            padding: "8px 10px",
            background: "var(--panel-subtle, #f5f5f5)",
            borderRadius: 8,
            border: "1px dashed var(--border, #d9d9d9)",
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            💻 Các IDE đang mở trên máy ({availableIDEs.length}) — Bấm vào để kết nối trực tiếp:
          </Typography.Text>
          <Space wrap size={6}>
            {availableIDEs.map((item) => {
              const itemWs = item.workspaceRoot
                ? item.workspaceRoot.replace(/\\/g, "/").split("/").slice(-2).join("/")
                : "No Folder";
              const isSelected =
                workspaceRoot === item.workspaceRoot && status === "connected";
              return (
                <Tag
                  key={`${item.port}-${item.workspaceRoot}`}
                  color={isSelected ? "success" : "processing"}
                  style={{
                    cursor: "pointer",
                    padding: "4px 10px",
                    borderRadius: 6,
                    fontSize: 12,
                    fontWeight: isSelected ? 600 : 400,
                  }}
                  onClick={() => {
                    void connectToDiscovery(item);
                  }}
                  title={`Bấm để kết nối tới ${formatIdeName(item.ide)} (${item.workspaceRoot ?? "No path"}) qua Port ${item.port}`}
                >
                  {isSelected ? "🟢 " : "⚡ Connect "}
                  <strong>{formatIdeName(item.ide)}</strong>: {itemWs} (Port {item.port})
                </Tag>
              );
            })}
          </Space>
        </div>
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
