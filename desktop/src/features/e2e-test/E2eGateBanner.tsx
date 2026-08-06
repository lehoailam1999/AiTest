/**
 * EX1.1 + EX1.6 — Gate: AI · Root · Target URL · FE · Playwright deps.
 * Root được quản lý tập trung ở trang Dự án.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { Alert, App, Button, Space, Tag, Typography } from "antd";
import { CopyOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { generateE2e } from "../../api";
import { ROUTES } from "../../lib/productRoutes";
import { isTauri, runTestCommand } from "../../tauri/bridge";
import { probeTargetUrl } from "./e2eJobState";

const PLAYWRIGHT_INSTALL_CMD =
  "npm i -D @playwright/test && npx playwright install chromium";

/** Cảnh báo khi root có vẻ là repo tool AITest (không phải app đích). */
function looksLikeAitestProductRoot(path: string | null): boolean {
  if (!path) return false;
  const n = path.replace(/\\/g, "/").replace(/\/+$/, "");
  const base = n.split("/").pop() || "";
  return /^aitest$/i.test(base);
}

type FeStatus = "idle" | "checking" | "ok" | "fail" | "empty";
type PwStatus = "idle" | "checking" | "ok" | "fail" | "unknown";

type Props = {
  aiReady: boolean;
  aiProvider?: string | null;
  localPath: string | null;
  targetUrl: string;
  testCaseId: string;
  /** S3.5 — Auth Discover / credentials / storageState readiness (soft gate) */
  authReady?: boolean;
  authLabel?: string;
  /** When set, show soft Auth tip (does not block CTA) */
  authHint?: string;
  /** Gate reasons → parent disables CTA */
  onGateChange: (gate: { ready: boolean; reasons: string[] }) => void;
};

