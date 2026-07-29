/**
 * Freeze Snapshot rồi Sinh TC.
 * Cả Unit và E2E đều gửi preferredEngine để BE đồng bộ prompt + lưu type DB.
 */
import { useEffect, useRef, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Input,
  Space,
  Spin,
  Typography,
} from "antd";
import { LockOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { requirementStudio } from "../../api";
import type {
  KnowledgeWorkspaceView,
  RequirementSnapshot,
} from "../../api/types";
import { EnginePicker } from "../../components/EnginePicker";
import { waitForJob } from "../../lib/waitForJob";

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
};

export default function FreezePanel({
  workspaceId,
  knowledge,
  onOpenKnowledge,
  onGenerated,
}: Props) {
  const [snapshots, setSnapshots] = useState<RequirementSnapshot[]>([]);
  const [loading, setLoading] = useState(false);
  const [running, setRunning] = useState(false);
  const [note, setNote] = useState("");
  const [engine, setEngine] = useState<PreferredEngine>("unit");
  const [targetUrl, setTargetUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [cliLog, setCliLog] = useState<string[]>([]);
  const [lastWarnings, setLastWarnings] = useState<{ code?: string; message?: string }[]>(
    []
  );
  const logEndRef = useRef<HTMLDivElement | null>(null);

  const knowledgeOk =
    knowledge?.status === "ready" || knowledge?.status === "stale";

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

  useEffect(() => {
    logEndRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [cliLog]);

  const runFreezeAndGenerate = async () => {
    if (!workspaceId || running) return;
    setRunning(true);
    setError(null);
    setProgress("Đang chốt snapshot…");
    setCliLog(["--- Chốt snapshot & tạo job ---"]);
    setLastWarnings([]);
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
      setProgress(res.job.progressMessage || "Đã tạo job — đang gọi AI CLI…");
      setCliLog((prev) => [
        ...prev,
        `Job ${jobId}`,
        res.job.progressMessage || "Đã tạo job — đang gọi AI CLI…",
      ]);
      const job = await waitForJob(jobId, {
        onProgress: (msg) => {
          setProgress(msg);
          // Highlight fan-out module lines in live status
          if (/^Module\s+\d+\s*\/\s*\d+/i.test(msg.trim())) {
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
          {running ? (
            <Typography.Text type="secondary" className="cli-log-panel__status">
              <Spin size="small" />{" "}
              {progress ||
                (engine === "e2e"
                  ? "Đang tổng hợp tài liệu, phân tích và tạo TC E2E…"
                  : "Đang tổng hợp tài liệu, phân tích và test case hiện có…")}
            </Typography.Text>
          ) : null}
          <pre className="cli-log-panel__body">
            {cliLog.length ? cliLog.join("\n\n") : "Chưa có log…"}
            <div ref={logEndRef} />
          </pre>
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
