/**
 * E2E Staging preview — mirror Unit BatchStagingPreview:
 * files grouped by TC + right code preview with Sửa/Xóa.
 */
import { useEffect, useMemo, useState } from "react";
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
import type { E2EFileDto } from "../../api";
import { stagingDirHint } from "../../lib/e2eWorkspace/stagingApply";
import type { E2eGenItem } from "../../lib/e2eWorkspace";
import { isTauri } from "../../tauri/bridge";
import {
  BATCH_NOTE_PAUSED,
  BATCH_NOTE_RUNNING,
  BATCH_NOTE_WAITING,
} from "../unit-test/BatchRunConsole";
import type { E2eBatchPipelineRow } from "./E2eBatchConsole";

type Props = {
  rows: E2eBatchPipelineRow[];
  genItems: E2eGenItem[];
  files: E2EFileDto[];
  /** Staging run id (overlay) when available */
  runId?: string | null;
  selectedPath: string | null;
  onSelectPath: (path: string | null) => void;
  /** Persist edit/delete to staging + AItest/ disk */
  onSaveFile?: (path: string, content: string) => Promise<void>;
  onDeleteFile?: (path: string) => Promise<void>;
};

type FlatFile = {
  path: string;
  kind: string;
  content: string;
  testCaseId: string;
  tcTitle: string;
  op: "new" | "modify";
};

type TcFileGroup = {
  key: string;
  testCaseId: string;
  tcTitle: string;
  files: FlatFile[];
};

type SharedFile = FlatFile & {
  sharedByTcIds: string[];
  sharedByCount: number;
  reason: "scaffold" | "multi-tc";
};

