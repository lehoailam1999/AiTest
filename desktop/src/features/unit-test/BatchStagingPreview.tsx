import { useEffect, useMemo, useState, type ReactNode } from "react";
import {
  App,
  Alert,
  Button,
  Card,
  Collapse,
  Input,
  List,
  Space,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  DeleteOutlined,
  EditOutlined,
  FileAddOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../../lib/unitWorkspace/types";
import {
  deleteWorkspaceFile,
  updateWorkspaceFileContent,
} from "../../lib/unitWorkspace/stagingFileEdit";
import { isTauri } from "../../tauri/bridge";
import type { BatchPipelineRow } from "./BatchRunConsole";

export type BatchStagingJob = {
  row: BatchPipelineRow;
  manifest: UnitWorkspaceManifest | null;
  previews: WorkspacePreviewFile[];
};

type FlatFile = {
  key: string;
  targetRel: string;
  testCaseId: string;
  tcTitle: string;
  jobKey: string;
  preview: WorkspacePreviewFile;
  op: string;
  runId?: string;
  packagePrefix?: string | null;
};

type TcFileGroup = {
  key: string;
  testCaseId: string;
  tcTitle: string;
  jobKey: string;
  packageLabel: string | null;
  files: FlatFile[];
};

type Props = {
  jobs: BatchStagingJob[];
  selectedJobKey: string | null;
  selectedTargetRel: string | null;
  onSelectJob: (key: string) => void;
  onSelectFile: (targetRel: string) => void;
  /** Project root — required for Sửa/Xóa trên đĩa */
  projectRoot?: string | null;
  /** Refresh manifests/previews after edit/delete */
  onFilesChanged?: () => void;
};

/** Prefer `AItest/…` suffix; else last 3 segments. */
function shortTargetRel(path: string): string {
  const p = path.replace(/\\/g, "/");
  const idx = p.toLowerCase().indexOf("/aitest/");
  if (idx >= 0) return p.slice(idx + 1);
  if (p.toLowerCase().startsWith("aitest/")) return p;
  const parts = p.split("/").filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join("/") : p;
}

function normRel(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\/+/, "");
}

/** Scaffold / config luôn dùng chung giữa các TC trong cùng package. */
function isLikelySharedScaffold(targetRel: string): boolean {
  const p = normRel(targetRel).toLowerCase();
  return (
    /\/aitest\.unittests\.csproj$/i.test(p) ||
    /^aitest\.unittests\.csproj$/i.test(p) ||
    /\/jest\.config\.[cm]?js$/i.test(p) ||
    /\/vitest\.config\.[cm]?[jt]s$/i.test(p) ||
    /\/tsconfig(\.[^/]+)?\.json$/i.test(p) ||
    /\/playwright\.config\.[cm]?[jt]s$/i.test(p) ||
    /\/_shared\//i.test(p)
  );
}

type SharedFile = FlatFile & {
  sharedByTcIds: string[];
  sharedByCount: number;
  reason: "scaffold" | "multi-tc";
};

/**
 * Staging preview batch — nhóm file theo TC (+ package nếu khác nhau).
 * Sửa/Xóa đồng bộ overlay staging + file AItest/ trên đĩa (nếu đã có).
 */
