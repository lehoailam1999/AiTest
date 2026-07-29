/**
 * EX1.3 + EX4.4 + EX5 — Tabs Files (preview) / Log / Artifacts.
 */
import { useEffect, useMemo, useState } from "react";
import { App, Button, Empty, Input, Space, Tabs, Tag, Typography } from "antd";
import { CopyOutlined, FolderOpenOutlined } from "@ant-design/icons";
import type { E2EFileDto } from "../../api";
import { isTauri, openPathInOs } from "../../tauri/bridge";
import { pickDefaultE2ePreviewPath } from "./e2eFilePreview";
import {
  E2E_PHASE_LABEL,
  type E2eJobRunState,
  type E2ePhaseId,
} from "./e2eJobState";

type Props = {
  files: E2EFileDto[];
  run: E2eJobRunState;
  activePhase: E2ePhaseId | null;
  onActivePhaseChange: (id: E2ePhaseId | null) => void;
  tab: string;
  onTabChange: (key: string) => void;
  /** Absolute project root — needed to resolve artifact relative paths */
  projectRoot?: string | null;
  /** Cho phép sửa nội dung file trước Apply (giống Unit staging). */
  onFilesChange?: (files: E2EFileDto[]) => void;
  editable?: boolean;
};

function joinRoot(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const r = root.replace(/[/\\]+$/, "");
  const p = rel.replace(/^[/\\]+/, "").replace(/[/\\]/g, sep);
  return `${r}${sep}${p}`;
}

