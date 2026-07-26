/**
 * Ready strip — AI · IDE · Root · Runner in one progressive-disclosure bar (UX redesign).
 */
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { Alert, Button, Collapse, Space, Tag, Typography } from "antd";
import { DownOutlined, UpOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { IdeConnectPanel } from "./IdeConnectPanel";
import { SourceRootBar } from "./SourceRootBar";
import { RootIdeMismatchBanner } from "./RootIdeMismatchBanner";
import {
  EnsureTestRunnerPanel,
  testRunnerAllowsGenerate,
} from "./EnsureTestRunnerPanel";
import type { Project, ProjectMeta } from "../api/types";
import type { TestFrameworkResolution } from "../lib/testRunnerEnsure";
import { rootsMismatch } from "../lib/ideBridge/rootsMatch";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { ROUTES } from "../lib/productRoutes";
import type { ProjectScan } from "../tauri/bridge";

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
  onSourceRootBound: (payload: {
    rootPath: string;
    syncedProject: Project | null;
    scan: ProjectScan;
  }) => void;
  onSourceRootSynced: (project: Project) => void;
  onFocusApplied?: (focus: {
    file: string;
    symbol: string;
    method?: string;
  }) => void;
  /** Extra alert slots (e.g. OpenAPI) */
  extraAlerts?: ReactNode;
};

export function ReadyStrip({
  aiReady,
  aiProvider,
  localPath,
  syncedAt,
  project,
  meta,
  preferredLanguage,
  sourceFile,
  testFwResolution,
  skipTestFwInstall,
  onSkipChange,
  onTestFwResolved,
  onSourceRootBound,
  onSourceRootSynced,
  onFocusApplied,
  extraAlerts,
}: Props) {
  const ideStatus = useIdeBridgeSession((s) => s.status);
  const ideRoot = useIdeBridgeSession((s) => s.workspaceRoot);
  const ideFocus = useIdeBridgeSession((s) => s.focus);
  const mismatch = rootsMismatch(localPath, ideRoot);
  const runnerOk = testRunnerAllowsGenerate(testFwResolution, skipTestFwInstall);

  const allOk =
    aiReady &&
    ideStatus === "connected" &&
    Boolean(localPath) &&
    runnerOk &&
    !mismatch;

  const [open, setOpen] = useState(!allOk);
  const [rootKeys, setRootKeys] = useState<string[]>(
    !localPath || mismatch ? ["root"] : []
  );

  useEffect(() => {
    if (mismatch || !allOk) setOpen(true);
  }, [mismatch, allOk]);

  useEffect(() => {
    if (mismatch) setRootKeys((k) => (k.includes("root") ? k : [...k, "root"]));
  }, [mismatch]);

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
            AI {aiReady ? aiProvider || "Ready" : "chưa"}
          </Tag>
          <Tag color={ideStatus === "connected" ? "success" : "default"}>
            IDE {ideStatus === "connected" ? "Connected" : "offline"}
          </Tag>
          <Tag color={localPath ? "success" : "warning"}>
            Thư mục ghi test · {rootLabel}
          </Tag>
          <Tag color={runnerOk ? "success" : "warning"}>
            Runner {runnerOk ? "OK" : "cần cài"}
          </Tag>
          {mismatch ? <Tag color="error">Lệch thư mục</Tag> : null}
          {ideFocus?.file && !mismatch ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              boost: {ideFocus.symbol}
              {ideFocus.method ? `.${ideFocus.method}` : ""}
            </Typography.Text>
          ) : null}
          {mismatch && ideStatus === "connected" ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Chưa gắn focus vì lệch thư mục
            </Typography.Text>
          ) : null}
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

      {mismatch && ideRoot && localPath ? (
        <RootIdeMismatchBanner
          ideRoot={ideRoot}
          localPath={localPath}
          project={project}
          existingMeta={meta}
          onBound={onSourceRootBound}
        />
      ) : null}

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
          description="Lưu API Key và Xác minh trước khi sinh mã."
        />
      ) : null}

      {extraAlerts}

      {open ? (
        <div style={{ marginTop: 12, display: "flex", flexDirection: "column", gap: 10 }}>
          <IdeConnectPanel compact onFocusApplied={mismatch ? undefined : onFocusApplied} />
          <Collapse
            size="small"
            activeKey={rootKeys}
            onChange={(keys) =>
              setRootKeys(Array.isArray(keys) ? keys.map(String) : [String(keys)])
            }
            items={[
              {
                key: "root",
                label: localPath
                  ? `Thư mục ghi test · ${rootLabel}`
                  : "Thư mục ghi test (gắn để Apply / Run / fallback)",
                children: project ? (
                  <SourceRootBar
                    project={project}
                    localPath={localPath}
                    syncedAt={syncedAt}
                    existingMeta={meta}
                    onBound={onSourceRootBound}
                    onSynced={onSourceRootSynced}
                  />
                ) : (
                  <Typography.Text type="secondary">Chọn dự án trước.</Typography.Text>
                ),
              },
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
