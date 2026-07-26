/**
 * P5.6 — Detect test framework; lock when present; confirm install when missing.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Alert, Button, Space, Tag, Typography } from "antd";
import { CheckCircleOutlined, DownloadOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ProjectMeta } from "../api/types";
import {
  installTestFramework,
  probeTestFramework,
  type EnsureStatus,
  type TestFrameworkResolution,
} from "../lib/testRunnerEnsure";
import { isTauri } from "../tauri/bridge";

type Props = {
  projectRoot: string | null;
  meta?: ProjectMeta | null;
  /** Language / file under test — monorepo: C# không bị Jest ClientApp ghi đè */
  preferredLanguage?: string | null;
  sourceFile?: string | null;
  /** Called when resolution changes — parent locks framework select */
  onResolved: (resolution: TestFrameworkResolution | null) => void;
  /** User chose to generate without installing */
  skipped?: boolean;
  onSkipChange?: (skipped: boolean) => void;
};

function applyStatus(res: TestFrameworkResolution): EnsureStatus {
  if (res.status === "present" || (res.status === "unknown" && !res.installCommand)) {
    return "ready";
  }
  if (res.status === "missing" && res.installCommand) {
    return "needs_install";
  }
  return "ready";
}

export function EnsureTestRunnerPanel({
  projectRoot,
  meta,
  preferredLanguage,
  sourceFile,
  onResolved,
  skipped,
  onSkipChange,
}: Props) {
  const [status, setStatus] = useState<EnsureStatus>("idle");
  const [resolution, setResolution] = useState<TestFrameworkResolution | null>(null);
  const [log, setLog] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Stable refs — tránh probe loop khi parent re-render (meta/onResolved identity đổi)
  const onResolvedRef = useRef(onResolved);
  onResolvedRef.current = onResolved;
  const metaRef = useRef(meta);
  metaRef.current = meta;
  const resolutionRef = useRef<TestFrameworkResolution | null>(null);
  const probeGen = useRef(0);

  const refresh = useCallback(
    async (opts?: { quiet?: boolean }) => {
      if (!projectRoot || !isTauri()) {
        setStatus("idle");
        setResolution(null);
        resolutionRef.current = null;
        onResolvedRef.current(null);
        return;
      }
      const gen = ++probeGen.current;
      // Giữ UI cũ khi re-check; chỉ hiện "checking" lần đầu
      if (!opts?.quiet && !resolutionRef.current) {
        setStatus("checking");
      }
      setError(null);
      setLog(null);
      try {
        const { resolution: res } = await probeTestFramework({
          projectRoot,
          meta: metaRef.current,
          preferredLanguage,
          sourceFile,
        });
        if (gen !== probeGen.current) return; // stale
        setResolution(res);
        resolutionRef.current = res;
        onResolvedRef.current(res);
        setStatus(applyStatus(res));
      } catch (e) {
        if (gen !== probeGen.current) return;
        setStatus("error");
        setError(e instanceof Error ? e.message : "Không kiểm tra được test runner");
        onResolvedRef.current(null);
      }
    },
    [projectRoot, preferredLanguage, sourceFile]
  );

  useEffect(() => {
    const t = window.setTimeout(() => {
      void refresh({ quiet: Boolean(resolutionRef.current) });
    }, 200); // debounce khi language/source đổi nhanh
    return () => {
      window.clearTimeout(t);
      probeGen.current += 1; // invalidate in-flight khi deps đổi
    };
  }, [projectRoot, preferredLanguage, sourceFile, refresh]);

  async function handleInstall() {
    if (!projectRoot || !resolution?.installCommand) return;
    setStatus("installing");
    setError(null);
    try {
      const result = await installTestFramework(projectRoot, resolution.installCommand);
      setLog(result.log.slice(-2000));
      if (!result.ok) {
        setStatus("error");
        setError(`Cài đặt thất bại (exit). Xem log bên dưới.`);
        return;
      }
      onSkipChange?.(false);
      await refresh();
    } catch (e) {
      setStatus("error");
      setError(e instanceof Error ? e.message : "Cài đặt thất bại");
    }
  }

  if (!projectRoot) {
    return (
      <Alert
        type="info"
        showIcon
        title="Test runner"
        description="Gắn Root Apply để nhận diện / cài framework test của project."
      />
    );
  }

  if (!isTauri()) {
    return (
      <Alert type="warning" showIcon title="Test runner" description="Cần Desktop (Tauri) để detect & cài package." />
    );
  }

  if ((status === "checking" || status === "idle") && !resolution) {
    return (
      <Alert type="info" showIcon title="Đang kiểm tra test framework…" />
    );
  }

  if (!resolution) {
    return error ? <Alert type="error" showIcon title={error} /> : null;
  }

  if (status === "ready" || (resolution.status === "present" && status !== "error" && status !== "installing")) {
    return (
      <Alert
        type="success"
        showIcon
        icon={<CheckCircleOutlined />}
        title={
          <Space wrap>
            <span>Framework test</span>
            <Tag color="blue">{resolution.label}</Tag>
            {resolution.locked ? <Tag color="success">đã khóa</Tag> : <Tag>auto</Tag>}
            {status === "checking" ? <Tag>đang cập nhật…</Tag> : null}
          </Space>
        }
        description={
          <Space orientation="vertical" size={4} style={{ width: "100%" }}>
            <Typography.Text type="secondary">{resolution.reason}</Typography.Text>
            <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>
              Kiểm tra lại
            </Button>
          </Space>
        }
      />
    );
  }

  if (status === "needs_install" || status === "installing" || (status === "error" && resolution.installCommand)) {
    return (
      <Alert
        type={status === "error" ? "error" : "warning"}
        showIcon
        title={
          <Space wrap>
            <span>Chưa có test runner</span>
            <Tag color="gold">{resolution.label}</Tag>
          </Space>
        }
        description={
          <Space orientation="vertical" size={8} style={{ width: "100%" }}>
            <Typography.Text>{resolution.reason}</Typography.Text>
            {resolution.installCommand ? (
              <Typography.Paragraph code copyable style={{ marginBottom: 0, fontSize: 12 }}>
                {resolution.installCommand}
              </Typography.Paragraph>
            ) : null}
            {error ? <Typography.Text type="danger">{error}</Typography.Text> : null}
            {log ? (
              <Typography.Paragraph
                type="secondary"
                style={{ maxHeight: 120, overflow: "auto", fontSize: 11, whiteSpace: "pre-wrap" }}
              >
                {log}
              </Typography.Paragraph>
            ) : null}
            <Space wrap>
              <Button
                type="primary"
                icon={<DownloadOutlined />}
                loading={status === "installing"}
                onClick={() => void handleInstall()}
              >
                Cài {resolution.label}
              </Button>
              <Button
                size="small"
                onClick={() => {
                  onSkipChange?.(true);
                }}
              >
                Bỏ qua lần này
              </Button>
              <Button size="small" icon={<ReloadOutlined />} onClick={() => void refresh()}>
                Kiểm tra lại
              </Button>
            </Space>
            {skipped ? (
              <Typography.Text type="warning" style={{ fontSize: 12 }}>
                Đã bỏ qua cài đặt — Sinh unit vẫn chạy; Verify có thể fail nếu package chưa có.
              </Typography.Text>
            ) : null}
          </Space>
        }
      />
    );
  }

  return null;
}

/** Gate: can generate / verify without forcing install if skipped or ready. */
export function testRunnerAllowsGenerate(
  resolution: TestFrameworkResolution | null,
  skipped: boolean
): boolean {
  if (!resolution) return true;
  if (resolution.status === "present" || resolution.status === "unknown") return true;
  if (resolution.status === "missing") return skipped;
  return true;
}