function shortPath(path: string): string {
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

function isLikelySharedScaffold(path: string): boolean {
  const p = normRel(path).toLowerCase();
  return (
    /\/_shared\//i.test(p) ||
    /\/playwright\.config\.[cm]?[jt]s$/i.test(p) ||
    /\/playwright-shim\.d\.ts$/i.test(p)
  );
}

export function E2eBatchStagingPreview({
  rows,
  genItems,
  files,
  runId,
  selectedPath,
  onSelectPath,
  onSaveFile,
  onDeleteFile,
}: Props) {
  const { message, modal } = App.useApp();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const [saving, setSaving] = useState(false);
  const [openKeys, setOpenKeys] = useState<string[]>([]);

  const okCount = rows.filter((r) => r.status === "ok").length;
  const failJobs = useMemo(
    () =>
      rows.filter(
        (r) =>
          r.status === "fail" &&
          r.error !== BATCH_NOTE_WAITING &&
          r.error !== BATCH_NOTE_PAUSED &&
          r.error !== BATCH_NOTE_RUNNING
      ),
    [rows]
  );
  const waitingCount = rows.filter(
    (r) =>
      r.error === BATCH_NOTE_WAITING ||
      r.error === BATCH_NOTE_PAUSED ||
      r.error === BATCH_NOTE_RUNNING
  ).length;
  const pausedCount = rows.filter((r) => r.error === BATCH_NOTE_PAUSED).length;

  const allFiles: FlatFile[] = useMemo(() => {
    const byTc = new Map(genItems.map((g) => [g.testCaseId, g]));
    return files.map((f) => {
      const owner =
        [...byTc.values()].find((g) => g.files.some((x) => x.path === f.path)) ||
        null;
      return {
        path: f.path,
        kind: f.kind || "spec",
        content: f.content || "",
        testCaseId: owner?.testCaseId || "",
        tcTitle: owner?.title || "",
        op: "new" as const,
      };
    });
  }, [files, genItems]);

  const { sharedFiles, tcGroups } = useMemo(() => {
    const byPath = new Map<string, FlatFile[]>();
    for (const f of allFiles) {
      const k = normRel(f.path);
      const list = byPath.get(k) || [];
      list.push(f);
      byPath.set(k, list);
    }

    const sharedDedup = new Map<string, SharedFile>();
    for (const [path, list] of byPath) {
      const tcIds = [...new Set(list.map((f) => f.testCaseId).filter(Boolean))];
      const scaffold = isLikelySharedScaffold(path);
      if (!scaffold && tcIds.length < 2 && list.length < 2) continue;
      const rep = list[list.length - 1]!;
      sharedDedup.set(path, {
        ...rep,
        sharedByTcIds: tcIds,
        sharedByCount: Math.max(tcIds.length, 1),
        reason: scaffold ? "scaffold" : "multi-tc",
      });
    }

    const sharedTargets = new Set(sharedDedup.keys());
    const map = new Map<string, TcFileGroup>();
    for (const f of allFiles) {
      if (sharedTargets.has(normRel(f.path))) continue;
      const gKey = f.testCaseId || f.path;
      let g = map.get(gKey);
      if (!g) {
        g = {
          key: gKey,
          testCaseId: f.testCaseId || "(khác)",
          tcTitle: f.tcTitle,
          files: [],
        };
        map.set(gKey, g);
      }
      g.files.push(f);
    }
    return {
      sharedFiles: [...sharedDedup.values()],
      tcGroups: [...map.values()].filter((g) => g.files.length > 0),
    };
  }, [allFiles]);

  const displayFiles = useMemo(
    () => [...sharedFiles, ...tcGroups.flatMap((g) => g.files)],
    [sharedFiles, tcGroups]
  );

  const selected =
    displayFiles.find((f) => f.path === selectedPath) ?? displayFiles[0] ?? null;

  const selectedIsShared = useMemo(
    () =>
      !!selected &&
      sharedFiles.some((f) => normRel(f.path) === normRel(selected.path)),
    [selected, sharedFiles]
  );

  const selectedGroupKey = useMemo(() => {
    if (!selected) return tcGroups[0]?.key;
    if (selectedIsShared) return "shared";
    return (
      tcGroups.find((g) => g.files.some((f) => f.path === selected.path))?.key ||
      tcGroups[0]?.key
    );
  }, [tcGroups, selected, selectedIsShared]);

  useEffect(() => {
    if (!selectedPath && displayFiles[0]) {
      onSelectPath(displayFiles[0].path);
    }
  }, [displayFiles, selectedPath, onSelectPath]);

  useEffect(() => {
    setEditing(false);
    setDraft("");
  }, [selected?.path]);

  useEffect(() => {
    if (!selectedGroupKey) return;
    setOpenKeys((prev) =>
      prev.includes(selectedGroupKey) ? prev : [...prev, selectedGroupKey]
    );
  }, [selectedGroupKey]);

  if (rows.length === 0 && files.length === 0) return null;

  const hintRun = runId || genItems[0]?.runId || "batch";
  const canMutate = isTauri() && (!!onSaveFile || !!onDeleteFile) && !!selected;

  function startEdit() {
    if (!selected) return;
    setDraft(selected.content);
    setEditing(true);
  }

  async function saveEdit() {
    if (!selected || !onSaveFile) return;
    setSaving(true);
    try {
      await onSaveFile(selected.path, draft);
      message.success("Đã lưu staging + source");
      setEditing(false);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function confirmDelete() {
    if (!selected || !onDeleteFile) return;
    modal.confirm({
      title: "Xóa file E2E đã gen?",
      content: (
        <Typography.Paragraph style={{ marginBottom: 0 }}>
          Xóa{" "}
          <Typography.Text code style={{ fontSize: 12 }}>
            {selected.path}
          </Typography.Text>{" "}
          khỏi kết quả Generate / staging và file trên source dưới{" "}
          <code>AItest/E2ETest/</code>.
        </Typography.Paragraph>
      ),
      okText: "Xóa",
      okType: "danger",
      cancelText: "Hủy",
      onOk: async () => {
        try {
          await onDeleteFile(selected.path);
          message.success("Đã xóa staging + source");
          setEditing(false);
          onSelectPath(null);
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
          throw e;
        }
      },
    });
  }

  return (
    <Card
      id="aitest-e2e-batch-staging-preview"
      title="2. Staging preview"
      style={{ marginTop: 8 }}
      extra={
        <Space wrap>
          <Tag color="blue">run: {String(hintRun).slice(0, 28)}</Tag>
          <Tag>{okCount > 0 ? "generated" : waitingCount > 0 ? "generating" : "idle"}</Tag>
          <Tag color="blue">{displayFiles.length} file</Tag>
          {sharedFiles.length > 0 ? (
            <Tag color="purple">{sharedFiles.length} dùng chung</Tag>
          ) : null}
          <Tag color="success">{okCount} TC OK</Tag>
          {failJobs.length > 0 ? <Tag color="error">{failJobs.length} lỗi</Tag> : null}
          {pausedCount > 0 ? <Tag color="orange">{pausedCount} tạm dừng</Tag> : null}
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="File staging — chưa Apply vào source"
        description={
          <>
            Tạm trong{" "}
            <Typography.Text code style={{ fontSize: 12 }}>
              {stagingDirHint(String(hintRun))}
            </Typography.Text>
            . Nhóm «Dùng chung» + theo TC — <strong>Sửa/Xóa</strong> đồng bộ overlay và source{" "}
            <code>AItest/E2ETest/</code>.
          </>
        }
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
                    renderItem={(item) => {
                      const active = item.path === (selected?.path ?? "");
                      return (
                        <List.Item
                          onClick={() => onSelectPath(item.path)}
                          style={{
                            cursor: "pointer",
                            padding: "6px 8px",
                            borderRadius: 6,
                            background: active
                              ? "var(--ant-color-primary-bg, #e6f4ff)"
                              : undefined,
                          }}
                        >
                          <Space orientation="vertical" size={2} style={{ width: "100%" }}>
                            <Space wrap size={4}>
                              <Tag color="green" style={{ margin: 0 }}>
                                {item.kind || "new"}
                              </Tag>
                              <Tag color="purple" style={{ margin: 0 }}>
                                {item.reason === "scaffold"
                                  ? "scaffold"
                                  : `×${item.sharedByCount} TC`}
                              </Tag>
                            </Space>
                            <Typography.Text
                              code
                              style={{ fontSize: 12 }}
                              ellipsis
                              title={item.path}
                            >
                              {shortPath(item.path)}
                            </Typography.Text>
                          </Space>
                        </List.Item>
                      );
                    }}
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
                  items={tcGroups.map((g) => ({
                    key: g.key,
                    label: (
                      <Space wrap size={4}>
                        <Typography.Text code style={{ fontSize: 12 }}>
                          {g.testCaseId}
                        </Typography.Text>
                        {g.tcTitle ? (
                          <Typography.Text
                            type="secondary"
                            style={{ fontSize: 12, maxWidth: 160 }}
                            ellipsis
                          >
                            {g.tcTitle}
                          </Typography.Text>
                        ) : null}
                        <Tag style={{ margin: 0 }}>{g.files.length} file</Tag>
                      </Space>
                    ),
                    children: (
                      <List
                        size="small"
                        dataSource={g.files}
                        renderItem={(item) => {
                          const active = item.path === (selected?.path ?? "");
                          return (
                            <List.Item
                              onClick={() => onSelectPath(item.path)}
                              style={{
                                cursor: "pointer",
                                padding: "6px 8px",
                                borderRadius: 6,
                                background: active
                                  ? "var(--ant-color-primary-bg, #e6f4ff)"
                                  : undefined,
                              }}
                            >
                              <Space
                                orientation="vertical"
                                size={2}
                                style={{ width: "100%" }}
                              >
                                <Space size={4}>
                                  <CheckCircleOutlined
                                    style={{ color: "var(--ant-color-success)" }}
                                  />
                                  <Tag color="green" style={{ margin: 0 }}>
                                    {item.kind || "new"}
                                  </Tag>
                                </Space>
                                <Typography.Text
                                  code
                                  style={{ fontSize: 12 }}
                                  ellipsis
                                  title={item.path}
                                >
                                  {shortPath(item.path)}
                                </Typography.Text>
                              </Space>
                            </List.Item>
                          );
                        }}
                      />
                    ),
                  }))}
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
                      <Typography.Text style={{ fontSize: 12 }}>{job.title}</Typography.Text>
                      <Typography.Text type="danger" style={{ fontSize: 11 }}>
                        {job.error}
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
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Preview: {selected.path}
                </Typography.Text>
                <Space>
                  {editing ? (
                    <>
                      <Button
                        size="small"
                        type="primary"
                        icon={<SaveOutlined />}
                        loading={saving}
                        disabled={!onSaveFile}
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
                        disabled={!canMutate || !onSaveFile}
                        onClick={startEdit}
                      >
                        Sửa
                      </Button>
                      <Button
                        size="small"
                        danger
                        icon={<DeleteOutlined />}
                        disabled={!canMutate || !onDeleteFile}
                        onClick={confirmDelete}
                      >
                        Xóa
                      </Button>
                    </>
                  )}
                </Space>
              </Space>
              {editing ? (
                <Input.TextArea
                  value={draft}
                  onChange={(e) => setDraft(e.target.value)}
                  style={{
                    marginTop: 8,
                    fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace",
                    fontSize: 12,
                    lineHeight: 1.45,
                    background: "#1e1e1e",
                    color: "#d4d4d4",
                  }}
                  autoSize={{ minRows: 16, maxRows: 28 }}
                />
              ) : (
                <pre
                  className="code"
                  style={{
                    marginTop: 8,
                    maxHeight: 460,
                    overflow: "auto",
                    background: "#1e1e1e",
                    color: "#d4d4d4",
                    padding: 12,
                    borderRadius: 8,
                    fontSize: 12,
                    lineHeight: 1.45,
                  }}
                >
                  {selected.content || "(empty)"}
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
