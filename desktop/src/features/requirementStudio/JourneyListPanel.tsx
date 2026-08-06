/**
 * Hub tổng thể — danh sách Requirement (workspace).
 * Mỗi Requirement = tài liệu + phân tích + TC sinh từ Snapshot của Requirement đó.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Empty,
  Input,
  Modal,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import { DeleteOutlined, PlusOutlined, ReloadOutlined } from "@ant-design/icons";
import type { ColumnsType } from "antd/es/table";
import { requirementStudio } from "../../api";
import type { RequirementStudioWorkspace } from "../../api/types";
import { useProject } from "../../state/ProjectContext";

type Props = {
  onOpenJourney: (workspaceId: string) => void;
  onOpenReview?: (workspaceId: string) => void;
};

function knowledgeTag(status?: string) {
  if (status === "ready") return <Tag color="success">Phân tích sẵn sàng</Tag>;
  if (status === "stale") return <Tag color="warning">Cần phân tích lại</Tag>;
  if (status === "building" || status === "updating")
    return <Tag color="processing">Đang dựng</Tag>;
  return <Tag>Chưa phân tích</Tag>;
}

export default function JourneyListPanel({ onOpenJourney, onOpenReview }: Props) {
  const { message } = App.useApp();
  const { project } = useProject();
  const [items, setItems] = useState<RequirementStudioWorkspace[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [creating, setCreating] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    setError(null);
    try {
      const res = await requirementStudio.listWorkspaces(project.id);
      setItems(res.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setItems([]);
    } finally {
      setLoading(false);
    }
  }, [project]);

  useEffect(() => {
    void reload();
  }, [reload]);

  const totals = useMemo(() => {
    return items.reduce(
      (acc, j) => {
        acc.journeys += 1;
        acc.files += j.fileCount ?? 0;
        acc.tc += j.tcTotal ?? 0;
        acc.pending += j.tcPending ?? 0;
        acc.approved += j.tcApproved ?? 0;
        return acc;
      },
      { journeys: 0, files: 0, tc: 0, pending: 0, approved: 0 }
    );
  }, [items]);

  const createJourney = async () => {
    if (!project) return;
    setCreating(true);
    try {
      const ws = await requirementStudio.createWorkspace(
        project.id,
        title.trim() || undefined
      );
      message.success(`Đã tạo Requirement «${ws.title}»`);
      setCreateOpen(false);
      setTitle("");
      await reload();
      onOpenJourney(ws.id);
    } catch (e) {
      message.error(e instanceof Error ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  const confirmDelete = (row: RequirementStudioWorkspace) => {
    Modal.confirm({
      title: `Xóa Requirement «${row.title}»?`,
      content:
        "Sẽ xóa vĩnh viễn khỏi DB: tài liệu, phân tích, snapshot, chat và toàn bộ test case liên quan. Không hoàn tác được.",
      okText: "Xóa",
      okType: "danger",
      cancelText: "Huỷ",
      onOk: async () => {
        setDeletingId(row.id);
        try {
          const res = await requirementStudio.deleteWorkspace(row.id);
          message.success(
            `Đã xóa Requirement · ${res.deletedTestCases} TC · ${res.deletedFiles} file`
          );
          await reload();
        } catch (e) {
          message.error(e instanceof Error ? e.message : String(e));
          throw e;
        } finally {
          setDeletingId(null);
        }
      },
    });
  };

  const columns: ColumnsType<RequirementStudioWorkspace> = [
    {
      title: "Requirement",
      dataIndex: "title",
      key: "title",
      render: (t: string, row) => (
        <Space orientation="vertical" size={0}>
          <Typography.Text strong>{t}</Typography.Text>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {row.fileCount ?? 0} file
            {row.knowledgeVersion ? ` · Phân tích v${row.knowledgeVersion}` : ""}
          </Typography.Text>
        </Space>
      ),
    },
    {
      title: "Trạng thái",
      key: "status",
      width: 160,
      render: (_, row) => knowledgeTag(row.knowledgeStatus),
    },
    {
      title: "Snapshot",
      dataIndex: "snapshotCount",
      width: 100,
      render: (n?: number) => n ?? 0,
    },
    {
      title: "Test case",
      key: "tc",
      width: 180,
      render: (_, row) => (
        <Typography.Text>
          {row.tcTotal ?? 0} tổng
          {(row.tcPending ?? 0) > 0 ? (
            <Typography.Text type="warning"> · {row.tcPending} chờ duyệt</Typography.Text>
          ) : null}
          {(row.tcApproved ?? 0) > 0 ? (
            <Typography.Text type="success"> · {row.tcApproved} OK</Typography.Text>
          ) : null}
        </Typography.Text>
      ),
    },
    {
      title: "",
      key: "actions",
      width: 280,
      render: (_, row) => (
        <Space wrap>
          <Button type="primary" size="small" onClick={() => onOpenJourney(row.id)}>
            Mở
          </Button>
          {(row.tcPending ?? 0) > 0 && onOpenReview ? (
            <Button size="small" onClick={() => onOpenReview(row.id)}>
              Duyệt test case
            </Button>
          ) : null}
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            loading={deletingId === row.id}
            onClick={() => confirmDelete(row)}
          >
            Xóa
          </Button>
        </Space>
      ),
    },
  ];

  if (!project) {
    return <Alert type="info" showIcon title="Chọn project để xem Requirement" />;
  }

  return (
    <div className="journey-hub">
      <div className="studio-toolbar">
        <div className="studio-toolbar-main">
          <Typography.Text type="secondary" className="studio-lead">
            Mỗi Requirement = tài liệu + phân tích → TC. Muốn viết TC cho phần khác —
            tạo Requirement mới.
          </Typography.Text>
        </div>
        <Space wrap>
          <Button icon={<ReloadOutlined />} onClick={() => void reload()} loading={loading}>
            Tải lại
          </Button>
          <Button
            type="primary"
            icon={<PlusOutlined />}
            onClick={() => setCreateOpen(true)}
          >
            Requirement mới
          </Button>
        </Space>
      </div>

      <div className="coverage-stats" aria-label="Tóm tắt tổng thể">
        <div className="coverage-stat">
          <span className="coverage-stat-label">Requirement</span>
          <span className="coverage-stat-value">{totals.journeys}</span>
          <span className="coverage-stat-hint">đang quản lý</span>
        </div>
        <div className="coverage-stat">
          <span className="coverage-stat-label">Tài liệu</span>
          <span className="coverage-stat-value">{totals.files}</span>
          <span className="coverage-stat-hint">file upload</span>
        </div>
        <div className="coverage-stat">
          <span className="coverage-stat-label">Test case</span>
          <span className="coverage-stat-value">{totals.tc}</span>
          <span className="coverage-stat-hint">từ Snapshot</span>
        </div>
        <div
          className={`coverage-stat${totals.pending > 0 ? " coverage-stat--gap" : " coverage-stat--ok"}`}
        >
          <span className="coverage-stat-label">Chờ duyệt</span>
          <span className="coverage-stat-value">{totals.pending}</span>
          <span className="coverage-stat-hint">{totals.approved} đã duyệt</span>
        </div>
      </div>

      {error ? (
        <Alert type="error" showIcon title={error} style={{ marginBottom: 12 }} />
      ) : null}

      <Spin spinning={loading}>
        {items.length === 0 && !loading ? (
          <Empty
            className="journey-hub-empty"
            image={Empty.PRESENTED_IMAGE_SIMPLE}
            description="Chưa có Requirement — tạo một cái để upload tài liệu và sinh TC"
          >
            <Button type="primary" icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>
              Tạo Requirement đầu tiên
            </Button>
          </Empty>
        ) : (
          <div className="journey-hub-table">
            <Table
              rowKey="id"
              columns={columns}
              dataSource={items}
              pagination={false}
              size="middle"
            />
          </div>
        )}
      </Spin>

      <Modal
        title="Tạo Requirement mới"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={() => void createJourney()}
        confirmLoading={creating}
        okText="Tạo & mở"
        cancelText="Huỷ"
      >
        <Typography.Paragraph type="secondary" style={{ marginBottom: 8 }}>
          Ví dụ: «Auth API», «Todo CRUD», «Payment» — mỗi phần nghiệp vụ một Requirement.
        </Typography.Paragraph>
        <Input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Tên Requirement"
          maxLength={300}
          onPressEnter={() => void createJourney()}
        />
      </Modal>
    </div>
  );
}
