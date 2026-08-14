import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Space, Tag, Typography } from "antd";
import {
  CheckCircleOutlined,
  CopyOutlined,
  CloseCircleOutlined,
  ExportOutlined,
  FolderOpenOutlined,
  LoginOutlined,
  ReloadOutlined,
  SafetyCertificateOutlined,
  SearchOutlined,
  SyncOutlined,
} from "@ant-design/icons";
import {
  aiCliConnectionState,
  aiCliFailureMessage,
  type AiCliRecoveryState,
} from "../lib/aiCli/connectionState";
import { getAiCliSpec, parseAiCliId } from "../lib/aiCli/registry";
import { getAiCliSetupGuide } from "../lib/aiCli/setupGuides";
import { useAiCliDetect } from "../state/AiCliContext";
import { openExternalUrl } from "../tauri/bridge";

const { Text } = Typography;

type Props = {
  cliType: string;
  backendReady: boolean;
  verifying?: boolean;
  onVerify: () => Promise<void>;
};

export function AiCliEnvironmentPanel({
  cliType,
  backendReady,
  verifying = false,
  onVerify,
}: Props) {
  const { results, detecting, lastError, detectOne, selectExecutable } = useAiCliDetect();
  const selectedId = parseAiCliId(cliType);
  const [recovery, setRecovery] = useState<AiCliRecoveryState>("idle");
  const [copied, setCopied] = useState<"install" | "login" | null>(null);
  const [docsError, setDocsError] = useState<string | null>(null);

  const result = useMemo(
    () => results.find((row) => row.provider === selectedId),
    [results, selectedId]
  );
  const state = aiCliConnectionState(result, detecting, recovery, backendReady);
  const spec = selectedId ? getAiCliSpec(selectedId) : undefined;
  const guide = selectedId ? getAiCliSetupGuide(selectedId) : undefined;
  const installCommand = guide?.installCommand[result?.os ?? "win32"] ?? null;

  useEffect(() => {
    setRecovery("idle");
    setCopied(null);
    if (!selectedId) return;
    void detectOne(selectedId).catch(() => undefined);
  }, [selectedId, detectOne]);

  async function openDocs(url: string) {
    setDocsError(null);
    try {
      await openExternalUrl(url);
    } catch {
      await navigator.clipboard.writeText(url).catch(() => undefined);
      setDocsError(`Không mở được trình duyệt. Đã copy link: ${url}`);
    }
  }

  async function recoverAutomatically() {
    if (!selectedId) return;
    setRecovery("recovering");
    try {
      const next = await detectOne(selectedId, { clearManual: true });
      setRecovery(next.status === "READY" ? "recovered" : "failed");
    } catch {
      setRecovery("failed");
    }
  }

  async function copyCommand(kind: "install" | "login", command: string) {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(kind);
    } catch {
      setCopied(null);
    }
  }

  async function verifyAfterLogin() {
    if (!selectedId) return;
    setRecovery("recovering");
    try {
      await onVerify();
      const next = await detectOne(selectedId);
      setRecovery(next.status === "READY" ? "recovered" : "failed");
    } catch {
      setRecovery("failed");
    }
  }

  async function recoverWithFile() {
    if (!selectedId) return;
    setRecovery("recovering");
    try {
      const next = await selectExecutable(selectedId);
      if (!next) {
        setRecovery("idle");
        return;
      }
      setRecovery(next.status === "READY" ? "recovered" : "failed");
    } catch {
      setRecovery("failed");
    }
  }

  if (!selectedId || !spec) {
    return (
      <Alert
        type="warning"
        showIcon
        message="CLI đã chọn chưa được hỗ trợ detect trên máy này."
      />
    );
  }

  return (
    <div className="ai-cli-env" aria-label={`Kết nối ${spec.name}`}>
      <div className="settings-ai-block-label">Kết nối CLI đã chọn</div>
      <Text type="secondary" className="ai-cli-env-lead">
        Chỉ kiểm tra <Text strong>{spec.name}</Text> trên máy này. Không gửi path hoặc
        credential lên Backend.
      </Text>
      {lastError ? (
        <Alert type="error" showIcon className="ai-cli-env-alert" message={lastError} />
      ) : null}
      <div className="ai-cli-env-row" aria-live="polite">
        <div className="ai-cli-env-row-main">
          <div className="ai-cli-env-name">{spec.name}</div>
          {state === "checking" ? (
            <Tag color="processing" icon={<SyncOutlined spin />}>
              ĐANG KIỂM TRA
            </Tag>
          ) : state === "recovered" ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              ĐÃ XỬ LÝ · ĐÃ KẾT NỐI
            </Tag>
          ) : state === "connected" ? (
            <Tag color="success" icon={<CheckCircleOutlined />}>
              ĐÃ KẾT NỐI
            </Tag>
          ) : state === "needs_auth" ? (
            <Tag color="warning" icon={<LoginOutlined />}>
              ĐÃ CÀI · CẦN ĐĂNG NHẬP
            </Tag>
          ) : state === "needs_verify" ? (
            <Tag color="warning" icon={<SafetyCertificateOutlined />}>
              ĐÃ ĐĂNG NHẬP · CHƯA XÁC MINH
            </Tag>
          ) : (
            <Tag color="error" icon={<CloseCircleOutlined />}>
              CHƯA CÀI
            </Tag>
          )}
        </div>

        {state === "not_installed" ? (
          <Alert
            type={recovery === "failed" ? "error" : "warning"}
            showIcon
            className="ai-cli-env-alert"
            message={
              recovery === "failed"
                ? "Vẫn chưa tìm thấy CLI sau khi kiểm tra lại"
                : `${spec.name} chưa được cài hoặc chưa có trong PATH`
            }
            description={aiCliFailureMessage(result)}
          />
        ) : null}

        {state === "not_installed" && guide ? (
          <div className="ai-cli-setup-guide">
            <Text strong>Bước 1 — Cài {spec.name}</Text>
            {installCommand ? (
              <div className="ai-cli-command">
                <Text code copyable={false}>
                  {installCommand}
                </Text>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copyCommand("install", installCommand)}
                >
                  {copied === "install" ? "Đã copy" : "Copy lệnh cài"}
                </Button>
              </div>
            ) : (
              <Text type="secondary">{guide.loginNote}</Text>
            )}
            <Text type="secondary">
              Mở PowerShell/Terminal, dán lệnh trên và chờ cài xong.
            </Text>
            {guide.docsUrl ? (
              <Button
                type="link"
                size="small"
                icon={<ExportOutlined />}
                className="ai-cli-docs-link"
                onClick={() => void openDocs(guide.docsUrl!)}
              >
                Hướng dẫn chính thức
              </Button>
            ) : null}
            {docsError ? (
              <Text type="warning" className="ai-cli-env-meta">
                {docsError}
              </Text>
            ) : null}
          </div>
        ) : null}

        {state === "needs_auth" && guide ? (
          <div className="ai-cli-setup-guide">
            <Alert
              type="info"
              showIcon
              message={
                guide.loginCommand
                  ? "Bước 2 — Đăng nhập CLI"
                  : "Bước 2 — Kiểm tra kết nối"
              }
              description={guide.loginNote}
            />
            {guide.loginCommand ? (
              <div className="ai-cli-command">
                <Text code>{guide.loginCommand}</Text>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copyCommand("login", guide.loginCommand!)}
                >
                  {copied === "login" ? "Đã copy" : "Copy lệnh đăng nhập"}
                </Button>
              </div>
            ) : null}
            <Text type="secondary">
              Credential do CLI/vendor lưu trên máy. AITest không nhận mật khẩu, token hay
              cookie đăng nhập.
            </Text>
          </div>
        ) : null}

        {state === "needs_verify" ? (
          <div className="ai-cli-setup-guide">
            <Alert
              type="info"
              showIcon
              message="Bước 3 — Lưu cấu hình & Test CLI"
              description={`${spec.name} đã cài và đã đăng nhập trên máy này. Backend chưa ghi nhận Ready cho project, nên hãy lưu cấu hình rồi Test CLI.`}
            />
          </div>
        ) : null}

        {result?.version ? (
          <div className="ai-cli-env-meta">
            Version: <Text code>{result.version}</Text>
          </div>
        ) : null}
        {result?.executablePath ? (
          <div className="ai-cli-env-meta ai-cli-env-path">
            Path: <Text code>{result.executablePath}</Text>
          </div>
        ) : null}

        <Space size={8} wrap className="ai-cli-env-row-actions">
          {state === "not_installed" ? (
            <>
              {selectedId !== "custom-script" ? (
                <Button
                  type="primary"
                  icon={<SearchOutlined />}
                  loading={recovery === "recovering"}
                  disabled={detecting}
                  onClick={() => void recoverAutomatically()}
                >
                  Đã cài xong · Dò lại
                </Button>
              ) : null}
              <Button
                icon={<FolderOpenOutlined />}
                disabled={detecting}
                onClick={() => void recoverWithFile()}
              >
                Chọn file CLI
              </Button>
            </>
          ) : state === "needs_auth" ? (
            <Button
              type="primary"
              icon={<LoginOutlined />}
              loading={verifying}
              disabled={detecting}
              onClick={() => void verifyAfterLogin()}
            >
              {guide?.loginCommand ? "Đã đăng nhập · Test CLI" : "Test kết nối CLI"}
            </Button>
          ) : state === "needs_verify" ? (
            <>
              <Button
                type="primary"
                icon={<SafetyCertificateOutlined />}
                loading={verifying}
                disabled={detecting}
                onClick={() => void verifyAfterLogin()}
              >
                Lưu &amp; Test CLI
              </Button>
              <Button
                icon={<ReloadOutlined />}
                loading={detecting}
                onClick={() => void detectOne(selectedId)}
              >
                Kiểm tra lại
              </Button>
            </>
          ) : (
            <Button
              icon={<ReloadOutlined />}
              loading={detecting}
              onClick={() => void detectOne(selectedId)}
            >
              Kiểm tra lại
            </Button>
          )}
        </Space>
      </div>
    </div>
  );
}
