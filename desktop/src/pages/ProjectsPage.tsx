import { useCallback, useEffect, useState } from "react";
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
import { IdeConnectPanel } from "../components/IdeConnectPanel";
import { bindSourceRoot } from "../lib/workspaceManager";
import { ROUTES } from "../lib/productRoutes";
import { useIdeBridgeSession } from "../lib/ideBridge/session";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import { isTauri, pickProjectFolder } from "../tauri/bridge";

/** Source-root picker — lives only inside Create / Edit modals. */
function SourcePathField({
  value,
  onChange,
  disabled,
}: {
  value?: string;
  onChange?: (v: string) => void;
  disabled?: boolean;
}) {
  const { message } = App.useApp();
  const [picking, setPicking] = useState(false);

  async function onPick() {
    if (!isTauri()) {
      message.error("Cần chạy Desktop (Tauri) để chọn thư mục trên máy.");
      return;
    }
    setPicking(true);
    try {
      const picked = await pickProjectFolder();
      if (picked) onChange?.(picked.trim());
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Không chọn được thư mục");
    } finally {
      setPicking(false);
    }
  }

  return (
    <Space.Compact style={{ width: "100%" }}>
      <Input
        value={value}
        onChange={(e) => onChange?.(e.target.value)}
        placeholder="D:\MyApp  hoặc  /Users/…/repo"
        disabled={disabled}
        allowClear
      />
      <Button
        icon={<FolderOpenOutlined />}
        loading={picking}
        disabled={disabled || !isTauri()}
        onClick={() => void onPick()}
      >
        Chọn thư mục
      </Button>
    </Space.Compact>
  );
}