export function BatchStagingPreview({
  jobs,
  selectedJobKey: _selectedJobKey,
  selectedTargetRel,
  onSelectJob,
  onSelectFile,
  projectRoot,
  onFilesChanged,
}: Props) {
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);

  const allFiles: FlatFile[] = useMemo(() => {
    const out: FlatFile[] = [];
    for (const job of jobs) {
      if (job.row.status !== "ok" || !job.manifest) continue;
      for (const p of job.previews) {
        if (p.entry.op === "delete") continue;
        out.push({
          key: `${job.row.key}::${p.entry.targetRel}`,
          targetRel: p.entry.targetRel,
          testCaseId: job.row.testCaseId,
          tcTitle: job.row.title,
          jobKey: job.row.key,
          preview: p,
          op: p.entry.op,
          runId: job.manifest.runId,
          packagePrefix: job.manifest.packagePrefix,
        });
      }
    }
    return out;
  }, [jobs]);

  const { sharedFiles, tcGroups, uniqueFileCount } = useMemo(() => {
    const byTarget = new Map<string, FlatFile[]>();
    for (const f of allFiles) {
      const k = normRel(f.targetRel);
      const list = byTarget.get(k) || [];
      list.push(f);
      byTarget.set(k, list);
    }

    const sharedTargets = new Set<string>();
    const shared: SharedFile[] = [];
    for (const [target, list] of byTarget) {
      const tcIds = [...new Set(list.map((f) => f.testCaseId))];
      const jobKeys = new Set(list.map((f) => f.jobKey));
      const scaffold = isLikelySharedScaffold(target);
      const multi = jobKeys.size >= 2;
      if (!scaffold && !multi) continue;
      sharedTargets.add(target);
      const rep = list[list.length - 1]!; // latest job overlay
      shared.push({
        ...rep,
        key: `shared::${target}`,
        sharedByTcIds: tcIds,
        sharedByCount: jobKeys.size,
        reason: scaffold ? "scaffold" : "multi-tc",
      });
    }

    const map = new Map<string, TcFileGroup>();
    for (const f of allFiles) {
      if (sharedTargets.has(normRel(f.targetRel))) continue;
      const pkg = (f.packagePrefix || "").replace(/\\/g, "/").replace(/^\/+|\/+$/g, "");
      const gKey = `${f.jobKey}::${pkg}`;
      let g = map.get(gKey);
      if (!g) {
        g = {
          key: gKey,
          testCaseId: f.testCaseId,
          tcTitle: f.tcTitle,
          jobKey: f.jobKey,
          packageLabel: pkg || null,
          files: [],
        };
        map.set(gKey, g);
      }
      g.files.push(f);
    }

    return {
      sharedFiles: shared,
      tcGroups: [...map.values()].filter((g) => g.files.length > 0),
      uniqueFileCount: byTarget.size,
    };
  }, [allFiles]);

  const displayFiles: FlatFile[] = useMemo(
    () => [...sharedFiles, ...tcGroups.flatMap((g) => g.files)],
    [sharedFiles, tcGroups]
  );

  const selected =
    displayFiles.find((f) => f.targetRel === selectedTargetRel) ??
    displayFiles[0] ??
    null;

  const selectedIsShared = useMemo(
    () =>
      !!selected &&
      sharedFiles.some((f) => normRel(f.targetRel) === normRel(selected.targetRel)),
    [selected, sharedFiles]
  );

  const selectedGroupKey = useMemo(() => {
    if (!selected) return tcGroups[0]?.key;
    if (selectedIsShared) return "shared";
    return (
      tcGroups.find((g) => g.files.some((f) => f.targetRel === selected.targetRel))
        ?.key || tcGroups[0]?.key
    );
  }, [tcGroups, selected, selectedIsShared]);

  const [openKeys, setOpenKeys] = useState<string[]>([]);
  useEffect(() => {
    if (!selectedGroupKey) return;
    setOpenKeys((prev) =>
      prev.includes(selectedGroupKey) ? prev : [...prev, selectedGroupKey]
    );
  }, [selectedGroupKey]);

  const failJobs = useMemo(
    () =>
      jobs.filter(
        (j) =>
          j.row.status === "fail" &&
          j.row.error !== "Đang chờ…" &&
          j.row.error !== "Tạm dừng — chờ Tiếp tục" &&
          j.row.error !== "Đang chạy…"
      ),
    [jobs]
  );

  useEffect(() => {
    if (!selectedTargetRel && displayFiles[0]) {
      onSelectFile(displayFiles[0].targetRel);
      onSelectJob(displayFiles[0].jobKey);
    }
  }, [displayFiles, selectedTargetRel, onSelectFile, onSelectJob]);

  useEffect(() => {
    setEditing(false);
    setDraft("");
  }, [selected?.targetRel]);

  const okCount = jobs.filter((j) => j.row.status === "ok").length;
  const failCount = failJobs.length;
  const waitingCount = jobs.filter(
    (j) =>
      j.row.error === "Đang chờ…" ||
      j.row.error === "Tạm dừng — chờ Tiếp tục" ||
      j.row.error === "Đang chạy…"
  ).length;
  const pausedCount = jobs.filter((j) => j.row.error === "Tạm dừng — chờ Tiếp tục").length;

  const canMutate =
    !!projectRoot && isTauri() && !!selected?.runId && selected.op !== "delete";

  /** All job copies of the same targetRel (for shared edit/delete). */
  function siblingsForTarget(targetRel: string): FlatFile[] {
    const want = normRel(targetRel);
    return allFiles.filter((f) => normRel(f.targetRel) === want);
  }

  function startEdit() {
    if (!selected) return;
    setDraft(selected.preview.content);
    setEditing(true);
  }

  async function saveEdit() {
    if (!selected || !projectRoot || !selected.runId) return;
    setSaving(true);
    try {
      const targets = selectedIsShared
        ? siblingsForTarget(selected.targetRel)
        : [selected];
      let synced = 0;
      const seenRuns = new Set<string>();
      for (const t of targets) {
        if (!t.runId || seenRuns.has(t.runId)) continue;
        seenRuns.add(t.runId);
        const res = await updateWorkspaceFileContent(
          projectRoot,
          t.runId,
          t.targetRel,
          draft,
          t.packagePrefix
        );
        synced += res.syncedTargets.length;
      }
      message.success(
        synced > 0
          ? `Đã lưu staging + source (${seenRuns.size} overlay)`
          : `Đã lưu ${seenRuns.size} staging overlay`
      );
      setEditing(false);
      onFilesChanged?.();
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!selected || !projectRoot || !selected.runId) return;
    const siblings = selectedIsShared
      ? siblingsForTarget(selected.targetRel)
      : [selected];
    modal.confirm({
      title: selectedIsShared ? "Xóa file dùng chung?" : "Xóa file test đã gen?",
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Xóa{" "}
          <Typography.Text code style={{ fontSize: 12 }}>
            {selected.targetRel}
          </Typography.Text>
          {selectedIsShared
            ? ` khỏi ${siblings.length} staging TC và file dưới AItest/ (nếu có).`
            : " khỏi staging và file tương ứng dưới AItest/ (nếu đã có trên đĩa)."}{" "}
          Không đụng production SUT.
        </Typography.Paragraph>
      ),
      okText: "Xóa",
      okType: "danger",
      cancelText: "Hủy",
      onOk: async () => {
        try {
          const seenRuns = new Set<string>();
          let synced = 0;
          for (const t of siblings) {
            if (!t.runId || seenRuns.has(t.runId)) continue;
            seenRuns.add(t.runId);
            const res = await deleteWorkspaceFile(
              projectRoot,
              t.runId,
              t.targetRel,
              t.packagePrefix
            );
            synced += res.syncedTargets.length;
          }
          message.success(
            synced > 0 ? "Đã xóa staging + source" : "Đã xóa khỏi staging"
          );
          setEditing(false);
          onFilesChanged?.();
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
          throw e;
        }
      },
    });
  }

  function renderFileRow(item: FlatFile, extra?: ReactNode) {
    const active = item.targetRel === (selected?.targetRel ?? "");
    return (
      <List.Item
        onClick={() => {
          onSelectFile(item.targetRel);
          onSelectJob(item.jobKey);
        }}
        style={{
          cursor: "pointer",
          padding: "6px 8px",
          borderRadius: 6,
          background: active ? "var(--ant-color-primary-bg, #e6f4ff)" : undefined,
        }}
      >
        <Space orientation="vertical" size={2} style={{ width: "100%" }}>
          <Space wrap size={4}>
            <Tag
              color={item.op === "new" ? "green" : "gold"}
              style={{ margin: 0, width: "fit-content" }}
            >
              {item.op}
            </Tag>
            {extra}
          </Space>
          <Typography.Text code style={{ fontSize: 12 }} ellipsis title={item.targetRel}>
            {shortTargetRel(item.targetRel)}
          </Typography.Text>
        </Space>
      </List.Item>
    );
  }

  return (
    <Card
      id="aitest-batch-staging-preview"
      title="2. Staging preview · Batch"
      style={{ marginTop: 8 }}
      extra={
        <Space wrap>
          <Tag color="blue">{uniqueFileCount} file</Tag>
          {sharedFiles.length > 0 ? (
            <Tag color="purple">{sharedFiles.length} dùng chung</Tag>
          ) : null}
          <Tag color="success">{okCount} TC OK</Tag>
          {failCount > 0 ? <Tag color="error">{failCount} lỗi</Tag> : null}
          {pausedCount > 0 ? <Tag color="orange">{pausedCount} tạm dừng</Tag> : null}
          {waitingCount > 0 && pausedCount === 0 ? <Tag>{waitingCount} chờ</Tag> : null}
          {waitingCount > 0 && pausedCount > 0 ? (
            <Tag>{waitingCount - pausedCount} chờ / chạy</Tag>
          ) : null}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title={`Đã sinh ${uniqueFileCount} file duy nhất từ ${okCount} TC`}
        description="File scaffold / trùng path giữa nhiều TC nằm ở «Dùng chung». Mỗi TC chỉ còn file riêng."
      />

      <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
        <div style={{ flex: "0 0 min(360px, 100%)", maxHeight: 520, overflow: "auto" }}>
          {displayFiles.length === 0 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {waitingCount > 0
                ? "Đang Generate — file sẽ hiện dần khi từng TC xong."
                : "Chưa có file staging."}
            </Typography.Text>
          ) : (
            <>
              {sharedFiles.length > 0 ? (
                <div style={{ marginBottom: 12 }}>
                  <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
                    <FileAddOutlined /> Dùng chung ({sharedFiles.length})
                  </Typography.Text>
                  <List
                    size="small"
                    dataSource={sharedFiles}
                    renderItem={(item) =>
                      renderFileRow(
                        item,
                        <>
                          <Tag color="purple" style={{ margin: 0 }}>
                            {item.reason === "scaffold"
                              ? "scaffold"
                              : `×${item.sharedByCount} TC`}
                          </Tag>
                          {item.packagePrefix ? (
                            <Tag
                              color="blue"
                              style={{ margin: 0, maxWidth: 140 }}
                              title={item.packagePrefix}
                            >
                              {normRel(item.packagePrefix).split("/").pop()}
                            </Tag>
                          ) : null}
                        </>
                      )
                    }
                  />
                </div>
              ) : null}

              <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
                Theo Test Case ({tcGroups.length} mục
                {tcGroups.length
                  ? ` · ${tcGroups.reduce((n, g) => n + g.files.length, 0)} file riêng`
                  : ""}
                )
              </Typography.Text>
              {tcGroups.length === 0 ? (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Không còn file riêng — mọi artifact nằm ở «Dùng chung».
                </Typography.Text>
              ) : (
                <Collapse
                  size="small"
                  activeKey={openKeys.filter((k) => k !== "shared")}
                  onChange={(keys) => {
                    const next = Array.isArray(keys)
                      ? keys.map(String)
                      : [String(keys)];
                    setOpenKeys((prev) => {
                      const keepShared = prev.includes("shared") ? ["shared"] : [];
                      return [...keepShared, ...next];
                    });
                  }}
                  items={tcGroups.map((g) => {
                    const newN = g.files.filter((f) => f.op === "new").length;
                    const modN = g.files.filter((f) => f.op === "modify").length;
                    return {
                      key: g.key,
                      label: (
                        <Space wrap size={4} style={{ width: "100%" }}>
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {g.testCaseId}
                          </Typography.Text>
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, maxWidth: 160 }}
                            ellipsis
                          >
                            {g.tcTitle}
                          </Typography.Text>
                          <Tag style={{ margin: 0 }}>{g.files.length} file</Tag>
                          {newN > 0 ? (
                            <Tag color="green" style={{ margin: 0 }}>
                              {newN} new
                            </Tag>
                          ) : null}
                          {modN > 0 ? (
                            <Tag color="gold" style={{ margin: 0 }}>
                              {modN} modify
                            </Tag>
                          ) : null}
                          {g.packageLabel ? (
                            <Tag
                              color="blue"
                              style={{ margin: 0, maxWidth: 140 }}
                              title={g.packageLabel}
                            >
                              {g.packageLabel.split("/").pop()}
                            </Tag>
                          ) : null}
                        </Space>
                      ),
                      children: (
                        <List
                          size="small"
                          dataSource={g.files}
                          renderItem={(item) => renderFileRow(item)}
                        />
                      ),
                    };
                  })}
                />
              )}
            </>
          )}

          {failJobs.length > 0 ? (
            <div style={{ marginTop: 16 }}>
              <Typography.Text strong style={{ display: "block", marginBottom: 8 }}>
                <CloseCircleOutlined /> TC lỗi ({failJobs.length})
              </Typography.Text>
              <List
                size="small"
                dataSource={failJobs}
                renderItem={(job) => (
                  <List.Item style={{ padding: "6px 8px" }}>
                    <Space orientation="vertical" size={0}>
                      <Typography.Text code style={{ fontSize: 12 }}>
                        {job.row.testCaseId}
                      </Typography.Text>
                      <Typography.Text type="danger" style={{ fontSize: 11 }}>
                        {job.row.error}
                      </Typography.Text>
                    </Space>
                  </List.Item>
                )}
              />
            </div>
          ) : null}
        </div>

        <div style={{ flex: "1 1 280px", minWidth: 200, maxHeight: 520, overflow: "auto" }}>
          {selected ? (
            <>
              <Space wrap style={{ marginBottom: 8, width: "100%", justifyContent: "space-between" }}>
                <Space wrap>
                  <CheckCircleOutlined style={{ color: "var(--ant-color-success)" }} />
                  {selectedIsShared ? (
                    <Tag color="purple" style={{ margin: 0 }}>
                      Dùng chung
                    </Tag>
                  ) : (
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {selected.testCaseId}
                    </Typography.Text>
                  )}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }} ellipsis>
                    {selectedIsShared
                      ? shortTargetRel(selected.targetRel)
                      : selected.tcTitle}
                  </Typography.Text>
                </Space>
                <Space>
                  {editing ? (
                    <>
                      <Button
                        size="small"
                        icon={<SaveOutlined />}
                        type="primary"
                        loading={saving}
                        onClick={() => void saveEdit()}
                      >
                        Lưu
                      </Button>
                      <Button
                        size="small"
                        disabled={saving}
                        onClick={() => {
                          setEditing(false);
                          setDraft("");
                        }}
                      >
                        Hủy
                      </Button>
                    </>
                  ) : (
                    <>
                      <Button
                        size="small"
                        icon={<EditOutlined />}
                        disabled={!canMutate}
                        onClick={startEdit}
                      >
                        Sửa
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={!canMutate}
                        onClick={confirmDelete}
                      >
                        Xóa
                      </Button>
                    </>
                  )}
                </Space>
              </Space>
              <Typography.Text type="secondary" style={{ fontSize: 12, display: "block" }}>
                {selected.targetRel}
              </Typography.Text>
              {editing ? (
                <Input.TextArea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{
                    marginTop: 8,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                  autoSize={{ minRows: 16, maxRows: 28 }}
                />
              ) : (
                <pre className="code" style={{ marginTop: 8, maxHeight: 440 }}>
                  {selected.preview.content}
                </pre>
              )}
            </>
          ) : (
            <Typography.Text type="secondary">Chọn file để xem preview.</Typography.Text>
          )}
        </div>
      </div>
    </Card>
  );
}
