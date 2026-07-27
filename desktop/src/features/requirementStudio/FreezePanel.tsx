/**
 * Freeze Snapshot (tài liệu + Phân tích + TC đã có) rồi Sinh TC.
 * Flow ẩn: tổng hợp docs + Phân tích + inventory TC trước khi output.
 */
import { useEffect, useState } from "react";
import { Alert, Button, Empty, Input, Space, Spin, Typography } from "antd";
import { LockOutlined, ThunderboltOutlined } from "@ant-design/icons";
import { requirementStudio } from "../../api";
import type {
  KnowledgeWorkspaceView,
  RequirementSnapshot,
} from "../../api/types";
import { waitForJob } from "../../lib/waitForJob";

type Props = {
  workspaceId: string | null;
  knowledge: KnowledgeWorkspaceView | null;
  onOpenKnowledge?: () => void;
  onGenerated?: (info: { snapshotId: string; jobId: string }) => void;
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
  const [error, setError] = useState<string | null>(null);
  const [lastWarnings, setLastWarnings] = useState<{ code?: string; message?: string }[]>(
    []
  );

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

  const runFreezeAndGenerate = async () => {
    if (!workspaceId || running) return;
    setRunning(true);
    setError(null);
    setLastWarnings([]);
    try {
      const res = await requirementStudio.freezeAndGenerate(workspaceId, {
        acknowledgeMissing: true,
        note: note.trim() || undefined,
        mode: "append",
      });
      setLastWarnings(res.warnings ?? []);
      setSnapshots((prev) => [res.snapshot, ...prev]);
      const jobId = res.job.id;
      const snapshotId = String(res.snapshot.id);
      const job = await waitForJob(jobId);
      if (job.status === "Failed") {
        throw new Error(job.error || "Tạo test case thất bại");
      }
      onGenerated?.({ snapshotId, jobId });
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
            Chốt snapshot và tạo test case
          </Button>
        </Space>
        {running ? (
          <Typography.Text type="secondary">
            <Spin size="small" /> Đang tổng hợp tài liệu, phân tích và test case hiện có…
          </Typography.Text>
        ) : null}
      </div>

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