export default function ProjectsPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const { project: active, setProject, clearProject } = useProject();
  const ideStatus = useIdeBridgeSession((s) => s.status);
  const ideWs = useIdeBridgeSession((s) => s.workspaceRoot);
  const [items, setItems] = useState<Project[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<Project | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const createName = Form.useWatch("name", createForm);
  const createCode = Form.useWatch("code", createForm);
  const createLocalPath = Form.useWatch("localPath", createForm);
  const editLocalPath = Form.useWatch("localPath", editForm);

  const isCreateValid = Boolean(
    createName?.trim() &&
    createCode?.trim() &&
    createLocalPath?.trim()
  );

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

  const autoConnectIfMatching = useIdeBridgeSession((s) => s.autoConnectIfMatching);
  const disconnect = useIdeBridgeSession((s) => s.disconnect);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (active?.id) {
      const localPath = workspace.getLocalPath(active.id);
      if (localPath) {
        void autoConnectIfMatching(localPath);
      } else {
        disconnect();
      }
    } else {
      disconnect();
    }
  }, [active, autoConnectIfMatching, disconnect]);

  /** Bind path from Modal save — scan stack + open workspace. */
  async function bindPathFromModal(opts: {
    projectId: string;
    projectName: string;
    localPath: string;
  }): Promise<{ ok: boolean; detail: string }> {
    const path = opts.localPath.trim();
    if (!path) return { ok: false, detail: "Chưa có path" };
    if (!isTauri()) {
      return { ok: false, detail: "Cần Desktop (Tauri) để gắn source root" };
    }
    try {
      const result = await bindSourceRoot({
        projectId: opts.projectId,
        projectName: opts.projectName,
        rootPath: path,
      });
      if (result.syncedProject) {
        setItems((prev) =>
          prev.map((p) => (p.id === result.syncedProject!.id ? result.syncedProject! : p))
        );
      }
      if (result.syncError) {
        return {
          ok: true,
          detail: `Đã gắn «${result.rootPath}» nhưng sync stack lỗi: ${result.syncError}`,
        };
      }
      if (result.openError) {
        return {
          ok: true,
          detail: `Đã gắn «${result.rootPath}»; phiên server: ${result.openError}`,
        };
      }
      return {
        ok: true,
        detail: `Đã gắn source «${result.rootPath}» · sẵn sàng Gen Unit/E2E`,
      };
    } catch (e) {
      return {
        ok: false,
        detail: e instanceof Error ? e.message : "Gắn source thất bại",
      };
    }
  }

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

      const localPath = String(values.localPath || "").trim();
      if (localPath) {
        const bind = await bindPathFromModal({
          projectId: created.id,
          projectName: created.name,
          localPath,
        });
        if (bind.ok) message.success(`Đã tạo dự án. ${bind.detail}`);
        else {
          message.warning(
            `Đã tạo dự án nhưng chưa gắn source: ${bind.detail}. Mở Sửa dự án để gắn lại.`
          );
        }
      } else {
        message.success(
          "Đã tạo dự án. Mở Sửa dự án để gắn thư mục source trước khi Gen test."
        );
      }

      setCreateOpen(false);
      createForm.resetFields();
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
  }

  // destroyOnHidden unmounts Form — fill only after Modal/Form remount.
  useEffect(() => {
    if (!editItem) {
      editForm.resetFields();
      return;
    }
    editForm.setFieldsValue({
      name: editItem.name,
      code: editItem.code ?? "",
      description: editItem.description ?? "",
      localPath: workspace.getLocalPath(editItem.id) || "",
    });
  }, [editItem, editForm]);

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

      const nextPath = String(values.localPath || "").trim();
      const prevPath = (workspace.getLocalPath(editItem.id) || "").trim();
      if (nextPath && nextPath !== prevPath) {
        const bind = await bindPathFromModal({
          projectId: updated.id,
          projectName: updated.name,
          localPath: nextPath,
        });
        if (bind.ok) message.success(`Đã cập nhật. ${bind.detail}`);
        else message.warning(`Đã lưu meta nhưng gắn source lỗi: ${bind.detail}`);
      } else if (nextPath && nextPath === prevPath) {
        // Same path — re-bind to refresh scan/index (Modal owns rescan)
        const bind = await bindPathFromModal({
          projectId: updated.id,
          projectName: updated.name,
          localPath: nextPath,
        });
        if (bind.ok) message.success(`Đã cập nhật · làm mới source. ${bind.detail}`);
        else message.success("Đã cập nhật project");
      } else if (!nextPath && prevPath) {
        message.success(
          "Đã cập nhật dự án (giữ source root cũ — chọn lại path trong form nếu muốn đổi)."
        );
      } else {
        message.success("Đã cập nhật project");
      }

      setEditItem(null);
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
        if (active?.id === p.id) {
          clearProject();
          disconnect();
        }
        message.success("Đã xoá");
        await load();
      },
    });
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
        const path = workspace.getLocalPath(p.id);
        const isActive = active?.id === p.id;
        return (
          <Space orientation="vertical" size={0}>
            <span>{summary}</span>
            <Typography.Text type="secondary" style={{ fontSize: "0.78rem" }}>
              {path ? "Đã gắn source root" : "Chưa gắn source root"}
            </Typography.Text>
            {isActive ? (
              <Typography.Text type="secondary" style={{ fontSize: "0.78rem" }}>
                IDE:{" "}
                {ideStatus === "connected"
                  ? `Connected${ideWs ? ` · ${ideWs.replace(/^.*[\\/]/, "")}` : ""}`
                  : "Chưa Connect"}
              </Typography.Text>
            ) : null}
          </Space>
        );
      },
    },
    { title: "Yêu cầu", dataIndex: "requirementCount", key: "req", width: 100 },
    { title: "Test case", dataIndex: "testCaseCount", key: "tc", width: 100 },
    {
      title: "Hành động",
      key: "actions",
      width: 320,
      render: (_, p) => (
        <Space wrap>
          <Button size="small" type={active?.id === p.id ? "primary" : "default"} onClick={() => setProject(p.id, p.name)}>
            {active?.id === p.id ? "Đang chọn" : "Chọn"}
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

      {!active ? (
        <Alert
          style={{ marginTop: 12, marginBottom: 12 }}
          type="warning"
          showIcon
          message="Bước 1 · Chọn dự án"
          description="Chọn một dự án trong bảng dưới, hoặc Tạo mới và gắn source trong Modal."
        />
      ) : null}

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
        okText="Tạo & gắn source"
        okButtonProps={{ disabled: !isCreateValid }}
        cancelText="Huỷ"
        destroyOnHidden
        width={640}
      >
        <Form form={createForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Tên dự án" rules={[{ required: true, message: "Nhập tên dự án" }]}>
            <Input placeholder="My Project" />
          </Form.Item>
          <Form.Item name="code" label="Code dự án" rules={[{ required: true, message: "Nhập code dự án" }]}>
            <Input placeholder="Ví dụ: PROJ_01" />
          </Form.Item>
          <Form.Item name="description" label="Mô tả">
            <Input.TextArea rows={2} placeholder="tuỳ chọn" />
          </Form.Item>
          <Form.Item
            name="localPath"
            label="Thư mục source (project root)"
            extra={
              isTauri()
                ? "Chọn repo trên máy trong Modal này — scan stack + mở workspace khi Tạo."
                : "Chỉ gắn được khi chạy Desktop (Tauri)."
            }
            rules={
              isTauri()
                ? [{ required: true, message: "Chọn thư mục source để Gen test" }]
                : []
            }
          >
            <SourcePathField />
          </Form.Item>
          {!isTauri() ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message="UI web không gắn được folder local — mở Desktop app."
            />
          ) : null}
          <IdeConnectPanel compact projectPath={createLocalPath} />
        </Form>
      </Modal>

      <Modal
        title="Cập nhật dự án"
        open={!!editItem}
        onCancel={() => {
          setEditItem(null);
          editForm.resetFields();
        }}
        onOk={onUpdate}
        confirmLoading={saving}
        okText="Lưu & gắn source"
        cancelText="Huỷ"
        destroyOnHidden
        afterOpenChange={(open) => {
          if (open && editItem) {
            editForm.setFieldsValue({
              name: editItem.name,
              code: editItem.code ?? "",
              description: editItem.description ?? "",
              localPath: workspace.getLocalPath(editItem.id) || "",
            });
          }
        }}
        width={640}
      >
        <Form form={editForm} layout="vertical" preserve={false}>
          <Form.Item name="name" label="Tên dự án" rules={[{ required: true, message: "Nhập tên dự án" }]}>
            <Input />
          </Form.Item>
          <Form.Item name="code" label="Code">
            <Input />
          </Form.Item>
          <Form.Item name="description" label="Mô tả">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="localPath"
            label="Thư mục source (project root)"
            extra="Đổi path hoặc giữ nguyên rồi Lưu → gắn / làm mới scan + sync language/framework."
            rules={
              isTauri()
                ? [{ required: true, message: "Chọn thư mục source để Gen test" }]
                : []
            }
          >
            <SourcePathField />
          </Form.Item>
          {editItem && (workspace.getLocalPath(editItem.id) || "").trim() ? (
            <Alert
              type="success"
              showIcon
              style={{ marginBottom: 8 }}
              message="Source root đã gắn"
              description={
                <Typography.Text code copyable style={{ fontSize: 12 }}>
                  {workspace.getLocalPath(editItem.id)}
                </Typography.Text>
              }
            />
          ) : editItem ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              message="Chưa gắn project root"
              description="Chọn thư mục ở trên rồi Lưu để scan stack và Gen Unit/E2E."
            />
          ) : null}
          <IdeConnectPanel compact projectPath={editLocalPath} />
        </Form>
      </Modal>
    </div>
  );
}
