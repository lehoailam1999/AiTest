/**
 * IDE workspace ≠ Root Apply — actionable banner (Root ← Cursor one-click).
 */
import { useState } from "react";
import { Alert, App, Button, Space, Typography } from "antd";
import { CopyOutlined, FolderOpenOutlined } from "@ant-design/icons";
import type { Project } from "../api/types";
import { bindSourceRoot } from "../lib/workspaceManager";
import { isTauri, type ProjectScan } from "../tauri/bridge";

function folderName(path: string | null | undefined): string {
  if (!path) return "—";
  const n = path.replace(/[/\\]+$/, "").replace(/^.*[\\/]/, "");
  return n || path;
}

type Props = {
  ideRoot: string;
  localPath: string;
  project: Pick<Project, "id" | "name"> | null;
  onBound?: (payload: {
    rootPath: string;
    syncedProject: Project | null;
    scan: ProjectScan;
  }) => void;
  /** Compact alert for Agent panel (no bind — parent may pass onUseIdeRoot) */
  compact?: boolean;
  onUseIdeRoot?: () => void;
};

export function RootIdeMismatchBanner({
  ideRoot,
  localPath,
  project,
  onBound,
  compact,
  onUseIdeRoot,
}: Props) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);

  async function useIdeAsRoot() {
    if (onUseIdeRoot) {
      onUseIdeRoot();
      return;
    }
    if (!project) {
      message.error("Chọn dự án trước khi gắn Root Apply.");
      return;
    }
    if (!isTauri()) {
      message.error("Cần AITest Desktop (Tauri) để gắn thư mục.");
      return;
    }
    setBusy(true);
    try {
      const result = await bindSourceRoot({
        projectId: project.id,
        projectName: project.name,
        rootPath: ideRoot,
      });
      if (result.syncError) {
        message.warning(`Đã gắn Root; sync stack: ${result.syncError}`);
      } else {
        message.success(
          `Root Apply = ${folderName(result.rootPath)} (theo folder Cursor)`
        );
      }
      onBound?.({
        rootPath: result.rootPath,
        syncedProject: result.syncedProject,
        scan: result.scan,
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Gắn Root thất bại");
    } finally {
      setBusy(false);
    }
  }

  async function copyRootPath() {
    try {
      await navigator.clipboard.writeText(localPath);
      message.success("Đã sao chép đường dẫn Root — Open Folder trong Cursor");
    } catch {
      message.info(localPath);
    }
  }

  return (
    <Alert
      style={{ marginTop: compact ? 0 : 10 }}
      type="warning"
      showIcon
      title="Cursor và thư mục ghi test đang khác nhau"
      description={
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: compact ? "1fr" : "1fr 1fr",
              gap: 8,
            }}
          >
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Cursor đang mở
              </Typography.Text>
              <div>
                <Typography.Text strong>{folderName(ideRoot)}</Typography.Text>
              </div>
              <Typography.Text
                code
                style={{ fontSize: 11, wordBreak: "break-all" }}
              >
                {ideRoot}
              </Typography.Text>
            </div>
            <div>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Ghi test vào (Root Apply)
              </Typography.Text>
              <div>
                <Typography.Text strong>{folderName(localPath)}</Typography.Text>
              </div>
              <Typography.Text
                code
                style={{ fontSize: 11, wordBreak: "break-all" }}
              >
                {localPath}
              </Typography.Text>
            </div>
          </div>
          <Space wrap size={8}>
            <Button
              type="primary"
              size="small"
              icon={<FolderOpenOutlined />}
              loading={busy}
              disabled={!project && !onUseIdeRoot}
              onClick={() => void useIdeAsRoot()}
            >
              Dùng folder Cursor làm Root Apply
            </Button>
            <Button
              size="small"
              icon={<CopyOutlined />}
              onClick={() => void copyRootPath()}
            >
              Sao chép đường dẫn Root
            </Button>
          </Space>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Reconnect không đổi folder Cursor. Hoặc Open Folder đúng repo trong
            Cursor (dùng đường dẫn Root đã sao chép).
          </Typography.Text>
        </div>
      }
    />
  );
}