export function E2eGateBanner({
  aiReady,
  aiProvider,
  localPath,
  targetUrl,
  testCaseId,
  authReady,
  authLabel,
  authHint,
  onGateChange,
}: Props) {
  const { message } = App.useApp();
  const [feStatus, setFeStatus] = useState<FeStatus>("idle");
  const [feBypass, setFeBypass] = useState(false);
  const [pwStatus, setPwStatus] = useState<PwStatus>("idle");
  const [pwMessage, setPwMessage] = useState("");
  const [pwCheckedRoot, setPwCheckedRoot] = useState("");
  const [pwSource, setPwSource] = useState<"project" | "aitest" | "none">("none");
  const [pwBypass, setPwBypass] = useState(false);
  const [installBusy, setInstallBusy] = useState(false);

  const [authBypass, setAuthBypass] = useState(false);

  useEffect(() => {
    setFeBypass(false);
  }, [targetUrl]);

  useEffect(() => {
    setPwBypass(false);
  }, [localPath]);

  useEffect(() => {
    setAuthBypass(false);
  }, [authReady, authLabel]);

  useEffect(() => {
    const url = targetUrl.trim();
    if (!url) {
      setFeStatus("empty");
      return;
    }
    let cancelled = false;
    setFeStatus("checking");
    const t = window.setTimeout(() => {
      void probeTargetUrl(url).then((r) => {
        if (!cancelled) setFeStatus(r);
      });
    }, 600);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [targetUrl]);

  const refreshPlaywright = useCallback(async () => {
    if (!localPath) {
      setPwStatus("idle");
      setPwMessage("");
      return;
    }
    setPwStatus("checking");
    try {
      const r = await generateE2e.playwrightCheck({ projectRoot: localPath });
      setPwStatus(r.ok ? "ok" : "fail");
      setPwMessage(r.message || "");
      setPwCheckedRoot(r.checkedRoot || localPath);
      setPwSource(r.source === "aitest" || r.source === "project" ? r.source : "none");
    } catch (e) {
      setPwStatus("unknown");
      setPwMessage(e instanceof Error ? e.message : String(e));
    }
  }, [localPath]);

  useEffect(() => {
    void refreshPlaywright();
  }, [refreshPlaywright]);

  const reasons = useMemo(() => {
    const r: string[] = [];
    if (!aiReady) r.push("AI chưa Ready — vào Settings cấu hình và Verify");
    if (!localPath) r.push("Chưa gắn project root");
    if (!targetUrl.trim()) r.push("Chưa nhập Target URL");
    if (!testCaseId) r.push("Chưa chọn Test Case Approved");
    if (feStatus === "fail" && !feBypass) {
      r.push("FE có vẻ chưa chạy tại Target URL (hoặc không phản hồi)");
    }
    if (pwStatus === "fail" && !pwBypass) {
      r.push(
        pwMessage ||
          "Chưa có @playwright/test trong project root — Headless sẽ fail"
      );
    }
    // Auth is soft-only (S3.5) — do not block CTA; separate Alert below
    return r;
  }, [
    aiReady,
    localPath,
    targetUrl,
    testCaseId,
    feStatus,
    feBypass,
    pwStatus,
    pwBypass,
    pwMessage,
  ]);

  const ready = reasons.length === 0;

  useEffect(() => {
    onGateChange({ ready, reasons });
  }, [ready, reasons, onGateChange]);

  const rootLabel = localPath
    ? localPath.replace(/^.*[\\/]/, "") || localPath
    : "chưa gắn";

  const feTag =
    feStatus === "ok"
      ? { color: "success" as const, text: "FE OK" }
      : feStatus === "fail"
        ? { color: "error" as const, text: "FE?" }
        : feStatus === "checking"
          ? { color: "processing" as const, text: "FE…" }
          : { color: "default" as const, text: "FE" };

  const pwTag =
    pwStatus === "ok"
      ? {
          color: "success" as const,
          text: pwSource === "aitest" ? "PW · AITest" : "PW OK",
        }
      : pwStatus === "fail"
        ? { color: "error" as const, text: "PW?" }
        : pwStatus === "checking"
          ? { color: "processing" as const, text: "PW…" }
          : pwStatus === "unknown"
            ? { color: "warning" as const, text: "PW?" }
            : { color: "default" as const, text: "PW" };

  async function copyInstallCmd() {
    try {
      await navigator.clipboard.writeText(PLAYWRIGHT_INSTALL_CMD);
      message.success("Đã copy lệnh cài Playwright (project)");
    } catch {
      message.error("Không copy được clipboard");
    }
  }

  async function installPlaywrightOnAitest() {
    setInstallBusy(true);
    message.loading({
      content: "Đang cài Playwright Chromium vào ~/.aitest/playwright-runner…",
      key: "pw-install",
      duration: 0,
    });
    try {
      const r = await generateE2e.playwrightEnsure({});
      message.destroy("pw-install");
      message.success(r.message || "Đã cài Playwright trên AITest");
      setPwBypass(false);
      await refreshPlaywright();
    } catch (e) {
      message.destroy("pw-install");
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallBusy(false);
    }
  }

  async function installPlaywrightOnProject() {
    if (!localPath || !isTauri()) {
      message.warning(
        "Cài vào project cần AITest Desktop — hoặc chạy lệnh thủ công trong terminal."
      );
      return;
    }
    setInstallBusy(true);
    message.loading({
      content: "Đang cài @playwright/test vào project root…",
      key: "pw-install",
      duration: 0,
    });
    try {
      const r = await runTestCommand(localPath, PLAYWRIGHT_INSTALL_CMD);
      message.destroy("pw-install");
      if (r.exitCode === 0 || r.success) {
        message.success("Đã cài Playwright vào project — kiểm tra lại…");
        setPwBypass(false);
        await refreshPlaywright();
      } else {
        message.error(
          `Cài thất bại (exit ${r.exitCode ?? "?"}). Chạy thủ công trong project root.`
        );
      }
    } catch (e) {
      message.destroy("pw-install");
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallBusy(false);
    }
  }

  return (
    <div className="e2e-gate">
      <div className="e2e-gate-row">
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Ready
        </Typography.Text>
        <Space wrap size={[8, 8]}>
          <Tag color={aiReady ? "success" : "warning"}>
            AI {aiReady ? "Ready" : "chưa"}
            {aiReady && aiProvider ? ` · ${aiProvider}` : ""}
          </Tag>
          <Tag color={localPath ? "success" : "warning"}>Root · {rootLabel}</Tag>
          <Tag color={targetUrl.trim() ? "success" : "warning"}>Target URL</Tag>
          <Tag color={feTag.color}>{feTag.text}</Tag>
          <Tag color={pwTag.color} title={pwMessage || undefined}>
            {pwTag.text}
          </Tag>
          {authReady !== undefined ? (
            <Tag
              color={authReady ? "success" : "warning"}
              title={authHint || undefined}
            >
              {authReady
                ? `Auth OK${authLabel ? ` · ${authLabel}` : ""}`
                : "Auth?"}
            </Tag>
          ) : null}
          {!testCaseId ? <Tag color="warning">Chưa chọn TC</Tag> : null}
        </Space>
      </div>

      {looksLikeAitestProductRoot(localPath) ? (
        <Alert
          className="e2e-gate-alert"
          type="warning"
          showIcon
          title="Project root có vẻ là repo tool AITest"
          description={
            <>
              File E2E được ghi vào{" "}
              <Typography.Text code>
                {localPath}/AItest/E2ETest/…
              </Typography.Text>
              . Hãy gắn <strong>Project root</strong> tới thư mục source code app đích
              (ví dụ dự án FE/BE bạn đang test), không phải repo AITest.
            </>
          }
        />
      ) : localPath ? (
        <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginTop: 6 }}>
          File E2E sau Apply:{" "}
          <Typography.Text code style={{ fontSize: 12 }}>
            {localPath}/AItest/E2ETest/…
          </Typography.Text>
        </Typography.Text>
      ) : (
        <Alert
          className="e2e-gate-alert"
          type="warning"
          showIcon
          title="Chưa gắn project root"
          description={
            <>
              Gắn source code tại trang <Link to={ROUTES.projects}>Dự án</Link> trước khi chạy E2E.
            </>
          }
        />
      )}

      {pwStatus === "fail" && !pwBypass ? (
        <Alert
          className="e2e-gate-alert"
          type="error"
          showIcon
          title="Chưa có Playwright & Chromium để thực thi E2E Test"
          description={
            <Space orientation="vertical" size={8} style={{ width: "100%" }}>
              <Typography.Text>
                {pwMessage || "Chưa sẵn sàng."} Khuyến nghị cài{" "}
                <strong>Playwright trên AITest</strong> (Chromium dùng chung — project
                không cần cài). AI CLI vẫn generate/heal như bình thường.
              </Typography.Text>
              {pwCheckedRoot ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Project root:{" "}
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {pwCheckedRoot}
                  </Typography.Text>
                </Typography.Text>
              ) : null}
              <Space wrap>
                <Button
                  size="small"
                  type="primary"
                  icon={<DownloadOutlined />}
                  loading={installBusy}
                  onClick={() => void installPlaywrightOnAitest()}
                >
                  Cài Playwright trên AITest
                </Button>
                <Button
                  size="small"
                  icon={<ReloadOutlined />}
                  onClick={() => void refreshPlaywright()}
                >
                  Kiểm tra lại
                </Button>
                <Button
                  size="small"
                  icon={<CopyOutlined />}
                  onClick={() => void copyInstallCmd()}
                >
                  Copy lệnh (project)
                </Button>
                <Button
                  size="small"
                  loading={installBusy}
                  disabled={!isTauri() || !localPath}
                  onClick={() => void installPlaywrightOnProject()}
                >
                  Cài vào project
                </Button>
                <Typography.Link
                  style={{ fontSize: 12 }}
                  onClick={() => setPwBypass(true)}
                >
                  Bỏ qua lần này
                </Typography.Link>
              </Space>
            </Space>
          }
        />
      ) : null}

      {authHint && !authBypass ? (
        <Alert
          className="e2e-gate-alert"
          type="warning"
          showIcon
          title={
            authReady === false
              ? "Auth chưa đủ cho Inspect/Verify (không chặn Gen)"
              : "Auth: nên Đồng bộ storageState trước Inspect/Verify"
          }
          description={
            <Space orientation="vertical" size={6} style={{ width: "100%" }}>
              <Typography.Text style={{ fontSize: 12 }}>{authHint}</Typography.Text>
              <Typography.Link
                style={{ fontSize: 12 }}
                onClick={() => setAuthBypass(true)}
              >
                Ẩn cảnh báo Auth lần này
              </Typography.Link>
            </Space>
          }
        />
      ) : null}

      {reasons.length > 0 ? (
        <Alert
          className="e2e-gate-alert"
          type="warning"
          showIcon
          title="Chưa sẵn sàng chạy E2E Job"
          description={
            <>
              <ul style={{ margin: "6px 0 0", paddingLeft: 18 }}>
                {reasons.map((x) => (
                  <li key={x}>
                    {x}
                    {x.includes("Settings") ? (
                      <>
                        {" "}
                        <Link to={ROUTES.settingsAi}>Mở Settings AI</Link>
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
              {feStatus === "fail" && !feBypass ? (
                <Typography.Link
                  style={{ fontSize: 12, marginTop: 8, display: "inline-block" }}
                  onClick={() => setFeBypass(true)}
                >
                  Bỏ qua kiểm tra FE lần này
                </Typography.Link>
              ) : null}
            </>
          }
        />
      ) : (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          Đủ điều kiện — có thể Chạy E2E Job.
          {feBypass ? " (đã bỏ qua kiểm FE)" : ""}
          {pwBypass ? " (đã bỏ qua kiểm Playwright)" : ""}
          {authBypass ? " (đã ẩn cảnh báo Auth)" : ""}
          {authReady === false && !authBypass
            ? " · Auth vẫn khuyến nghị Đồng bộ trước Verify"
            : ""}
        </Typography.Text>
      )}

    </div>
  );
}
