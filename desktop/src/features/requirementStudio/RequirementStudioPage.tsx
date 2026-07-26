/**
 * Requirement Studio — Tài liệu → Phân tích → Sinh TC.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Collapse,
  Empty,
  Popconfirm,
  Space,
  Spin,
  Tabs,
  Tag,
  Tooltip,
  Typography,
  Upload,
} from "antd";
import {
  CloseCircleFilled,
  DeleteOutlined,
  FileTextOutlined,
  InboxOutlined,
  ReloadOutlined,
  SplitCellsOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { requirementStudio } from "../../api";
import type {
  DocumentChunk,
  KnowledgeWorkspaceView,
  RequirementFileRef,
  RequirementStudioWorkspace,
} from "../../api/types";
import { useProject } from "../../state/ProjectContext";
import RequirementRichPreview from "../../components/RequirementRichPreview";
import KnowledgePanel from "./KnowledgePanel";
import FreezePanel from "./FreezePanel";

const ACCEPT =
  ".md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.htm,.feature,.doc,.docx";

export type StudioFocus = "docs" | "knowledge" | "freeze";

export type StudioStatusSnapshot = {
  fileCount: number;
  chunkCount: number;
  knowledgeStatus: string;
  hasSnapshot?: boolean;
};

type Props = {
  workspaceId: string;
  focus?: StudioFocus;
  onFocusChange?: (focus: StudioFocus) => void;
  onStatusChange?: (status: StudioStatusSnapshot) => void;
  onNavigateReview?: () => void;
  onBackToHub?: () => void;
};

function parseLabel(status: string) {
  if (status === "ready") return { color: "success" as const, text: "Đã đọc" };
  if (status === "error") return { color: "error" as const, text: "Lỗi" };
  return { color: "default" as const, text: "Đang xử lý" };
}

function formatSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function RequirementStudioPage({
  workspaceId,
  focus: focusProp,
  onFocusChange,
  onStatusChange,
  onNavigateReview,
  onBackToHub,
}: Props) {
  const { message } = App.useApp();
  const { project } = useProject();
  const [workspace, setWorkspace] = useState<RequirementStudioWorkspace | null>(null);
  const [files, setFiles] = useState<RequirementFileRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequirementFileRef | null>(null);
  const [chunks, setChunks] = useState<DocumentChunk[]>([]);
  const [knowledge, setKnowledge] = useState<KnowledgeWorkspaceView | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [innerFocus, setInnerFocus] = useState<StudioFocus>("docs");
  const [bootLoading, setBootLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [rechunking, setRechunking] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const focus = focusProp ?? innerFocus;
  const setFocus = (next: StudioFocus) => {
    if (focusProp === undefined) setInnerFocus(next);
    onFocusChange?.(next);
  };

  const selected = useMemo(
    () => files.find((f) => f.id === selectedId) ?? null,
    [files, selectedId]
  );

  const readyCount = files.filter((f) => f.parseStatus === "ready").length;
  const errorCount = files.filter((f) => f.parseStatus === "error").length;
  const chunkTotal = files.reduce((n, f) => n + (f.chunkCount ?? 0), 0);
  const needsRechunk = files.some(
    (f) => f.parseStatus === "ready" && (f.chunkCount ?? 0) === 0
  );
  const canBuildKnowledge = chunkTotal > 0;

  const emitStatus = useCallback(
    (
      nextFiles: RequirementFileRef[],
      kw: KnowledgeWorkspaceView | null,
      snapFlag?: boolean
    ) => {
      onStatusChange?.({
        fileCount: nextFiles.length,
        chunkCount: nextFiles.reduce((sum, f) => sum + (f.chunkCount ?? 0), 0),
        knowledgeStatus: kw?.status ?? "empty",
        hasSnapshot: snapFlag ?? hasSnapshot,
      });
    },
    [onStatusChange, hasSnapshot]
  );

  const loadKnowledge = useCallback(async (wid: string) => {
    const kw = await requirementStudio.getKnowledge(wid);
    setKnowledge(kw);
    return kw;
  }, []);

  const loadFiles = useCallback(
    async (wid: string, preferSelect?: string | null) => {
      setListLoading(true);
      setError(null);
      try {
        const res = await requirementStudio.listFiles(wid);
        setFiles(res.items);
        setSelectedId((prev) => {
          const want = preferSelect ?? prev;
          if (want && res.items.some((f) => f.id === want)) return want;
          return res.items[0]?.id ?? null;
        });
        let kw: KnowledgeWorkspaceView | null = null;
        let snap = false;
        try {
          kw = await loadKnowledge(wid);
        } catch {
          kw = null;
        }
        try {
          const snaps = await requirementStudio.listSnapshots(wid);
          snap = snaps.items.length > 0;
          setHasSnapshot(snap);
        } catch {
          setHasSnapshot(false);
        }
        emitStatus(res.items, kw, snap);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
        setFiles([]);
      } finally {
        setListLoading(false);
      }
    },
    [emitStatus, loadKnowledge]
  );

  const boot = useCallback(async () => {
    if (!project || !workspaceId) return;
    setBootLoading(true);
    setError(null);
    try {
      const ws = await requirementStudio.getWorkspace(workspaceId);
      setWorkspace(ws);
      await loadFiles(ws.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setWorkspace(null);
    } finally {
      setBootLoading(false);
    }
  }, [project, workspaceId, loadFiles]);

  useEffect(() => {
    void boot();
  }, [boot]);

  useEffect(() => {
    if (!selectedId) {
      setDetail(null);
      setChunks([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      try {
        const [file, chunkRes] = await Promise.all([
          requirementStudio.getFile(selectedId),
          requirementStudio.listChunks(selectedId),
        ]);
        if (cancelled) return;
        setDetail(file);
        setChunks(chunkRes.items);
      } catch (e) {
        if (!cancelled) {
          message.error(e instanceof Error ? e.message : String(e));
          setDetail(null);
          setChunks([]);
        }
      } finally {
        if (!cancelled) setDetailLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId, message]);

  const onUpload = async (incoming: File[]) => {
    if (!workspace || !incoming.length) return;
    setUploading(true);
    try {
      const res = await requirementStudio.uploadFiles(workspace.id, incoming);
      const ok = res.items.filter((f) => f.parseStatus === "ready").length;
      const bad = res.items.length - ok;
      if (bad === 0) {
        message.success(
          res.items.length === 1
            ? `Đã thêm «${res.items[0].fileName}» · ${res.items[0].chunkCount ?? 0} đoạn`
            : `Đã thêm ${res.items.length} tài liệu`
        );
      } else {
        message.warning(`Thêm ${res.items.length} file · ${ok} ổn · ${bad} lỗi đọc`);
      }
      await loadFiles(workspace.id, res.items[res.items.length - 1]?.id);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setUploading(false);
    }
  };

  const removeFile = async (id: string) => {
    if (!workspace) return;
    try {
      await requirementStudio.deleteFile(id);
      message.success("Đã gỡ tài liệu");
      await loadFiles(workspace.id, id === selectedId ? null : selectedId);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  const rechunkAll = async () => {
    if (!workspace) return;
    setRechunking(true);
    try {
      const res = await requirementStudio.rechunkWorkspace(workspace.id);
      message.success(`Đã tách lại ${res.filesUpdated} file · ${res.chunkCount} đoạn`);
      await loadFiles(workspace.id, selectedId);
      if (selectedId) {
        const chunkRes = await requirementStudio.listChunks(selectedId);
        setChunks(chunkRes.items);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRechunking(false);
    }
  };

  const rechunkOne = async () => {
    if (!selectedId || !workspace) return;
    setRechunking(true);
    try {
      const updated = await requirementStudio.rechunkFile(selectedId);
      message.success(`Đã tách lại · ${updated.chunkCount ?? 0} đoạn`);
      await loadFiles(workspace.id, selectedId);
      const chunkRes = await requirementStudio.listChunks(selectedId);
      setChunks(chunkRes.items);
      setDetail(updated);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setRechunking(false);
    }
  };

  const buildKnowledge = async () => {
    if (!workspace) return;
    setBuilding(true);
    try {
      const kw = await requirementStudio.buildKnowledge(workspace.id, true);
      setKnowledge(kw);
      emitStatus(files, kw);
      message.success(
        kw.builder === "llm"
          ? `Phân tích v${kw.version} (LLM)`
          : `Phân tích v${kw.version} (heuristic)`
      );
      setFocus("knowledge");
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(false);
    }
  };

  if (!project) {
    return <Alert type="info" showIcon title="Chọn project để mở Requirement Studio" />;
  }

  if (bootLoading && !workspace) {
    return (
      <div className="studio-boot">
        <Spin tip="Đang mở workspace…" />
      </div>
    );
  }

  const hasFiles = files.length > 0;

  const stageMeta =
    focus === "freeze"
      ? {
          title: "Sinh test case",
          lead: "Tổng hợp tài liệu + Phân tích (+ TC đã có) → Snapshot → sinh TC chính xác.",
        }
      : focus === "knowledge"
        ? {
            title: "Phân tích",
            lead: "Knowledge từ tài liệu — sau khi Ready, sang Sinh test case.",
          }
        : {
            title: "Tài liệu",
            lead: "Upload và tách đoạn — rồi Dựng Phân tích.",
          };

  return (
    <div className="studio-page">
      <div className="studio-toolbar">
        <div className="studio-toolbar-main">
          {onBackToHub ? (
            <Button type="link" style={{ paddingInline: 0 }} onClick={onBackToHub}>
              ← Tất cả Requirement
            </Button>
          ) : null}
          <Typography.Title level={4} className="studio-title">
            {workspace?.title ? `${workspace.title} · ${stageMeta.title}` : stageMeta.title}
          </Typography.Title>
          <Typography.Text type="secondary" className="studio-lead">
            {stageMeta.lead}
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void boot()} disabled={bootLoading}>
            Tải lại
          </Button>
          {focus === "docs" && canBuildKnowledge ? (
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={building}
              onClick={() => void buildKnowledge()}
            >
              Dựng Phân tích
            </Button>
          ) : null}
        </Space>
      </div>

      {error ? (
        <Alert type="error" showIcon closable title={error} onClose={() => setError(null)} />
      ) : null}

      {focus === "freeze" ? (
        <FreezePanel
          workspaceId={workspace?.id ?? null}
          knowledge={knowledge}
          onOpenKnowledge={() => setFocus("knowledge")}
          onGenerated={() => {
            setHasSnapshot(true);
            emitStatus(files, knowledge, true);
            message.success("Đã sinh TC từ Snapshot — chuyển sang Duyệt TC");
            onNavigateReview?.();
          }}
        />
      ) : focus === "knowledge" ? (
        <KnowledgePanel
          knowledge={knowledge}
          building={building}
          canBuild={canBuildKnowledge}
          onBuild={() => void buildKnowledge()}
          onOpenFreeze={() => setFocus("freeze")}
          onRefresh={() => {
            if (workspace) void loadKnowledge(workspace.id).then((kw) => emitStatus(files, kw));
          }}
        />
      ) : (
        <>
          {needsRechunk ? (
            <Alert
              type="warning"
              showIcon
              title="Có tài liệu đã đọc nhưng chưa tách đoạn"
              action={
                <Button
                  size="small"
                  type="primary"
                  loading={rechunking}
                  onClick={() => void rechunkAll()}
                >
                  Tách ngay
                </Button>
              }
            />
          ) : null}

          {knowledge?.status === "stale" ? (
            <Alert
              type="info"
              showIcon
              title="Phân tích đang stale sau khi đổi tài liệu"
              action={
                <Button size="small" type="primary" onClick={() => setFocus("knowledge")}>
                  Xem & dựng lại
                </Button>
              }
            />
          ) : null}

          <div className={`studio-layout${hasFiles ? "" : " studio-layout--empty"}`}>
            <aside className="studio-files" aria-label="Danh sách tài liệu">
              <div className="studio-files-head">
                <Typography.Text strong>Tài liệu</Typography.Text>
                {hasFiles ? (
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {readyCount} ổn
                    {errorCount ? ` · ${errorCount} lỗi` : ""} · {chunkTotal} đoạn
                  </Typography.Text>
                ) : null}
              </div>

              <Upload.Dragger
                multiple
                accept={ACCEPT}
                disabled={uploading || !workspace}
                showUploadList={false}
                beforeUpload={(file) => {
                  void onUpload([file as unknown as File]);
                  return false;
                }}
                className={hasFiles ? "studio-upload studio-upload--compact" : "studio-upload"}
              >
                <p className="ant-upload-drag-icon">
                  <InboxOutlined />
                </p>
                <p className="ant-upload-text">
                  {hasFiles ? "Thêm tài liệu" : "Kéo thả hoặc chọn nhiều file"}
                </p>
                {!hasFiles ? (
                  <p className="ant-upload-hint">md, txt, html, docx… · tối đa ~15 MB / file</p>
                ) : null}
              </Upload.Dragger>

              {uploading ? (
                <Typography.Text type="secondary" style={{ padding: "0 12px 8px", fontSize: 12 }}>
                  Đang tải lên & tách đoạn…
                </Typography.Text>
              ) : null}

              {listLoading && !hasFiles ? (
                <div className="studio-files-empty">
                  <Spin />
                </div>
              ) : !hasFiles ? (
                <Empty
                  className="studio-files-empty"
                  image={Empty.PRESENTED_IMAGE_SIMPLE}
                  description="Chưa có tài liệu — kéo file vào vùng trên"
                />
              ) : (
                <ul className="studio-file-list">
                  {files.map((f) => {
                    const st = parseLabel(f.parseStatus);
                    const active = f.id === selectedId;
                    return (
                      <li key={f.id}>
                        <button
                          type="button"
                          className={`studio-file-item${active ? " is-active" : ""}`}
                          onClick={() => setSelectedId(f.id)}
                        >
                          <span className="studio-file-icon" aria-hidden>
                            {f.parseStatus === "error" ? (
                              <CloseCircleFilled style={{ color: "var(--danger)" }} />
                            ) : (
                              <FileTextOutlined />
                            )}
                          </span>
                          <span className="studio-file-meta">
                            <span className="studio-file-name">{f.fileName}</span>
                            <span className="studio-file-sub">
                              <Tag color={st.color} style={{ marginInlineEnd: 4 }}>
                                {st.text}
                              </Tag>
                              {(f.chunkCount ?? 0) > 0
                                ? `${f.chunkCount} đoạn`
                                : formatSize(f.byteSize)}
                            </span>
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </aside>

            <section className="studio-detail" aria-label="Chi tiết tài liệu">
              {!selected ? (
                <Empty description="Chọn một tài liệu để xem nội dung và các đoạn đã tách" />
              ) : (
                <Spin spinning={detailLoading}>
                  <div className="studio-detail-head">
                    <div>
                      <Typography.Title level={5} style={{ margin: 0 }}>
                        {selected.fileName}
                      </Typography.Title>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        {formatSize(selected.byteSize)}
                        {selected.parser ? ` · ${selected.parser}` : ""}
                        {selected.charCount
                          ? ` · ${selected.charCount.toLocaleString()} ký tự`
                          : ""}
                        {" · "}
                        <Tooltip title={selected.contentSha256}>
                          <span>sha {selected.contentSha256.slice(0, 8)}…</span>
                        </Tooltip>
                      </Typography.Text>
                    </div>
                    <Space>
                      {selected.parseStatus === "ready" ? (
                        <Button
                          size="small"
                          icon={<SplitCellsOutlined />}
                          loading={rechunking}
                          onClick={() => void rechunkOne()}
                        >
                          Tách lại
                        </Button>
                      ) : null}
                      <Popconfirm
                        title="Gỡ tài liệu này?"
                        description="Các đoạn gắn với file cũng sẽ bị gỡ."
                        okText="Gỡ"
                        cancelText="Huỷ"
                        okButtonProps={{ danger: true }}
                        onConfirm={() => void removeFile(selected.id)}
                      >
                        <Button size="small" danger icon={<DeleteOutlined />}>
                          Gỡ
                        </Button>
                      </Popconfirm>
                    </Space>
                  </div>

                  {selected.parseStatus === "error" ? (
                    <Alert
                      type="error"
                      showIcon
                      title="Không đọc được file"
                      description={selected.parseError || "Lỗi không xác định"}
                    />
                  ) : null}

                  {selected.parseWarning ? (
                    <Alert type="warning" showIcon title={selected.parseWarning} />
                  ) : null}

                  <Tabs
                    className="studio-detail-tabs"
                    items={[
                      {
                        key: "preview",
                        label: "Xem nội dung",
                        children: (
                          <div className="studio-preview-pane">
                            {detail?.previewHtml ? (
                              <RequirementRichPreview html={detail.previewHtml} />
                            ) : detail?.extractedText ? (
                              <pre className="studio-text-preview">{detail.extractedText}</pre>
                            ) : (
                              <Empty description="Chưa có nội dung xem trước" />
                            )}
                          </div>
                        ),
                      },
                      {
                        key: "chunks",
                        label: `Đoạn đã tách (${chunks.length})`,
                        children: (
                          <div className="studio-chunks-pane">
                            {chunks.length === 0 ? (
                              <Empty
                                description={
                                  selected.parseStatus === "ready"
                                    ? "Chưa có đoạn — bấm «Tách lại»"
                                    : "Cần đọc file thành công trước"
                                }
                              />
                            ) : (
                              <Collapse
                                accordion
                                bordered={false}
                                className="studio-chunk-collapse"
                                items={chunks.map((c) => ({
                                  key: c.id,
                                  label: (
                                    <span className="studio-chunk-label">
                                      <Typography.Text type="secondary">
                                        #{c.ordinal + 1}
                                      </Typography.Text>
                                      <span>
                                        {c.heading?.trim() ||
                                          c.text.slice(0, 72).replace(/\s+/g, " ") +
                                            (c.text.length > 72 ? "…" : "")}
                                      </span>
                                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                                        {c.charCount} ký tự
                                      </Typography.Text>
                                    </span>
                                  ),
                                  children: <pre className="studio-chunk-body">{c.text}</pre>,
                                }))}
                              />
                            )}
                          </div>
                        ),
                      },
                    ]}
                  />
                </Spin>
              )}
            </section>
          </div>
        </>
      )}
    </div>
  );
}
