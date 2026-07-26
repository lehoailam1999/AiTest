import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Alert, App, Button, Progress, Space, Typography } from "antd";
import {
  CodeOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import type { CoverageBoard } from "../model/coverageTypes";
import {
  expandTcGapTargets,
  listCodeGaps,
  listTcGaps,
  runTcGapFillCampaign,
  type GapFillProgress,
} from "../model/gapFill";
import { workspace } from "../../../workspace";
import { isTauri } from "../../../tauri/bridge";
import { connection } from "../../../api";
import { ROUTES, unitTestUrl } from "../../../lib/productRoutes";
import {
  createBatchRunControl,
  type BatchRunStatus,
} from "../../../lib/batchRunControl";

type Props = {
  projectId: string;
  board: CoverageBoard;
  disabled?: boolean;
  onDone: () => void;
};

/** F3 — Gap fill cả dự án (TC campaign tại chỗ; Code → wizard mode=gaps). */
export function GapFillBar({ projectId, board, disabled, onDone }: Props) {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<GapFillProgress | null>(null);
  const [batchRunStatus, setBatchRunStatus] = useState<BatchRunStatus>("idle");
  const batchControlRef = useRef(createBatchRunControl());

  useEffect(() => {
    return batchControlRef.current.subscribe(setBatchRunStatus);
  }, []);

  const tcGaps = useMemo(() => listTcGaps(board.modules), [board.modules]);
  const codeGaps = useMemo(() => listCodeGaps(board.modules), [board.modules]);
  const hasLocalPath = Boolean(workspace.getLocalPath(projectId));

  async function confirmTcGap() {
    if (tcGaps.length === 0) {
      message.info("Không có module Spec-ready còn 0 TC.");
      return;
    }
    const targets = await expandTcGapTargets(tcGaps);
    if (targets.length === 0) {
      message.warning("Không suy ra được job target từ Spec/topic.");
      return;
    }
    modal.confirm({
      title: "Sinh TC còn thiếu — cả dự án",
      content: (
        <div>
          <p>
            Sẽ tạo <strong>{targets.length}</strong> job AI cho{" "}
            <strong>{tcGaps.length}</strong> module gap (Spec ready · TC = 0).
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: "auto" }}>
            {tcGaps.slice(0, 12).map((m) => (
              <li key={m.key}>{m.displayName}</li>
            ))}
            {tcGaps.length > 12 ? <li>… +{tcGaps.length - 12}</li> : null}
          </ul>
          <Typography.Text type="secondary">
            Campaign hiện trên Activity. Có thể tạm dừng giữa các job.
          </Typography.Text>
        </div>
      ),
      okText: "Bắt đầu",
      cancelText: "Huỷ",
      onOk: () => runTc(targets),
    });
  }

  async function runTc(targets: Awaited<ReturnType<typeof expandTcGapTargets>>) {
    setRunning(true);
    setProgress({ current: 0, total: targets.length, label: "…" });
    try {
      const conn = await connection.get(projectId);
      if (conn.status !== "Ready" && conn.status !== "Connected") {
        message.error("AI chưa Ready — vào Cấu hình AI.");
        return;
      }
      const { ok, fail, campaignId } = await runTcGapFillCampaign({
        projectId,
        targets,
        onProgress: setProgress,
        control: batchControlRef.current,
      });
      if (fail === 0) {
        message.success(
          `Gap-fill TC xong: ${ok} job OK${campaignId ? " · xem Activity" : ""}.`
        );
      } else {
        message.warning(`Gap-fill TC: OK ${ok}, lỗi ${fail}. Xem Activity.`);
      }
      onDone();
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Gap-fill TC thất bại");
    } finally {
      setRunning(false);
      setProgress(null);
    }
  }

  function confirmCodeGap() {
    if (codeGaps.length === 0) {
      message.info("Không có module cần sinh mã (Approved + chưa applied).");
      return;
    }
    if (!hasLocalPath || !isTauri()) {
      modal.confirm({
        title: "Cần gắn Root Apply",
        content: "Sinh mã cả dự án cần gắn thư mục project trên Desktop trước (trang Unit test).",
        okText: "Unit test",
        onOk: () => navigate(ROUTES.unitTest),
      });
      return;
    }
    const mods = codeGaps.map((m) => m.displayName).join(",");
    modal.confirm({
      title: "Sinh mã còn thiếu — cả dự án",
      content: (
        <div>
          <p>
            Sẽ mở Sinh mã (mode gaps) cho <strong>{codeGaps.length}</strong> module có TC
            Approved chưa applied.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, maxHeight: 160, overflow: "auto" }}>
            {codeGaps.slice(0, 12).map((m) => (
              <li key={m.key}>
                {m.displayName} · {m.tcApproved} Approved
              </li>
            ))}
          </ul>
        </div>
      ),
      okText: "Tiếp tục",
      onOk: () => {
        navigate(
          unitTestUrl({
            mode: "gaps",
            modules: mods,
          })
        );
      },
    });
  }

  return (
    <div className="coverage-toolbar">
      <div className="coverage-toolbar-actions">
        <Button
          icon={<ThunderboltOutlined />}
          disabled={disabled || running || tcGaps.length === 0}
          loading={running && batchRunStatus === "running"}
          onClick={() => void confirmTcGap()}
        >
          Sinh TC còn thiếu
          {tcGaps.length ? ` (${tcGaps.length})` : ""}
        </Button>
        <Button
          icon={<CodeOutlined />}
          disabled={disabled || running || codeGaps.length === 0}
          onClick={() => confirmCodeGap()}
        >
          Sinh mã còn thiếu
          {codeGaps.length ? ` (${codeGaps.length})` : ""}
        </Button>
        <Link to="/activity">
          <Button type="link">Activity</Button>
        </Link>
      </div>

      {progress ? (
        <Alert
          type={batchRunStatus === "paused" ? "warning" : "info"}
          showIcon
          style={{ width: "100%", marginTop: 4 }}
          title={
            batchRunStatus === "paused"
              ? `Tạm dừng · ${progress.current}/${progress.total}`
              : `Campaign — ${progress.current}/${progress.total}`
          }
          description={
            <div>
              <div style={{ marginBottom: 8 }}>{progress.label}</div>
              <Progress
                percent={Math.round((progress.current / progress.total) * 100)}
                status={batchRunStatus === "paused" ? "normal" : "active"}
                size="small"
              />
              <Space wrap style={{ marginTop: 8 }}>
                {batchRunStatus === "running" ? (
                  <Button
                    size="small"
                    icon={<PauseCircleOutlined />}
                    onClick={() => batchControlRef.current.pause()}
                  >
                    Tạm dừng
                  </Button>
                ) : null}
                {batchRunStatus === "paused" ? (
                  <Button
                    size="small"
                    type="primary"
                    icon={<PlayCircleOutlined />}
                    onClick={() => batchControlRef.current.resume()}
                  >
                    Tiếp tục
                  </Button>
                ) : null}
              </Space>
            </div>
          }
        />
      ) : null}
    </div>
  );
}
