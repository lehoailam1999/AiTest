/**
 * Ready strip — AI · Project root · Runner (CLI Unit Engine happy path).
 * IDE bridge đã bỏ khỏi UI test flow — đọc source qua Local FS (Tauri).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Collapse, Space, Tag, Typography } from "antd";
import { DownOutlined, UpOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import {
  EnsureTestRunnerPanel,
  testRunnerAllowsGenerate,
} from "./EnsureTestRunnerPanel";
import type { Project, ProjectMeta } from "../api/types";
import type { TestFrameworkResolution } from "../lib/testRunnerEnsure";
import { ROUTES } from "../lib/productRoutes";

type Props = {
  aiReady: boolean;
  aiProvider?: string | null;
  localPath: string | null;
  syncedAt: string | null;
  project: Pick<Project, "id" | "name"> | null;
  meta?: ProjectMeta | null;
  /** Language / path under test — monorepo (Forensic): C# → xUnit, không Jest ClientApp */
  preferredLanguage?: string | null;
  sourceFile?: string | null;
  testFwResolution: TestFrameworkResolution | null;
  skipTestFwInstall: boolean;
  onSkipChange: (v: boolean) => void;
  onTestFwResolved: (r: TestFrameworkResolution | null) => void;
  /** Extra alert slots (e.g. OpenAPI) */
  extraAlerts?: ReactNode;
};

export function ReadyStrip({
  aiReady,
  aiProvider,
  localPath,
  meta,
  preferredLanguage,
  sourceFile,
  testFwResolution,
  skipTestFwInstall,
  onSkipChange,
  onTestFwResolved,
  extraAlerts,
}: Props) {
  const runnerOk = testRunnerAllowsGenerate(testFwResolution, skipTestFwInstall);
  const allOk = aiReady && Boolean(localPath) && runnerOk;

  const [open, setOpen] = useState(!allOk);

  useEffect(() => {
    if (!allOk) setOpen(true);
  }, [allOk]);

  const rootLabel = useMemo(() => {
    if (!localPath) return "chưa gắn";
    return localPath.replace(/^.*[\\/]/, "") || localPath;
  }, [localPath]);

  return (
    <div
      style={{
        border: "1px solid var(--border, #e5e7eb)",
        borderRadius: 10,
        background: allOk ? "rgba(82, 196, 26, 0.05)" : "var(--panel, #fafafa)",
        padding: "10px 12px",
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
        <Space wrap size={[8, 8]}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Ready
          </Typography.Text>
          <Tag color={aiReady ? "success" : "error"}>
            AI {aiReady ? (aiProvider ? `Ready · ${aiProvider}` : "Ready") : "chưa"}
          </Tag>
          <Tag color={localPath ? "success" : "warning"}>
            Project root · {rootLabel}
          </Tag>
          <Tag color={runnerOk ? "success" : "warning"}>
            Runner {runnerOk ? "OK" : "cần cài"}
          </Tag>
        </Space>
        <Button
          type="link"
          size="small"
          icon={open ? <UpOutlined /> : <DownOutlined />}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? "Thu gọn" : "Chi tiết"}
        </Button>
      </div>

      {!aiReady ? (
        <Alert
          style={{ marginTop: 10 }}
          type="error"
          showIcon
          title="AI chưa Ready"
          action={
            <Link to={ROUTES.settingsAi}>
              <Button size="small" type="primary">
                Cấu hình AI
              </Button>
            </Link>
          }
          description="Vào Cấu hình AI, chọn CLI (vd. Cursor CLI) rồi Lưu → Test CLI cho đến khi Ready."
        />
      ) : null}

      {!localPath && aiReady ? (
        <Alert
          style={{ marginTop: 10 }}
          type="warning"
          showIcon
          title="Chưa gắn project root"
          description={
            <>
              Gắn thư mục repo tại trang <Link to={ROUTES.projects}>Dự án</Link> trước khi sinh mã.
            </>
          }
        />
      ) : null}

      {extraAlerts}

      {open ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <Collapse
            size="small"
            defaultActiveKey={["runner"]}
            items={[
              {
                key: "runner",
                label: runnerOk
                  ? `Test runner · ${testFwResolution?.framework || "OK"}`
                  : "Test runner (cần cài hoặc bỏ qua)",
                children: (
                  <EnsureTestRunnerPanel
                    projectRoot={localPath}
                    meta={meta}
                    preferredLanguage={preferredLanguage}
                    sourceFile={sourceFile}
                    onResolved={onTestFwResolved}
                    skipped={skipTestFwInstall}
                    onSkipChange={onSkipChange}
                  />
                ),
              },
            ]}
          />
        </div>
      ) : null}
    </div>
  );
}
