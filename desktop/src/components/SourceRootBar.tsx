/**
 * Project root — gắn thư mục repo trên máy (Unit Job / Apply / Run).
 * Happy path = Local FS + AI CLI (không phụ thuộc IDE bridge).
 */

import { useState } from "react";
import { Alert, App, Button, Input, Space, Tag, Typography } from "antd";
import { FolderOpenOutlined, SyncOutlined } from "@ant-design/icons";
import type { Project, ProjectMeta } from "../api/types";
import {
  bindSourceRoot,
  pickAndBindSourceRoot,
  syncSourceMeta,
} from "../lib/workspaceManager";
import { isTauri, type ProjectScan } from "../tauri/bridge";
import { formatSyncedAt, normalizeProjectMeta } from "../lib/projectSync";

type Props = {
  /** Active project from context — chỉ cần id/name để bind path */
  project: Pick<Project, "id" | "name">;
  localPath: string | null;
  syncedAt: string | null;
  existingMeta?: ProjectMeta | null;
  /** After bind/sync — parent refreshes path + server project */
  onBound: (payload: {
    rootPath: string;
    syncedProject: Project | null;
    scan: ProjectScan;
  }) => void;
  onSynced: (project: Project) => void;
};

export function SourceRootBar({
  project,
  localPath,
  syncedAt,
  existingMeta,
  onBound,
  onSynced,
}: Props) {
  const { message } = App.useApp();
  const [busy, setBusy] = useState(false);
  const [manualPath, setManualPath] = useState("");
  const [showManual, setShowManual] = useState(false);

  async function handlePick() {
    if (!isTauri()) {
      message.error("Cần chạy Desktop (Tauri) để gắn root trên máy.");
      return;
    }
    setBusy(true);
    try {
      const result = await pickAndBindSourceRoot({
        projectId: project.id,
        projectName: project.name,
        existingMeta: normalizeProjectMeta(existingMeta),
      });
      if (!result) return;
      if (result.openError) {
        message.warning(`Đã gắn thư mục; phiên server: ${result.openError}`);
      }
      if (result.syncError) {
        message.error(`Gắn OK nhưng đồng bộ stack thất bại: ${result.syncError}`);
      } else {
        message.success("Đã gắn mã nguồn · sẵn sàng sinh test");
      }
      onBound({
        rootPath: result.rootPath,
        syncedProject: result.syncedProject,
        scan: result.scan,
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Gắn root Apply thất bại");
    } finally {
      setBusy(false);
    }
  }

  async function handleManual() {
    const path = manualPath.trim();
    if (!path) return;
    if (!isTauri()) {
      message.error("Cần chạy Desktop (Tauri) để gắn root trên máy.");
      return;
    }
    setBusy(true);
    try {
      const result = await bindSourceRoot({
        projectId: project.id,
        projectName: project.name,
        rootPath: path,
        existingMeta: normalizeProjectMeta(existingMeta),
      });
      if (result.openError) {
        message.warning(`Đã gắn thư mục; phiên server: ${result.openError}`);
      }
      if (result.syncError) {
        message.error(`Gắn OK nhưng đồng bộ stack thất bại: ${result.syncError}`);
      } else {
        message.success("Đã gắn mã nguồn · sẵn sàng sinh test");
      }
      onBound({
        rootPath: result.rootPath,
        syncedProject: result.syncedProject,
        scan: result.scan,
      });
      setShowManual(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Gắn mã nguồn thất bại");
    } finally {
      setBusy(false);
    }
  }

  async function handleRescan() {
    if (!localPath) return;
    setBusy(true);
    try {
      const result = await bindSourceRoot({
        projectId: project.id,
        projectName: project.name,
        rootPath: localPath,
        existingMeta: normalizeProjectMeta(existingMeta),
        refreshIndex: true,
      });
      if (result.syncError) {
        message.error(`Làm mới OK nhưng sync thất bại: ${result.syncError}`);
      } else {
        message.success("Đã làm mới mã nguồn");
      }
      onBound({
        rootPath: result.rootPath,
        syncedProject: result.syncedProject,
        scan: result.scan,
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Làm mới thất bại");
    } finally {
      setBusy(false);
    }
  }

  async function handleSync() {
    if (!localPath || !isTauri()) return;
    setBusy(true);
    try {
      const result = await bindSourceRoot({
        projectId: project.id,
        projectName: project.name,
        rootPath: localPath,
        existingMeta: normalizeProjectMeta(existingMeta),
        waitForIndex: false,
        syncMeta: true,
      });
      // Prefer dedicated sync if we already have scan from result
      if (result.syncedProject) {
        onSynced(result.syncedProject);
        message.success("Đã đồng bộ stack (language/framework) · không upload source");
      } else if (result.syncError) {
        // fallback: syncSourceMeta needs scan — use result.scan
        try {
          const verified = await syncSourceMeta({
            projectId: project.id,
            scan: result.scan,
            existingMeta: normalizeProjectMeta(existingMeta),
          });
          onSynced(verified);
          message.success("Đã đồng bộ stack · không upload source");
        } catch (e) {
          message.error(e instanceof Error ? e.message : result.syncError);
        }
      }
      onBound({
        rootPath: result.rootPath,
        syncedProject: result.syncedProject,
        scan: result.scan,
      });
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Đồng bộ stack thất bại");
    } finally {
      setBusy(false);
    }
  }

  if (!localPath) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Chưa gắn project root"
        description={
          <Space orientation="vertical" size={10} style={{ width: "100%" }}>
            <Typography.Text type="secondary">
              Thư mục project trên máy — bắt buộc cho <strong>Chạy Unit Job</strong> (Local FS + AI CLI),{" "}
              <strong>Apply</strong> ghi <Typography.Text code>AItest/</Typography.Text>, và{" "}
              <strong>Run / Verify</strong>.
            </Typography.Text>
            <Space wrap>
              <Button
                type="primary"
                icon={<FolderOpenOutlined />}
                loading={busy}
                disabled={!isTauri()}
                onClick={() => void handlePick()}
              >
                Gắn project root
              </Button>
              <Button type="link" onClick={() => setShowManual((v) => !v)}>
                {showManual ? "Ẩn nhập path" : "Nhập path thủ công"}
              </Button>
            </Space>
            {!isTauri() ? (
              <Typography.Text type="danger">
                Cần Desktop app (Tauri) — trình duyệt thuần không gắn được folder local.
              </Typography.Text>
            ) : null}
            {showManual ? (
              <Space.Compact style={{ width: "100%", maxWidth: 560 }}>
                <Input
                  placeholder="D:\path\to\project"
                  value={manualPath}
                  onChange={(e) => setManualPath(e.target.value)}
                  onPressEnter={() => void handleManual()}
                />
                <Button loading={busy} onClick={() => void handleManual()}>
                  Gắn
                </Button>
              </Space.Compact>
            ) : null}
          </Space>
        }
      />
    );
  }

  return (
    <Alert
      type={syncedAt ? "success" : "info"}
      showIcon
      title={
        <Space wrap size={8}>
          <span>Project root (Apply / Run)</span>
          {syncedAt ? (
            <Tag color="success">Stack · {formatSyncedAt(syncedAt)}</Tag>
          ) : (
            <Tag color="warning">Chưa đồng bộ stack</Tag>
          )}
        </Space>
      }
      description={
        <Space orientation="vertical" size={8} style={{ width: "100%" }}>
          <Typography.Text code ellipsis style={{ maxWidth: "100%" }}>
            {localPath}
          </Typography.Text>
          <Space wrap>
            <Button
              size="small"
              icon={<FolderOpenOutlined />}
              loading={busy}
              onClick={() => void handlePick()}
            >
              Đổi thư mục
            </Button>
            <Button size="small" loading={busy} onClick={() => void handleRescan()}>
              Làm mới
            </Button>
            {!syncedAt ? (
              <Button
                size="small"
                type="primary"
                icon={<SyncOutlined />}
                loading={busy}
                onClick={() => void handleSync()}
              >
                Đồng bộ stack
              </Button>
            ) : (
              <Button
                size="small"
                icon={<SyncOutlined />}
                loading={busy}
                onClick={() => void handleSync()}
              >
                Đồng bộ lại
              </Button>
            )}
          </Space>
        </Space>
      }
    />
  );
}
