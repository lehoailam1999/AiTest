/**
 * Freeze Snapshot rồi Sinh TC.
 * Cả Unit và E2E đều gửi preferredEngine để BE đồng bộ prompt + lưu type DB.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { LockOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { requirementStudio, testcases } from "../../api";
import type {
  KnowledgeWorkspaceView,
  RequirementSnapshot,
  TestCase,
} from "../../api/types";
import { EnginePicker } from "../../components/EnginePicker";
import { waitForJob } from "../../lib/waitForJob";
import { labelOf, priorityLabel, typeLabel } from "../../i18n/labels";

type PreferredEngine = "unit" | "e2e";

type Props = {
  workspaceId: string | null;
  knowledge: KnowledgeWorkspaceView | null;
  onOpenKnowledge?: () => void;
  onGenerated?: (info: {
    snapshotId: string;
    jobId: string;
    preferredEngine: PreferredEngine;
  }) => void;
  /** Gọi khi đã có TC lưu sớm (progressive) — có thể mở duyệt trước khi job xong */
  onPartialGenerated?: (info: {
    snapshotId: string;
    jobId: string;
    preferredEngine: PreferredEngine;
    savedCount: number;
  }) => void;
};

function parseSavedCount(msg: string): number | null {
  const m = msg.match(/tổng đã lưu\s+(\d+)/i);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) ? n : null;
}

const LIVE_TC_COLUMNS: ColumnsType<TestCase> = [
  {
    title: "Mã",
    dataIndex: "testCaseId",
    key: "code",
    width: 88,
    render: (v: string) => v || "—",
  },
  {
    title: "Tiêu đề",
    dataIndex: "title",
    key: "title",
    ellipsis: true,
  },
  {
    title: "Module",
    dataIndex: "module",
    key: "module",
    width: 120,
    ellipsis: true,
    render: (v: string) => v || "—",
  },
  {
    title: "Loại",
    dataIndex: "type",
    key: "type",
    width: 90,
    render: (v: string) => labelOf(typeLabel, v) || v || "—",
  },
  {
    title: "Ưu tiên",
    dataIndex: "priority",
    key: "priority",
    width: 100,
    render: (v: string) => labelOf(priorityLabel, v) || v || "—",
  },
];

