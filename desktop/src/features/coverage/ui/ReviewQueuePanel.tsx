import { useEffect, useMemo, useState, type Key } from "react";
import { Link } from "react-router-dom";
import {
  App,
  Button,
  Form,
  Input,
  Modal,
  Select,
  Space,
  Table,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import {
  CheckOutlined,
  DeleteOutlined,
  DownloadOutlined,
  EditOutlined,
} from "@ant-design/icons";
import { requirementStudio, testcases } from "../../../api";
import type { TestCase } from "../../../api/types";
import { EnginePicker } from "../../../components/EnginePicker";
import {
  displayReviewStatus,
  isTcPendingReview,
  labelOf,
  priorityLabel,
  typeLabel,
} from "../../../i18n/labels";
import { syncApprovedTestCasesMdBestEffort } from "../../../lib/approvedTcSync";
import {
  ENGINE_TOOLTIP,
  TC_TYPE_OPTIONS,
  resolveTestEngine,
} from "../../../lib/testEngine";
import { workspace } from "../../../workspace";

type Props = {
  projectId: string;
  cases: TestCase[];
  /** Pre-filter module from URL/CTA */
  moduleFilter?: string;
  /** Pre-filter engine from URL / after generate */
  engineFilter?: "unit" | "e2e" | "all";
  /** Requirement Studio workspace — sync MD uses workspace.title as Module */
  workspaceId?: string | null;
  loading?: boolean;
  onChanged: () => void;
};

type EditForm = {
  title: string;
  module?: string;
  type?: string;
  priority?: string;
  precondition?: string;
  steps: string;
  expectedResult: string;
  testData?: string;
};

type StatusFilter = "__all__" | "pending" | "approved";
type EngineFilter = "all" | "unit" | "e2e";

const TYPE_OPTIONS = [...TC_TYPE_OPTIONS];

const PRIORITY_OPTIONS = [
  { value: "Low", label: "Thấp" },
  { value: "Medium", label: "Trung bình" },
  { value: "High", label: "Cao" },
  { value: "Critical", label: "Nghiêm trọng" },
];

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** Giữ xuống dòng trong cùng một ô Excel (không bị cắt / chỉ hiện dòng đầu). */
function cellHtml(value: string): string {
  return escapeHtml(value).replace(
    /\r\n|\n|\r/g,
    '<br style="mso-data-placement:same-cell;">'
  );
}

/**
 * Xuất .xls (HTML Excel) — mở bằng Excel/LibreOffice sẽ hiện đủ nội dung ô,
 * wrap text + xuống dòng trong cùng cell (CSV thường bị cắt khi mở Excel).
 */
function downloadCasesExcel(
  rows: TestCase[],
  filenamePrefix = "test-cases",
  requirementTitle?: string | null
) {
  const headers = [
    "ID",
    "Module",
    "Function",
    "Title",
    "Type",
    "Priority",
    "Status",
    "Precondition",
    "Steps",
    "Expected",
    "TestData",
  ];
  const colWidths = [72, 140, 160, 220, 90, 90, 90, 200, 280, 280, 180];
  const thead = headers.map((h) => `<th>${escapeHtml(h)}</th>`).join("");
  const tbody = rows
    .map((c) => {
      const vals = [
        c.testCaseId,
        requirementTitle || "",
        c.module || "",
        c.title,
        labelOf(typeLabel, c.type),
        labelOf(priorityLabel, c.priority),
        displayReviewStatus(c.reviewStatus).label,
        c.precondition || "",
        c.steps || "",
        c.expectedResult || "",
        c.testData || "",
      ];
      return `<tr>${vals.map((v) => `<td>${cellHtml(String(v))}</td>`).join("")}</tr>`;
    })
    .join("");
  const colgroup = colWidths
    .map((w) => `<col style="width:${w}px">`)
    .join("");
  const html = `<!DOCTYPE html>
<html xmlns:o="urn:schemas-microsoft-com:office:office"
      xmlns:x="urn:schemas-microsoft-com:office:excel"
      xmlns="http://www.w3.org/TR/REC-html40">
<head>
<meta charset="UTF-8">
<!--[if gte mso 9]><xml>
 <x:ExcelWorkbook><x:ExcelWorksheets><x:ExcelWorksheet>
  <x:Name>TestCases</x:Name>
  <x:WorksheetOptions><x:DisplayGridlines/></x:WorksheetOptions>
 </x:ExcelWorksheet></x:ExcelWorksheets></x:ExcelWorkbook>
</xml><![endif]-->
<style>
  table { border-collapse: collapse; table-layout: fixed; width: 100%; }
  th, td {
    border: 1px solid #999;
    padding: 6px 8px;
    vertical-align: top;
    white-space: pre-wrap;
    word-wrap: break-word;
    mso-number-format: "\\@";
  }
  th { background: #f0f0f0; font-weight: bold; }
</style>
</head>
<body>
<table>
  <colgroup>${colgroup}</colgroup>
  <thead><tr>${thead}</tr></thead>
  <tbody>${tbody}</tbody>
</table>
</body>
</html>`;

  const blob = new Blob(["\uFEFF" + html], {
    type: "application/vnd.ms-excel;charset=utf-8",
  });
  const stamp = new Date().toISOString().slice(0, 10);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${filenamePrefix}-${stamp}.xls`;
  a.click();
  URL.revokeObjectURL(a.href);
}

/**
 * F4 — Danh sách TC trên Coverage: mọi trạng thái + duyệt hàng loạt + tải Excel.
 */
export function ReviewQueuePanel({
  projectId,
  cases,
  moduleFilter,
  engineFilter: engineFilterProp,
  workspaceId,
  loading,
  onChanged,
}: Props) {
  const { message, modal } = App.useApp();
  const [selected, setSelected] = useState<Key[]>([]);
  const [busy, setBusy] = useState(false);
  const [workspaceTitle, setWorkspaceTitle] = useState<string | null>(null);
  const [moduleSel, setModuleSel] = useState<string>(moduleFilter || "__all__");
  const [statusSel, setStatusSel] = useState<StatusFilter>("__all__");
  const [engineSel, setEngineSel] = useState<EngineFilter>(
    engineFilterProp === "unit" || engineFilterProp === "e2e" ? engineFilterProp : "all"
  );
  const [editing, setEditing] = useState<TestCase | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [form] = Form.useForm<EditForm>();

  useEffect(() => {
    if (moduleFilter) setModuleSel(moduleFilter);
  }, [moduleFilter]);

  useEffect(() => {
    if (!workspaceId) {
      setWorkspaceTitle(null);
      return;
    }
    let cancelled = false;
    void requirementStudio
      .getWorkspace(workspaceId)
      .then((ws) => {
        if (!cancelled) setWorkspaceTitle((ws.title || "").trim() || null);
      })
      .catch(() => {
        if (!cancelled) setWorkspaceTitle(null);
      });
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  useEffect(() => {
    if (engineFilterProp === "unit" || engineFilterProp === "e2e") {
      setEngineSel(engineFilterProp);
    } else if (engineFilterProp === "all") {
      setEngineSel("all");
    }
  }, [engineFilterProp]);

  const pending = useMemo(
    () => cases.filter((c) => isTcPendingReview(c.reviewStatus)),
    [cases]
  );

  const modules = useMemo(() => {
    const s = new Set<string>();
    for (const c of cases) {
      s.add((c.module || "").trim() || "(Chưa gán chức năng)");
    }
    return [...s].sort((a, b) => a.localeCompare(b, "vi"));
  }, [cases]);

  const filtered = useMemo(() => {
    return cases.filter((c) => {
      if (statusSel === "pending" && !isTcPendingReview(c.reviewStatus)) return false;
      if (statusSel === "approved" && c.reviewStatus !== "Approved") return false;
      if (engineSel !== "all") {
        const eng = resolveTestEngine(c.type);
        if (engineSel === "e2e") {
          if (eng !== "e2e") return false;
        } else if (eng === "e2e") {
          return false;
        }
      }
      if (moduleSel === "__all__") return true;
      const m = (c.module || "").trim() || "(Chưa gán chức năng)";
      return m === moduleSel || m.toLowerCase() === moduleSel.toLowerCase();
    });
  }, [cases, moduleSel, statusSel, engineSel]);

  const selectedPendingIds = useMemo(
    () =>
      selected
        .map(String)
        .filter((id) => {
          const row = cases.find((c) => c.id === id);
          return row && isTcPendingReview(row.reviewStatus);
        }),
    [selected, cases]
  );

  /** Pending rows in the current table filter (engine / module / status) — for Duyệt tất cả. */
  const filteredPendingIds = useMemo(
    () => filtered.filter((c) => isTcPendingReview(c.reviewStatus)).map((c) => c.id),
    [filtered]
  );

  async function bulkApprove(ids: string[]) {
    if (ids.length === 0) return;
    setBusy(true);
    let ok = 0;
    let fail = 0;
    const approved: TestCase[] = [];
    try {
      for (const id of ids) {
        try {
          const tc = await testcases.approve(id);
          approved.push(tc);
          ok += 1;
        } catch {
          fail += 1;
        }
      }
      if (approved.length) {
        const sync = await syncApprovedTestCasesMdBestEffort({
          projectId,
          projectRoot: workspace.getLocalPath(projectId),
          cases: approved,
          requirementTitle: workspaceTitle,
        });
        if (sync.ok && sync.written.length) {
          message.success(
            sync.message ||
              `Đã duyệt và ghi ${sync.written.length} TC → .ai-test/test-cases/`
          );
        } else if (!sync.ok || sync.via === "skipped") {
          message.warning(
            sync.errors[0] ||
              sync.message ||
              "Duyệt OK nhưng chưa ghi .ai-test/test-cases — gắn project root hoặc Connect IDE"
          );
        } else if (fail === 0) {
          message.success(`Đã duyệt ${ok} test case.`);
        }
      } else if (fail === 0) {
        message.success(`Đã duyệt ${ok} test case.`);
      }
      if (fail > 0) message.warning(`Duyệt: OK ${ok}, lỗi ${fail}.`);
      setSelected([]);
      onChanged();
    } finally {
      setBusy(false);
    }
  }

  function approveAllFiltered() {
    const ids = filteredPendingIds;
    if (ids.length === 0) {
      message.info("Không có test case chờ duyệt trong bộ lọc hiện tại.");
      return;
    }
    const engineLabel =
      engineSel === "unit" ? "Unit" : engineSel === "e2e" ? "E2E" : "Unit + E2E";
    modal.confirm({
      title: `Duyệt tất cả ${ids.length} TC chờ duyệt?`,
      content: `Áp dụng cho bộ lọc hiện tại (${engineLabel}${
        moduleSel !== "__all__" ? ` · ${moduleSel}` : ""
      }). Không cần chọn từng dòng.`,
      okText: `Duyệt tất cả (${ids.length})`,
      cancelText: "Huỷ",
      onOk: () => bulkApprove(ids),
    });
  }

  function openEdit(row: TestCase) {
    setEditing(row);
    form.setFieldsValue({
      title: row.title,
      module: row.module || undefined,
      type: row.type,
      priority: row.priority,
      precondition: row.precondition || undefined,
      steps: row.steps,
      expectedResult: row.expectedResult,
      testData: row.testData || undefined,
    });
  }

  async function saveEdit() {
    if (!editing) return;
    try {
      const values = await form.validateFields();
      setEditBusy(true);
      await testcases.update(editing.id, {
        projectId: editing.projectId,
        title: values.title.trim(),
        module: values.module?.trim() || undefined,
        type: values.type,
        priority: values.priority,
        precondition: values.precondition?.trim() || undefined,
        steps: values.steps.trim(),
        expectedResult: values.expectedResult.trim(),
        testData: values.testData?.trim() || undefined,
      });
      message.success("Đã cập nhật test case.");
      setEditing(null);
      onChanged();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Không cập nhật được test case");
    } finally {
      setEditBusy(false);
    }
  }

  function confirmDelete(row: TestCase) {
    modal.confirm({
      title: "Xoá test case?",
      content: `${row.testCaseId} · ${row.title}`,
      okText: "Xoá",
      okType: "danger",
      cancelText: "Huỷ",
      onOk: async () => {
        try {
          await testcases.remove(row.id);
          message.success("Đã xoá test case.");
          setSelected((prev) => prev.filter((k) => String(k) !== row.id));
          if (editing?.id === row.id) setEditing(null);
          onChanged();
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Không xoá được test case");
          throw e;
        }
      },
    });
  }

  function handleDownload() {
    if (filtered.length === 0) {
      message.info("Không có test case để tải về.");
      return;
    }
    downloadCasesExcel(filtered, "test-cases", workspaceTitle);
    message.success(`Đã tải ${filtered.length} test case (Excel).`);
  }

  const columns: ColumnsType<TestCase> = [
    {
      title: "ID",
      dataIndex: "testCaseId",
      width: 88,
      fixed: "left",
    },
    {
      title: "Module",
      key: "requirement",
      width: 180,
      ellipsis: true,
      render: () =>
        workspaceTitle ? (
          <Tag className="tc-review-cell-tag" color="geekblue" title={workspaceTitle}>
            {workspaceTitle}
          </Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "Function",
      dataIndex: "module",
      width: 200,
      ellipsis: true,
      render: (v: string | null | undefined) =>
        v ? (
          <Tag className="tc-review-cell-tag" title={v}>
            {v}
          </Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "Tiêu đề",
      dataIndex: "title",
      ellipsis: true,
      width: 280,
    },
    {
      title: "Loại",
      dataIndex: "type",
      width: 100,
      render: (v: string) => labelOf(typeLabel, v),
    },
    {
      title: "Ưu tiên",
      dataIndex: "priority",
      width: 96,
      render: (v: string) => labelOf(priorityLabel, v),
    },
    {
      title: "Trạng thái",
      dataIndex: "reviewStatus",
      width: 110,
      render: (s: string) => {
        const { label, color } = displayReviewStatus(s);
        return (
          <Tag className="tc-review-cell-tag" color={color}>
            {label}
          </Tag>
        );
      },
    },
    {
      title: "Thao tác",
      key: "actions",
      width: 96,
      fixed: "right",
      align: "center",
      render: (_, row) => {
        return (
          <Space size={2} className="tc-review-actions" wrap={false}>
            <Tooltip title="Sửa">
              <Button
                type="text"
                size="small"
                icon={<EditOutlined />}
                aria-label="Sửa"
                onClick={() => openEdit(row)}
              />
            </Tooltip>
            <Tooltip title="Xoá">
              <Button
                type="text"
                size="small"
                danger
                icon={<DeleteOutlined />}
                aria-label="Xoá"
                onClick={() => confirmDelete(row)}
              />
            </Tooltip>
          </Space>
        );
      },
    },
  ];

  return (
    <div className="coverage-review">
      <div className="coverage-review-toolbar">
        <Typography.Text type="secondary">
          {filtered.length} TC
          {cases.length !== filtered.length ? ` (lọc / ${cases.length})` : ""}
          {pending.length > 0 ? ` · ${pending.length} chờ duyệt` : ""}
        </Typography.Text>
        <EnginePicker
          size="small"
          value={engineSel}
          onChange={(v) => setEngineSel(v as EngineFilter)}
          options={[
            { value: "all", label: "Tất cả" },
            { value: "unit", label: "Unit" },
            { value: "e2e", label: "E2E" },
          ]}
          aria-label="Lọc engine"
        />
        <select
          className="coverage-review-select"
          value={statusSel}
          onChange={(e) => setStatusSel(e.target.value as StatusFilter)}
          aria-label="Lọc trạng thái"
        >
          <option value="__all__">Tất cả trạng thái</option>
          <option value="pending">Chờ duyệt (Nháp)</option>
          <option value="approved">Đã duyệt</option>
        </select>
        <select
          className="coverage-review-select"
          value={moduleSel}
          onChange={(e) => setModuleSel(e.target.value)}
          aria-label="Lọc Function"
        >
          <option value="__all__">Tất cả Function</option>
          {modules.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        <Button
          icon={<DownloadOutlined />}
          disabled={filtered.length === 0}
          onClick={handleDownload}
        >
          Tải về
        </Button>
        <Button
          type="primary"
          disabled={selectedPendingIds.length === 0 || busy}
          loading={busy}
          icon={<CheckOutlined />}
          onClick={() => void bulkApprove(selectedPendingIds)}
        >
          Duyệt đã chọn ({selectedPendingIds.length})
        </Button>
        <Button
          disabled={filteredPendingIds.length === 0 || busy}
          loading={busy}
          icon={<CheckOutlined />}
          onClick={() => approveAllFiltered()}
        >
          Duyệt tất cả
          {engineSel === "unit"
            ? " Unit"
            : engineSel === "e2e"
              ? " E2E"
              : ""}{" "}
          ({filteredPendingIds.length})
        </Button>
        <Link to="/requirement">
          <Button type="link">Về Requirement Studio →</Button>
        </Link>
      </div>

      <div className="coverage-review-table">
        <Table
          rowKey="id"
          size="small"
          loading={loading}
          columns={columns}
          dataSource={filtered}
          rowSelection={{
            selectedRowKeys: selected,
            onChange: setSelected,
            getCheckboxProps: (row) => ({
              disabled: !isTcPendingReview(row.reviewStatus),
            }),
          }}
          scroll={{ x: 1180, y: "max(40vh, 240px)" }}
          tableLayout="fixed"
          pagination={{ pageSize: 20, showSizeChanger: true, responsive: true }}
          locale={{ emptyText: "Không có test case khớp bộ lọc." }}
        />
      </div>

      <Modal
        title={editing ? `Sửa ${editing.testCaseId}` : "Sửa test case"}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void saveEdit()}
        okText="Lưu"
        cancelText="Huỷ"
        confirmLoading={editBusy}
        destroyOnHidden
        width={640}
      >
        <Form form={form} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item label="Module">
            <Input.TextArea
              rows={1}
              value={workspaceTitle || ""}
              placeholder="Module (từ Studio — chỉ xem)"
              readOnly
              disabled
            />
          </Form.Item>
          <Form.Item name="module" label="Function">
            <Input.TextArea rows={2} placeholder="Tên Function (feature)" />
          </Form.Item>
          <Form.Item
            name="title"
            label="Tiêu đề"
            rules={[{ required: true, message: "Nhập tiêu đề" }]}
          >
            <Input.TextArea rows={2} placeholder="Tiêu đề test case" />
          </Form.Item>
          <Space wrap style={{ width: "100%" }} styles={{ item: { flex: 1, minWidth: 160 } }}>
            <Form.Item
              name="type"
              label={
                <Tooltip title={ENGINE_TOOLTIP}>
                  <span>Loại (engine)</span>
                </Tooltip>
              }
              style={{ marginBottom: 12, width: "100%" }}
            >
              <Select options={TYPE_OPTIONS} />
            </Form.Item>
            <Form.Item name="priority" label="Ưu tiên" style={{ marginBottom: 12, width: "100%" }}>
              <Select options={PRIORITY_OPTIONS} />
            </Form.Item>
          </Space>
          <Form.Item name="precondition" label="Tiền điều kiện">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Form.Item
            name="steps"
            label="Các bước"
            rules={[{ required: true, message: "Nhập các bước" }]}
          >
            <Input.TextArea rows={4} />
          </Form.Item>
          <Form.Item
            name="expectedResult"
            label="Kết quả mong đợi"
            rules={[{ required: true, message: "Nhập kết quả mong đợi" }]}
          >
            <Input.TextArea rows={3} />
          </Form.Item>
          <Form.Item name="testData" label="Test data">
            <Input.TextArea rows={2} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}