export function E2eResultTabs({
  files,
  run,
  activePhase,
  onActivePhaseChange,
  tab,
  onTabChange,
  projectRoot,
  onFilesChange,
  editable = true,
}: Props) {
  const { message } = App.useApp();
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  useEffect(() => {
    if (!files.length) {
      setSelectedPath(null);
      return;
    }
    setSelectedPath((prev) => {
      if (prev && files.some((f) => f.path === prev)) return prev;
      return pickDefaultE2ePreviewPath(files);
    });
  }, [files]);

  const selected = useMemo(
    () => files.find((f) => f.path === selectedPath) ?? null,
    [files, selectedPath]
  );

  const phaseLog = useMemo(() => {
    if (activePhase && run.phases[activePhase]?.log) {
      return run.phases[activePhase].log;
    }
    return E2E_PHASES_JOIN(run);
  }, [activePhase, run]);

  async function openArtifact(rel: string, preferFolder: boolean) {
    if (!isTauri()) {
      message.warning("Mở path cần ứng dụng Desktop (Tauri).");
      return;
    }
    if (!projectRoot) {
      message.warning("Chưa gắn project root.");
      return;
    }
    try {
      let abs = joinRoot(projectRoot, rel);
      if (preferFolder) {
        const idx = Math.max(abs.lastIndexOf("\\"), abs.lastIndexOf("/"));
        if (idx > 0) abs = abs.slice(0, idx);
      }
      await openPathInOs(abs);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  }

  async function openSelectedInOs() {
    if (!selected || !projectRoot) {
      message.warning("Cần file + project root.");
      return;
    }
    await openArtifact(selected.path, false);
  }

  async function copySelected() {
    if (!selected?.content) {
      message.warning("Không có nội dung để copy.");
      return;
    }
    try {
      await navigator.clipboard.writeText(selected.content);
      message.success("Đã copy nội dung file");
    } catch {
      message.error("Không copy được clipboard");
    }
  }

  const reportArtifacts = run.artifacts.filter(
    (a) =>
      a.kind === "report" ||
      /\.html$/i.test(a.path) ||
      /playwright-report/i.test(a.path)
  );

  return (
    <Tabs
      className="e2e-result-tabs"
      activeKey={tab}
      onChange={onTabChange}
      items={[
        {
          key: "files",
          label: `File${files.length ? ` (${files.length})` : ""}`,
          children:
            files.length === 0 ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chưa có file POM/Spec — chạy Job để sinh."
              />
            ) : (
              <div className="e2e-files-preview">
                <div className="e2e-files-list-pane">
                  <Typography.Text
                    type="secondary"
                    style={{ fontSize: 12, display: "block", marginBottom: 8 }}
                  >
                    {editable
                      ? "Chọn file để xem / sửa trước khi Áp dụng"
                      : "Chọn file để xem preview"}
                  </Typography.Text>
                  <ul className="e2e-file-list">
                    {files.map((f) => {
                      const active = f.path === selected?.path;
                      return (
                        <li
                          key={f.path}
                          className={
                            active
                              ? "e2e-file-list__item e2e-file-list__item--active"
                              : "e2e-file-list__item"
                          }
                          onClick={() => setSelectedPath(f.path)}
                          onKeyDown={(e) => {
                            if (e.key === "Enter" || e.key === " ") {
                              e.preventDefault();
                              setSelectedPath(f.path);
                            }
                          }}
                          role="button"
                          tabIndex={0}
                        >
                          <Tag>{f.kind}</Tag>
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {f.path}
                          </Typography.Text>
                        </li>
                      );
                    })}
                  </ul>
                </div>
                <div className="e2e-files-content-pane">
                  {selected ? (
                    <>
                      <Space wrap style={{ marginBottom: 8 }}>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {selected.path}
                        </Typography.Text>
                        {editable ? <Tag color="blue">Có thể sửa</Tag> : null}
                        <Button
                          size="small"
                          icon={<CopyOutlined />}
                          onClick={() => void copySelected()}
                        >
                          Copy
                        </Button>
                        {isTauri() && projectRoot ? (
                          <Button
                            size="small"
                            icon={<FolderOpenOutlined />}
                            onClick={() => void openSelectedInOs()}
                          >
                            Mở path
                          </Button>
                        ) : null}
                      </Space>
                      <Input.TextArea
                        className="e2e-file-preview"
                        value={selected.content || ""}
                        readOnly={!editable || !onFilesChange}
                        rows={18}
                        onChange={(e) => {
                          if (!onFilesChange || !selectedPath) return;
                          const next = files.map((f) =>
                            f.path === selectedPath
                              ? { ...f, content: e.target.value }
                              : f
                          );
                          onFilesChange(next);
                        }}
                        style={{
                          fontFamily: "ui-monospace, monospace",
                          fontSize: 12,
                        }}
                      />
                    </>
                  ) : (
                    <Typography.Text type="secondary">
                      Chọn file để xem preview.
                    </Typography.Text>
                  )}
                </div>
              </div>
            ),
        },
        {
          key: "log",
          label: "Nhật ký",
          children: (
            <div className="e2e-log-pane">
              {activePhase ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Phase: {E2E_PHASE_LABEL[activePhase]}
                  {" · "}
                  <a
                    href="#e2e-log-all"
                    onClick={(e) => {
                      e.preventDefault();
                      onActivePhaseChange(null);
                    }}
                  >
                    Xem tất cả
                  </a>
                </Typography.Text>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Toàn bộ log · bấm bước pipeline để lọc theo phase
                </Typography.Text>
              )}
              <Input.TextArea
                value={phaseLog || "Chưa có log…"}
                readOnly
                rows={14}
                style={{
                  fontFamily: "ui-monospace, monospace",
                  fontSize: 12,
                  marginTop: 8,
                }}
              />
            </div>
          ),
        },
        {
          key: "artifacts",
          label: `Kết quả${run.artifactCount ? ` (${run.artifactCount})` : ""}`,
          children:
            run.artifacts.length === 0 && !run.reportId ? (
              <Empty
                image={Empty.PRESENTED_IMAGE_SIMPLE}
                description="Chưa sync kết quả — chạy Job tới bước Kết quả."
              />
            ) : (
              <div className="e2e-artifacts">
                {run.reportId ? (
                  <Typography.Paragraph style={{ marginBottom: 8 }}>
                    reportId: <Typography.Text code>{run.reportId}</Typography.Text>
                    {" · "}
                    {run.artifactCount} file
                  </Typography.Paragraph>
                ) : null}
                {reportArtifacts.length > 0 ? (
                  <Space wrap style={{ marginBottom: 10 }}>
                    {reportArtifacts.slice(0, 3).map((a) => (
                      <Button
                        key={`open-${a.path}`}
                        size="small"
                        icon={<FolderOpenOutlined />}
                        onClick={() => void openArtifact(a.path, false)}
                      >
                        Mở report
                      </Button>
                    ))}
                    <Button
                      size="small"
                      onClick={() =>
                        void openArtifact(reportArtifacts[0].path, true)
                      }
                    >
                      Mở thư mục
                    </Button>
                  </Space>
                ) : null}
                <ul className="e2e-file-list">
                  {run.artifacts.map((a) => (
                    <li key={`${a.kind}-${a.path}`}>
                      <Tag color="blue">{a.kind}</Tag>
                      <Typography.Text code>{a.path}</Typography.Text>
                      {a.sizeBytes != null ? (
                        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                          {a.sizeBytes} B
                        </Typography.Text>
                      ) : null}
                      {isTauri() && projectRoot ? (
                        <Button
                          type="link"
                          size="small"
                          onClick={() => void openArtifact(a.path, false)}
                        >
                          Mở
                        </Button>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            ),
        },
      ]}
    />
  );
}

function E2E_PHASES_JOIN(run: E2eJobRunState): string {
  const order: E2ePhaseId[] = [
    "inspect",
    "generate",
    "headless",
    "heal",
    "artifacts",
    "apply",
  ];
  return order
    .map((id) => {
      const log = run.phases[id].log;
      if (!log) return "";
      return `=== ${E2E_PHASE_LABEL[id]} ===\n${log}`;
    })
    .filter(Boolean)
    .join("\n");
}