export default function FreezePanel({
  workspaceId,
  knowledge,
  onOpenKnowledge,
  onGenerated,
  onPartialGenerated,
}: Props) {
  const [snapshots, setSnapshots] = useState<RequirementSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [engine, setEngine] = useState<PreferredEngine>("unit");
  const [targetUrl, setTargetUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [savedCount, setSavedCount] = useState(0);
  const [liveCases, setLiveCases] = useState<TestCase[]>([]);
  const [livePage, setLivePage] = useState(1);
  const [activeJob, setActiveJob] = useState<{
    jobId: string;
    snapshotId: string;
    preferredEngine: PreferredEngine;
  } | null>(null);
  const partialNotified = useRef(false);
  const [cliLog, setCliLog] = useState<string[]>([]);
  const [lastWarnings, setLastWarnings] = useState<{ code?: string; message?: string }[]>(
    []
  );
  const logEndRef = useRef<HTMLDivElement | null>(null);
  const logBodyRef = useRef<HTMLPreElement | null>(null);

  const knowledgeOk =
    knowledge?.status === "ready" || knowledge?.status === "stale";

  const livePageData = useMemo(() => {
    const start = (livePage - 1) * 20;
    return liveCases.slice(start, start + 20);
  }, [liveCases, livePage]);

  const reload = async (wid: string) => {
    setLoading(true);
    try {
      const res = await requirementStudio.listSnapshots(wid);
      setSnapshots(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!workspaceId || !knowledgeOk) {
      setSnapshots([]);
      return;
    }
    void reload(workspaceId);
  }, [workspaceId, knowledgeOk, knowledge?.version]);

  // Chỉ scroll trong khung nhật ký — không kéo cả trang / nền ngoài
  useEffect(() => {
    const el = logBodyRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [cliLog]);

  // Poll TC theo jobId khi đang sinh — bảng cập nhật ngay khi có TC mới
  useEffect(() => {
    if (!activeJob?.jobId || (!running && liveCases.length === 0)) return;
    let cancelled = false;
    const jobId = activeJob.jobId;

    const tick = async () => {
      try {
        const rows = await testcases.listAll({ jobId });
        if (cancelled) return;
        setLiveCases(rows);
        setSavedCount((prev) => Math.max(prev, rows.length));
      } catch {
        /* ignore poll errors */
      }
    };

    void tick();
    if (!running) return;
    const id = window.setInterval(() => {
      void tick();
    }, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [activeJob?.jobId, running]);

  const runFreezeAndGenerate = async () => {
    if (!workspaceId || running) return;
    setRunning(true);
    setError(null);
    setProgress("Đang chốt snapshot…");
    setCliLog(["--- Chốt snapshot & tạo job ---"]);
    setLastWarnings([]);
    setSavedCount(0);
    setLiveCases([]);
    setLivePage(1);
    setActiveJob(null);
    partialNotified.current = false;
    try {
      const res = await requirementStudio.freezeAndGenerate(workspaceId, {
        acknowledgeMissing: true,
        note: note.trim() || undefined,
        mode: "append",
        preferredEngine: engine,
        targetUrl: engine === "e2e" ? targetUrl.trim() || undefined : undefined,
      });
      setLastWarnings(res.warnings ?? []);
      setSnapshots((prev) => [res.snapshot, ...prev]);
      const jobId = res.job.id;
      const snapshotId = String(res.snapshot.id);
      setActiveJob({ jobId, snapshotId, preferredEngine: engine });
      setProgress(res.job.progressMessage || "Đã tạo job — đang gọi AI CLI…");
      setCliLog((prev) => [
        ...prev,
        `Job ${jobId}`,
        res.job.progressMessage || "Đã tạo job — đang gọi AI CLI…",
      ]);
      const job = await waitForJob(jobId, {
        onProgress: (msg) => {
          setProgress(msg);
          const n = parseSavedCount(msg);
          if (n != null && n > 0) {
            setSavedCount((prev) => Math.max(prev, n));
            if (!partialNotified.current) {
              partialNotified.current = true;
              onPartialGenerated?.({
                snapshotId,
                jobId,
                preferredEngine: engine,
                savedCount: n,
              });
            }
          }
          if (
            /^Module\s+\d+\s*\/\s*\d+/i.test(msg.trim()) ||
            /^\[progressive\]/i.test(msg.trim())
          ) {
            setCliLog((prev) => {
              const last = prev[prev.length - 1];
              if (last === msg) return prev;
              return [...prev, msg];
            });
          }
        },
        onLog: (lines) => setCliLog(lines.length ? lines : ["(chưa có log)"]),
      });
      if (job.progressLog?.length) setCliLog(job.progressLog);
      if (job.status === "Failed") {
        throw new Error(job.error || "Tạo test case thất bại");
      }
      try {
        const rows = await testcases.listAll({ jobId });
        setLiveCases(rows);
        setSavedCount(rows.length);
      } catch {
        /* keep polled state */
      }
      setProgress(job.progressMessage || "Hoàn tất");
      onGenerated?.({ snapshotId, jobId, preferredEngine: engine });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunning(false);
    }
  };

  if (!knowledgeOk) {
    return (
      <div className="freeze-panel">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Cần hoàn tất phân tích trước — snapshot dựa trên tài liệu đã tải lên và bản phân tích hiện tại."
        >
          {onOpenKnowledge ? (
            <Button type="primary" onClick={onOpenKnowledge}>
              Về Phân tích
            </Button>
          ) : null}
        </Empty>
      </div>
    );
  }

  return (
    <div className="freeze-panel">
      <Alert
        type="info"
        showIcon
        title="Nguồn tạo test case"
        description={
          <ul style={{ margin: "8px 0 0", paddingLeft: 18 }}>
            <li>
              <strong>Tài liệu</strong> đã tải lên
            </li>
            <li>
              <strong>Phân tích</strong> (quy tắc, actor, use case, API, ràng buộc…)
            </li>
            <li>
              <strong>Test case hiện có</strong> (nếu có) — tránh trùng, bổ sung phần còn thiếu
            </li>
          </ul>
        }
      />

      {error ? (
        <Alert type="error" showIcon title={error} closable onClose={() => setError(null)} />
      ) : null}

      {lastWarnings.length > 0 ? (
        <Alert
          type="warning"
          showIcon
          title="Cảnh báo khi chốt snapshot"
          description={lastWarnings.map((w) => w.message).filter(Boolean).join(" · ")}
        />
      ) : null}

      <div className="freeze-actions">
        <div className="freeze-engine-field">
          <Typography.Text strong>Loại test case</Typography.Text>
          <EnginePicker
            value={engine}
            onChange={(v) => {
              if (v === "unit" || v === "e2e") setEngine(v);
            }}
            disabled={running}
          />
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {engine === "e2e"
              ? "Luồng E2E: sinh TC journey UI (type=E2E). Không cần nhập login — vượt auth bằng storageState / E2E_USERNAME·E2E_PASSWORD khi chạy code. Target URL tuỳ chọn khi Freeze; bắt buộc trên trang E2E Test."
              : "Luồng Unit: sinh test case logic/service (type=Unit). Cùng pipeline fan-out + nhật ký AI CLI như E2E."}
          </Typography.Text>
        </div>

        {engine === "e2e" ? (
          <Input
            value={targetUrl}
            onChange={(e) => setTargetUrl(e.target.value)}
            placeholder="Target URL (tuỳ chọn) — http://localhost:3000"
            disabled={running}
            aria-label="Target URL"
          />
        ) : null}

        <Input.TextArea
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Ghi chú snapshot (tuỳ chọn)…"
          autoSize={{ minRows: 2, maxRows: 4 }}
          disabled={running}
        />
        <Space wrap>
          {onOpenKnowledge ? (
            <Button onClick={onOpenKnowledge} disabled={running}>
              Về Phân tích
            </Button>
          ) : null}
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={running}
            onClick={() => void runFreezeAndGenerate()}
          >
            {engine === "e2e"
              ? "Chốt snapshot và tạo TC E2E"
              : "Chốt snapshot và tạo test case"}
          </Button>
        </Space>
      </div>

      {running || cliLog.length > 0 ? (
        <div className="cli-log-panel" aria-live="polite">
          <div className="cli-log-panel__head">
            <Typography.Text strong>Nhật ký AI CLI</Typography.Text>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              {running ? "live · prompt + xử lý hệ thống" : "lần chạy gần nhất"} ·{" "}
              {cliLog.length} dòng
            </Typography.Text>
          </div>
          {running && savedCount > 0 ? (
            <Alert
              style={{ marginBottom: 8 }}
              type="success"
              showIcon
              title={`Đã có ${savedCount} test case`}
              description="TC được lưu dần theo từng module — bảng bên dưới cập nhật realtime."
              action={
                activeJob && onGenerated ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() =>
                      onGenerated({
                        snapshotId: activeJob.snapshotId,
                        jobId: activeJob.jobId,
                        preferredEngine: activeJob.preferredEngine,
                      })
                    }
                  >
                    Xem TC đã có
                  </Button>
                ) : null
              }
            />
          ) : null}
          {running ? (
            <Typography.Text type="secondary" className="cli-log-panel__status">
              <Spin size="small" />{" "}
              {progress ||
                (engine === "e2e"
                  ? "Đang tổng hợp tài liệu, phân tích và tạo TC E2E…"
                  : "Đang tổng hợp tài liệu, phân tích và test case hiện có…")}
            </Typography.Text>
          ) : null}
          <pre className="cli-log-panel__body" ref={logBodyRef}>
            {cliLog.length ? cliLog.join("\n\n") : "Chưa có log…"}
            <div ref={logEndRef} />
          </pre>
        </div>
      ) : null}

      {liveCases.length > 0 || (running && activeJob) ? (
        <div className="freeze-live-tc">
          <div className="freeze-live-tc__head">
            <Typography.Text strong>Test case đã sinh</Typography.Text>
            <Tag color={running ? "processing" : "success"}>
              {liveCases.length} TC
              {running ? " · đang cập nhật" : ""}
            </Tag>
          </div>
          <Table<TestCase>
            size="small"
            rowKey={(r) => r.id}
            columns={LIVE_TC_COLUMNS}
            dataSource={livePageData}
            loading={running && liveCases.length === 0}
            pagination={{
              current: livePage,
              pageSize: 20,
              total: liveCases.length,
              showSizeChanger: false,
              showTotal: (t) => `${t} test case`,
              onChange: (p) => setLivePage(p),
            }}
            locale={{ emptyText: running ? "Đang chờ TC đầu tiên…" : "Chưa có TC" }}
          />
        </div>
      ) : null}

      <div className="freeze-history">
        <Typography.Text strong>
          <LockOutlined /> Snapshot đã chốt
        </Typography.Text>
        {loading ? (
          <Spin />
        ) : snapshots.length === 0 ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Chưa có Snapshot — bấm CTA ở trên để tạo.
          </Typography.Text>
        ) : (
          <ul className="freeze-snapshot-list">
            {snapshots.map((s) => (
              <li key={s.id}>
                <Typography.Text>
                  {s.title || `Snapshot v${s.knowledgeVersion}`}
                </Typography.Text>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {" · "}v{s.knowledgeVersion}
                  {s.createdAt ? ` · ${new Date(s.createdAt).toLocaleString()}` : ""}
                </Typography.Text>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
