import { useEffect } from "react";
import {
  Form,
  Input,
  Modal,
  Row,
  Col,
  Select,
  Tooltip,
  Button,
} from "antd";
import {
  BookOutlined,
  CheckCircleOutlined,
  EditOutlined,
  FileTextOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import type { TestCase } from "../api/types";

export const TC_TYPE_OPTIONS = [
  { value: "unit", label: "Unit Test" },
  { value: "e2e", label: "E2E UI Test (Playwright)" },
  { value: "api", label: "API Test" },
  { value: "integration", label: "Integration Test" },
  { value: "manual", label: "Manual Test (Thủ công)" },
];

export const TC_PRIORITY_OPTIONS = [
  { value: "Low", label: "Thấp" },
  { value: "Medium", label: "Trung bình" },
  { value: "High", label: "Cao" },
  { value: "Critical", label: "Nghiêm trọng" },
];

export type TestCaseEditModalFormValues = {
  title: string;
  module?: string;
  type: string;
  priority: string;
  precondition?: string;
  steps: string;
  expectedResult: string;
  testData?: string;
};

export type TestCaseEditModalProps = {
  editing: TestCase | null;
  onCancel: () => void;
  onSave: (values: TestCaseEditModalFormValues) => Promise<void>;
  editBusy?: boolean;
  workspaceTitle?: string;
};

function renderStatusBadge(status?: string) {
  if (!status) return null;
  const s = status.toLowerCase();
  let badgeClass = "tc-badge-status-draft";
  let label = "Bản nháp";

  if (s === "approved") {
    badgeClass = "tc-badge-status-approved";
    label = "Đã duyệt";
  } else if (s === "inreview") {
    badgeClass = "tc-badge-status-review";
    label = "Đang review";
  } else if (s === "rejected") {
    badgeClass = "tc-badge-status-rejected";
    label = "Từ chối";
  }

  return <span className={`tc-badge-status ${badgeClass}`}>{label}</span>;
}

export default function TestCaseEditModal({
  editing,
  onCancel,
  onSave,
  editBusy = false,
  workspaceTitle,
}: TestCaseEditModalProps) {
  const [form] = Form.useForm<TestCaseEditModalFormValues>();

  useEffect(() => {
    if (editing) {
      form.setFieldsValue({
        title: editing.title || "",
        module: editing.module || undefined,
        type: editing.type || "unit",
        priority: editing.priority || "Medium",
        precondition: editing.precondition || undefined,
        steps: editing.steps || "",
        expectedResult: editing.expectedResult || "",
        testData: editing.testData || undefined,
      });
    } else {
      form.resetFields();
    }
  }, [editing, form]);

  const handleOk = async () => {
    try {
      const values = await form.validateFields();
      await onSave({
        title: values.title.trim(),
        module: values.module?.trim() || undefined,
        type: values.type,
        priority: values.priority,
        precondition: values.precondition?.trim() || undefined,
        steps: values.steps.trim(),
        expectedResult: values.expectedResult.trim(),
        testData: values.testData?.trim() || undefined,
      });
    } catch {
      // Handled visually by AntD Form
    }
  };

  const modalTitle = editing ? (
    <div className="tc-modal-header">
      <EditOutlined className="tc-header-icon" />
      <span className="tc-header-title-text">Sửa Test Case</span>
      <span className="tc-badge-id">{editing.testCaseId}</span>
      {renderStatusBadge(editing.reviewStatus)}
      {workspaceTitle && (
        <span className="tc-badge-req" title={workspaceTitle}>
          <BookOutlined style={{ fontSize: 11 }} />
          <span className="tc-badge-req-text">{workspaceTitle}</span>
        </span>
      )}
    </div>
  ) : (
    "Sửa test case"
  );

  return (
    <Modal
      title={modalTitle}
      open={!!editing}
      onCancel={onCancel}
      onOk={handleOk}
      confirmLoading={editBusy}
      destroyOnHidden
      width={720}
      className="tc-edit-modal"
      centered
      footer={[
        <Button key="cancel" onClick={onCancel} className="tc-btn-cancel">
          Huỷ
        </Button>,
        <Button
          key="save"
          type="primary"
          icon={<SaveOutlined />}
          loading={editBusy}
          onClick={handleOk}
          className="tc-btn-save"
        >
          Lưu thay đổi
        </Button>,
      ]}
    >
      <Form
        form={form}
        layout="vertical"
        className="tc-edit-form"
        requiredMark={false}
      >
        {/* Section 1: Thông tin chung */}
        <div className="tc-form-section-header">
          <FileTextOutlined className="tc-section-icon" />
          <span>THÔNG TIN CHUNG</span>
        </div>

        <Form.Item
          name="title"
          label={<span className="tc-label">Tiêu đề test case <span className="tc-asterisk">*</span></span>}
          rules={[{ required: true, message: "Vui lòng nhập tiêu đề test case" }]}
        >
          <Input
            placeholder="Nhập tiêu đề mô tả ngắn gọn..."
            maxLength={250}
          />
        </Form.Item>

        <Row gutter={12}>
          <Col span={8}>
            <Form.Item name="module" label={<span className="tc-label">Function / Feature</span>}>
              <Input placeholder="Ví dụ: Auth, Payment..." />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item
              name="type"
              label={
                <Tooltip title="Chỉ định engine sinh code: Unit (Vitest/Jest...), E2E (Playwright), API...">
                  <span className="tc-label">Loại Engine</span>
                </Tooltip>
              }
            >
              <Select options={TC_TYPE_OPTIONS} />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="priority" label={<span className="tc-label">Ưu tiên</span>}>
              <Select options={TC_PRIORITY_OPTIONS} />
            </Form.Item>
          </Col>
        </Row>

        {/* Section 2: Kịch bản kiểm thử */}
        <div className="tc-form-section-header" style={{ marginTop: 12 }}>
          <CheckCircleOutlined className="tc-section-icon" />
          <span>KỊCH BẢN KIỂM THỬ</span>
        </div>

        <Form.Item name="precondition" label={<span className="tc-label">Tiền điều kiện</span>}>
          <Input.TextArea
            rows={2}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="Điều kiện cần có trước khi thực hiện test..."
          />
        </Form.Item>

        <Form.Item
          name="steps"
          label={<span className="tc-label">Các bước thực hiện <span className="tc-asterisk">*</span></span>}
          rules={[{ required: true, message: "Vui lòng nhập các bước thực hiện" }]}
        >
          <Input.TextArea
            rows={4}
            autoSize={{ minRows: 3, maxRows: 6 }}
            placeholder="1. Truy cập trang...&#10;2. Nhập thông tin...&#10;3. Nhấn nút..."
          />
        </Form.Item>

        <Form.Item
          name="expectedResult"
          label={<span className="tc-label">Kết quả mong đợi <span className="tc-asterisk">*</span></span>}
          rules={[{ required: true, message: "Vui lòng nhập kết quả mong đợi" }]}
        >
          <Input.TextArea
            rows={3}
            autoSize={{ minRows: 2, maxRows: 5 }}
            placeholder="Mô tả kết quả kỳ vọng sau khi thực hiện các bước..."
          />
        </Form.Item>

        <Form.Item name="testData" label={<span className="tc-label">Test Data (Dữ liệu kiểm thử)</span>}>
          <Input.TextArea
            rows={2}
            autoSize={{ minRows: 2, maxRows: 4 }}
            placeholder="Dữ liệu mẫu (vd: username=admin, traceId=VAL-001...)"
            className="tc-code-input"
          />
        </Form.Item>
      </Form>
    </Modal>
  );
}
