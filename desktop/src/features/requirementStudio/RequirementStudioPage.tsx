/**
 * Requirement Studio — Tài liệu → Phân tích → Sinh TC.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
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
  SyncOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { connection, requirementStudio } from "../../api";
import type {
  KnowledgeWorkspaceView,
  RequirementFileRef,
  RequirementStudioWorkspace,
} from "../../api/types";
import { useProject } from "../../state/ProjectContext";
import { ROUTES } from "../../lib/productRoutes";
import RequirementRichPreview from "../../components/RequirementRichPreview";
import KnowledgePanel from "./KnowledgePanel";
import FreezePanel from "./FreezePanel";

const ACCEPT =
  ".md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.htm,.feature,.doc,.docx";

export type StudioFocus = "docs" | "knowledge" | "freeze";

export type StudioStatusSnapshot = {
  fileCount: number;
  knowledgeStatus: string;
  hasSnapshot?: boolean;
};

type Props = {
  workspaceId: string;
  focus?: StudioFocus;
  onFocusChange?: (focus: StudioFocus) => void;
  onStatusChange?: (status: StudioStatusSnapshot) => void;
  onNavigateReview?: (opts?: { engine?: "unit" | "e2e" }) => void;
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
  const navigate = useNavigate();
  const { project } = useProject();
  const [workspace, setWorkspace] = useState<RequirementStudioWorkspace | null>(null);
  const [files, setFiles] = useState<RequirementFileRef[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [detail, setDetail] = useState<RequirementFileRef | null>(null);
  const [knowledge, setKnowledge] = useState<KnowledgeWorkspaceView | null>(null);
  const [hasSnapshot, setHasSnapshot] = useState(false);
  const [innerFocus, setInnerFocus] = useState<StudioFocus>("docs");
  const [bootLoading, setBootLoading] = useState(false);
  const [listLoading, setListLoading] = useState(false);
  const [detailLoading, setDetailLoading] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const isAnalyzing = building || Boolean(knowledge?.enrichPending);

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
  // Phân tích dựa SRS extracted_text.
  const canBuildKnowledge = files.some(
    (f) => f.parseStatus === "ready" && (f.charCount ?? 0) > 0
  );

  const emitStatus = useCallback(
    (
      nextFiles: RequirementFileRef[],
      kw: KnowledgeWorkspaceView | null,
      snapFlag?: boolean
    ) => {
      onStatusChange?.({
        fileCount: nextFiles.length,
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
      return;
    }
    let cancelled = false;
    (async () => {
      setDetailLoading(true);
      try {
        const file = await requirementStudio.getFile(selectedId);
        if (cancelled) return;
        setDetail(file);
      } catch (e) {
        if (!cancelled) {
          message.error(e instanceof Error ? e.message : String(e));
          setDetail(null);
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
        const one = res.items[0];
        message.success(
          res.items.length === 1
            ? `Đã thêm «${one.fileName}» · ${(one.charCount ?? 0).toLocaleString()} ký tự`
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

  const buildKnowledge = async () => {
    if (!workspace || !project) return;
    try {
      const conn = await connection.get(project.id).catch(() => null);
      if (!conn || conn.status !== "Ready") {
        message.warning("Dự án chưa cấu hình AI. Vui lòng thiết lập kết nối AI trước khi phân tích.");
        navigate(ROUTES.settingsAi);
        return;
      }
    } catch {
      message.warning("Không kiểm tra được cấu hình AI. Vui lòng kiểm tra kết nối.");
      navigate(ROUTES.settingsAi);
      return;
    }
    setBuilding(true);
    try {
      const kw = await requirementStudio.buildKnowledge(workspace.id, true);
      setKnowledge(kw);
      emitStatus(files, kw);
      setFocus("knowledge");
      if (kw.enrichPending || kw.status === "building") {
        message.info("Đang hiển thị dữ liệu sơ bộ — AI đang bổ sung chi tiết trong nền…");
      } else {
        setBuilding(false);
        message.success(
          kw.builder === "llm" || kw.builder === "llm-cli"
            ? `Phân tích v${kw.version} (${kw.builder === "llm-cli" ? "AI CLI" : "LLM"})`
            : `Phân tích v${kw.version}`
        );
      }
    } catch (e) {
      setBuilding(false);
      message.error(e instanceof Error ? e.message : String(e));
    }
  };

  // Progressive enrich: poll until Cursor/LLM merge finishes (hiển thị heuristic ngay, cập nhật khi AI xong)
  useEffect(() => {
    if (!workspace?.id || !knowledge?.enrichPending) return;
    const ENRICH_POLL_INITIAL_MS = 1000;
    const ENRICH_POLL_MS = 1500;
    const ENRICH_POLL_ERROR_MS = 3000;
    let cancelled = false;
    const wid = workspace.id;
    const started = Date.now();
    const maxMs = 10 * 60 * 1000;
    const tick = async () => {
      try {
        const kw = await requirementStudio.getKnowledge(wid);
        if (cancelled) return;
        setKnowledge(kw);
        emitStatus(files, kw);
        if (!kw.enrichPending) {
          setBuilding(false);
          if (kw.builder === "llm" || kw.builder === "llm-cli") {
            message.success(
              `Phân tích v${kw.version} (${kw.builder === "llm-cli" ? "AI CLI" : "LLM"})`
            );
          } else if (kw.enrichError) {
            message.warning(
              `Phân tích AI không hoàn tất — dùng bản dự phòng. (${kw.enrichError})`
            );
          } else {
            message.success(`Phân tích v${kw.version}`);
          }
          return;
        }
        if (Date.now() - started > maxMs) {
          setBuilding(false);
          // Unstick UI: stop treating enrich as pending so heuristic payload can show.
          setKnowledge({
            ...kw,
            enrichPending: false,
            enrichError:
              kw.enrichError ||
              "Phân tích AI quá lâu — đang hiện bản dự phòng. Bấm Phân tích lại nếu cần.",
            status: kw.status === "building" ? "ready" : kw.status,
          });
          message.warning("Phân tích AI quá lâu — hiện bản dự phòng. Có thể Phân tích lại.");
          return;
        }
        window.setTimeout(() => {
          void tick();
        }, ENRICH_POLL_MS);
      } catch {
        if (!cancelled) {
          window.setTimeout(() => {
            void tick();
          }, ENRICH_POLL_ERROR_MS);
        }
      }
    };
    const t = window.setTimeout(() => {
      void tick();
    }, ENRICH_POLL_INITIAL_MS);
    return () => {
      cancelled = true;
      window.clearTimeout(t);
    };
  }, [workspace?.id, knowledge?.enrichPending, knowledge?.version, emitStatus, files, message]);

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
          title: "Tạo test case",
          lead: "Tổng hợp tài liệu, phân tích và test case hiện có thành snapshot, rồi tạo bộ test case.",
        }
      : focus === "knowledge"
        ? {
            title: "Phân tích",
            lead: isAnalyzing
              ? "AI đang phân tích và tổng hợp kiến thức từ tài liệu (vui lòng chờ trong giây lát)…"
              : "Tổng hợp kiến thức từ tài liệu. Sau khi sẵn sàng, chuyển sang bước tạo test case.",
          }
        : {
            title: "Tài liệu",
            lead: isAnalyzing
              ? "Hệ thống đang phân tích tài liệu bằng AI trong nền…"
              : "Tải lên tài liệu SRS (parse xong) rồi Phân tích.",
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
          {isAnalyzing ? (
            <Tag color="processing" icon={<SyncOutlined spin />}>
              Đang phân tích AI…
            </Tag>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={() => void boot()} disabled={bootLoading}>
            Tải lại
          </Button>
          {focus === "docs" && canBuildKnowledge ? (
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={isAnalyzing}
              disabled={isAnalyzing}
              onClick={() => void buildKnowledge()}
            >
              {isAnalyzing ? "Đang phân tích…" : "Phân tích"}
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
          onGenerated={(info) => {
            setHasSnapshot(true);
            emitStatus(files, knowledge, true);
            if (info.preferredEngine === "e2e") {
              message.success("Đã tạo TC E2E từ snapshot. Chuyển sang duyệt.");
              onNavigateReview?.({ engine: "e2e" });
            } else {
              message.success("Đã tạo test case Unit từ snapshot. Chuyển sang duyệt.");
              onNavigateReview?.({ engine: "unit" });
            }
          }}
          onPartialGenerated={(info) => {
            setHasSnapshot(true);
            message.info(
              `Đã lưu sớm ${info.savedCount} TC ${info.preferredEngine === "e2e" ? "E2E" : "Unit"} — bảng bên dưới đang cập nhật…`,
              3
            );
          }}
        />
      ) : focus === "knowledge" ? (
        <KnowledgePanel
          knowledge={knowledge}
          building={isAnalyzing}
          canBuild={canBuildKnowledge}
          onBuild={() => void buildKnowledge()}
          onOpenFreeze={() => setFocus("freeze")}
          onRefresh={() => {
            if (workspace) void loadKnowledge(workspace.id).then((kw) => emitStatus(files, kw));
          }}
        />
      ) : (
        <>
          {knowledge?.status === "stale" ? (
            <Alert
              type="info"
              showIcon
              title="Phân tích cần cập nhật sau khi đổi tài liệu"
              action={
                <Button size="small" type="primary" onClick={() => setFocus("knowledge")}>
                  Xem và phân tích lại
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
                    {errorCount ? ` · ${errorCount} lỗi` : ""}
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
                  Đang tải lên…
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
                              {formatSize(f.byteSize)}
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
                <Empty description="Chọn một tài liệu để xem nội dung" />
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
                      <Popconfirm
                        title="Gỡ tài liệu này?"
                        description="Nội dung đã đọc của file cũng sẽ bị gỡ."
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
