import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Form,
  Input,
  Modal,
  Space,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { FolderOpenOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { projects } from "../api";
import type { Project } from "../api/types";
import { SourceRootBar } from "../components/SourceRootBar";
import { ROUTES } from "../lib/productRoutes";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import type { ProjectScan } from "../tauri/bridge";

export default function ProjectsPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const { project: active, setProject, clearProject } = useProject();
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<Project | null>(null);
  const [rootTick, setRootTick] = useState(0);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const page = await projects.list();
      setItems(page.items);
      if (active && !page.items.some((p) => p.id === active.id)) {
        clearProject();
        message.warning("Dự án đang chọn không còn trên server — hãy chọn lại.");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [active, clearProject, message]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onCreate() {
    try {
      const values = await createForm.validateFields();
      setSaving(true);
      const created = await projects.create({
        name: values.name.trim(),
        code: values.code?.trim() || undefined,
        description: values.description?.trim() || undefined,
      });
      setProject(created.id, created.name);
      setCreateOpen(false);
      createForm.resetFields();
      message.success("Đã tạo dự án. Tiếp theo: Mở dự án → import thư mục source.");
      await load();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  function openEdit(p: Project) {
    setEditItem(p);
    editForm.setFieldsValue({
      name: p.name,
      code: p.code ?? "",
      description: p.description ?? "",
    });
  }

  async function onUpdate() {
    if (!editItem) return;
    try {
      const values = await editForm.validateFields();
      setSaving(true);
      const updated = await projects.update(editItem.id, {
        name: values.name.trim(),
        code: values.code?.trim() || undefined,
        description: values.description?.trim() || undefined,
      });
      if (active?.id === updated.id) setProject(updated.id, updated.name);
      setEditItem(null);
      message.success("Đã cập nhật project");
      await load();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  function onDelete(p: Project) {
    modal.confirm({
      title: `Xoá project "${p.name}"?`,
      content: "Requirement & test case liên quan sẽ mất.",
      okText: "Xoá",
      okType: "danger",
      cancelText: "Huỷ",
      onOk: async () => {
        await projects.remove(p.id);
        if (active?.id === p.id) clearProject();
        message.success("Đã xoá");
        await load();
      },
    });
  }

  const activeProject = useMemo(
    () => (active ? items.find((p) => p.id === active.id) ?? null : null),
    [active, items]
  );
  const activeLocalPath = useMemo(() => {
    void rootTick;
    return active ? workspace.getLocalPath(active.id) : null;
  }, [active, rootTick]);

  function onSourceRootBound(payload: {
    rootPath: string;
    syncedProject: Project | null;
    scan: ProjectScan;
  }) {
    setRootTick((n) => n + 1);
    if (payload.syncedProject) {
      setItems((prev) =>
        prev.map((p) => (p.id === payload.syncedProject!.id ? payload.syncedProject! : p))
      );
    }
  }

  function onSourceRootSynced(project: Project) {
    setItems((prev) => prev.map((p) => (p.id === project.id ? project : p)));
  }

  const columns: ColumnsType<Project> = [
    {
      title: "Tên dự án",
      dataIndex: "name",
      key: "name",
      render: (name, p) => (
        <Space>
          <span>{name}</span>
          {active?.id === p.id ? <Tag color="success">đang chọn</Tag> : null}
        </Space>
      ),
    },
    { title: "Mã dự án", dataIndex: "code", key: "code", render: (v) => v || "—" },
    {
      title: "Import / Stack",
      key: "import",
      render: (_, p) => {
        const summary = [p.language, p.framework].filter(Boolean).join(" · ") || "Chưa import";
        return (
          <Space orientation="vertical" size={0}>
            <span>{summary}</span>
            <Typography.Text type="secondary" style={{ fontSize: "0.78rem" }}>
              {workspace.getLocalPath(p.id) ? "Đã gắn source root" : "Chưa gắn source root"}
            </Typography.Text>
          </Space>
        );
      },
    },
    { title: "Yêu cầu", dataIndex: "requirementCount", key: "req", width: 100 },
    { title: "Test case", dataIndex: "testCaseCount", key: "tc", width: 100 },
    {
      title: "Hành động",
      key: "actions",
      width: 520,
      render: (_, p) => (
        <Space wrap>
          <Button size="small" type={active?.id === p.id ? "primary" : "default"} onClick={() => setProject(p.id, p.name)}>
            {active?.id === p.id ? "Đang chọn" : "Chọn"}
          </Button>
          <Button
            size="small"
            icon={<FolderOpenOutlined />}
            onClick={() => {
              setProject(p.id, p.name);
              navigate("/unit-test");
            }}
          >
            Unit test
          </Button>
          <Button
            size="small"
            onClick={() => {
              setProject(p.id, p.name);
              navigate(ROUTES.e2eTest);
            }}
          >
            E2E test
          </Button>
          <Button
            size="small"
            onClick={() => {
              setProject(p.id, p.name);
              navigate(ROUTES.requirement);
            }}
          >
            Requirement
          </Button>
          <Button size="small" onClick={() => openEdit(p)}>
            Sửa
          </Button>
          <Button size="small" danger onClick={() => onDelete(p)}>
            Xoá
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Dự án
          </Typography.Title>
          <Typography.Text type="secondary">
            Luồng chuẩn: Tạo dự án → Chọn dự án → Import source code (project root) → Unit/E2E.
          </Typography.Text>
        </div>
        <Space>
          <Button onClick={() => navigate(ROUTES.unitTest)} disabled={!active}>
            Unit test
          </Button>
          <Button onClick={() => navigate(ROUTES.e2eTest)} disabled={!active}>
            E2E test
          </Button>
          <Button type="primary" onClick={() => setCreateOpen(true)}>
            Tạo mới
          </Button>
        </Space>
      </header>

      {active ? (
        <div style={{ marginTop: 12, marginBottom: 12 }}>
          {activeProject ? (
            <SourceRootBar
              project={{ id: activeProject.id, name: activeProject.name }}
              localPath={activeLocalPath}
              onBound={onSourceRootBound}
              onSynced={onSourceRootSynced}
            />
          ) : null}
        </div>
      ) : (
        <Alert
          style={{ marginTop: 12 }}
          type="warning"
          showIcon
          message="Bước 1 · Chọn dự án"
          description="Chọn một dự án trong bảng dưới để gắn source code."
        />
      )}

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{ pageSize: 10, showSizeChanger: true }}
        locale={{ emptyText: "Chưa có dự án nào. Bấm Tạo mới để bắt đầu." }}
        rowClassName={(p) => (active?.id === p.id ? "row-active" : "")}
      />

      <Modal
        title="Tạo dự án mới"
        open={createOpen}
        onCancel={() => setCreateOpen(false)}
        onOk={onCreate}
        confirmLoading={saving}
        okText="Tạo"
        cancelText="Huỷ"
        destroyOnHidden
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Tên dự án" rules={[{ required: true, message: "Nhập tên dự án" }]}>
            <Input placeholder="My Project" />
          </Form.Item>
          <Form.Item name="code" label="Code">
            <Input placeholder="tuỳ chọn" />
          </Form.Item>
          <Form.Item name="description" label="Mô tả">
            <Input.TextArea rows={3} placeholder="tuỳ chọn" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        title="Cập nhật dự án"
        open={!!editItem}
        onCancel={() => setEditItem(null)}
        onOk={onUpdate}
        confirmLoading={saving}
        okText="Lưu"
        cancelText="Huỷ"
        destroyOnHidden
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Tên dự án" rules={[{ required: true, message: "Nhập tên dự án" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="Code">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Mô tả">
            <Input.TextArea rows={3} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
