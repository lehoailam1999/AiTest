import { useEffect, useMemo, useState, type Key } from "react";
import { useQueryClient } from "@tanstack/react-query";
import {
  App,
  Button,
  Progress,
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
import TestCaseEditModal, {
  type TestCaseEditModalFormValues,
} from "../../../components/TestCaseEditModal";
import {
  displayReviewStatus,
  isTcPendingReview,
  labelOf,
  priorityLabel,
  typeLabel,
} from "../../../i18n/labels";
import { syncApprovedTestCasesMdBestEffort } from "../../../lib/approvedTcSync";
import { approveUnitCases } from "../../../lib/unitApprove";
import { normalizeFunctionLabel } from "../../../lib/normalizeFunctionLabel";
import {
  isE2eTestCaseType,
  isUnitTestCaseType,
  resolveTestEngine,
} from "../../../lib/testEngine";
import { workspace } from "../../../workspace";
import { coverageBoardKeys } from "../model/useCoverageBoard";

const UNASSIGNED_FUNCTION = "(Chưa gán Function)";

function functionLabel(raw: string | null | undefined): string {
  const n = normalizeFunctionLabel(raw);
  return n || UNASSIGNED_FUNCTION;
}

function functionLabelsMatch(a: string, b: string): boolean {
  if (a === b) return true;
  const na = normalizeFunctionLabel(a).toLowerCase();
  const nb = normalizeFunctionLabel(b).toLowerCase();
  return Boolean(na && nb && na === nb);
}

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
  const queryClient = useQueryClient();
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
  const [approveProgress, setApproveProgress] = useState<{
    current: number;
    total: number;
    label: string;
    failed: number;
    activeId: string | null;
  } | null>(null);

  useEffect(() => {
    if (!moduleFilter) return;
    const want = functionLabel(moduleFilter);
    // URL ?module= sometimes carries Requirement title — not a Function label
    if (
      workspaceTitle &&
      (functionLabelsMatch(want, workspaceTitle) ||
        functionLabelsMatch(moduleFilter, workspaceTitle))
    ) {
      setModuleSel("__all__");
      return;
    }
    setModuleSel(want === UNASSIGNED_FUNCTION ? "__all__" : want);
  }, [moduleFilter, workspaceTitle]);

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
      s.add(functionLabel(c.module));
    }
    return [...s].sort((a, b) => a.localeCompare(b, "vi"));
  }, [cases]);

  // Drop stale Function filter when options change (e.g. after module cleared / scope shrink)
  useEffect(() => {
    if (moduleSel === "__all__") return;
    const stillThere = modules.some((m) => functionLabelsMatch(m, moduleSel));
    if (!stillThere) setModuleSel("__all__");
  }, [modules, moduleSel]);

  const filtered = useMemo(() => {
    return cases.filter((c) => {
      if (statusSel === "pending" && !isTcPendingReview(c.reviewStatus)) return false;
      if (statusSel === "approved" && c.reviewStatus !== "Approved") return false;
      if (engineSel !== "all") {
        const eng = resolveTestEngine(c.type);
        if (engineSel === "e2e") {
          if (eng !== "e2e") return false;
        } else if (engineSel === "unit") {
          // Unit filter = non-E2E (includes API / Functional → unit)
          if (eng === "e2e") return false;
        }
      }
      if (moduleSel === "__all__") return true;
      return functionLabelsMatch(functionLabel(c.module), moduleSel);
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
  const selectedIds = useMemo(() => selected.map(String), [selected]);

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
    const failReasons: string[] = [];
    const approved: TestCase[] = [];
    try {
      const requested = ids
        .map((id) => cases.find((tc) => tc.id === id))
        .filter((tc): tc is TestCase => Boolean(tc));
      const unitCases = requested.filter((tc) => isUnitTestCaseType(tc.type));
      const e2eCases = requested.filter((tc) => isE2eTestCaseType(tc.type));
      const otherCases = requested.filter(
        (tc) =>
          !isUnitTestCaseType(tc.type) && !isE2eTestCaseType(tc.type)
      );

      // Unit Approve resolves one TC at a time through the IDE and can take
      // tens of seconds each, so the bar has to advance per TC, not per batch.
      const total = requested.length;
      let done = 0;
      let failedSoFar = 0;
      setApproveProgress({
        current: 0,
        total,
        label: `Chuẩn bị duyệt ${total} test case…`,
        failed: 0,
        activeId: null,
      });

      const unitResults = await approveUnitCases({
        projectId,
        projectRoot: workspace.getLocalPath(projectId) || "",
        cases: unitCases,
        requirementTitle: workspaceTitle,
        onProgress: (event) => {
          if (event.phase === "start") {
            setApproveProgress({
              current: done,
              total,
              label: `Đang duyệt ${event.tc.testCaseId} · ${event.tc.title}`,
              failed: failedSoFar,
              activeId: event.tc.id,
            });
            return;
          }
          done += 1;
          const settled = event.result;
          if (settled && !settled.ok) failedSoFar += 1;
          setApproveProgress({
            current: done,
            total,
            label:
              settled && !settled.ok
                ? `Lỗi ${event.tc.testCaseId} — ${settled.error}`
                : `Đã duyệt ${event.tc.testCaseId}`,
            failed: failedSoFar,
            activeId: null,
          });
        },
      });
      for (const result of unitResults) {
        if (result.ok) {
          approved.push(result.tc);
          ok += 1;
        } else {
          fail += 1;
          failReasons.push(result.error);
        }
      }

      const APPROVE_CONCURRENCY = 6;
      const legacyCases = [...e2eCases, ...otherCases];
      for (let i = 0; i < legacyCases.length; i += APPROVE_CONCURRENCY) {
        const chunk = legacyCases.slice(i, i + APPROVE_CONCURRENCY);
        const hits = await Promise.all(
          chunk.map(async (tc) => {
            try {
              return { ok: true as const, tc: await testcases.approve(tc.id) };
            } catch (e) {
              return {
                ok: false as const,
                reason: e instanceof Error ? e.message : String(e),
              };
            }
          })
        );
        for (const h of hits) {
          if (h.ok) {
            approved.push(h.tc);
            ok += 1;
          } else {
            fail += 1;
            failedSoFar += 1;
            if (h.reason) failReasons.push(h.reason);
          }
        }
        done += chunk.length;
        setApproveProgress({
          current: done,
          total,
          label: `Đã duyệt ${done}/${total} test case`,
          failed: failedSoFar,
          activeId: null,
        });
      }
      // Update cache in-memory immediately so UI updates without full API reload
      setSelected([]);
      if (approved.length > 0) {
        queryClient.setQueryData<TestCase[]>(
          coverageBoardKeys.cases(projectId),
          (old) => {
            if (!old) return approved;
            const approvedMap = new Map(approved.map((c) => [c.id, c]));
            return old.map((c) => approvedMap.get(c.id) ?? c);
          }
        );
      }
      const approvedE2e = approved.filter((tc) =>
        isE2eTestCaseType(tc.type)
      );
      if (approvedE2e.length) {
        const sync = await syncApprovedTestCasesMdBestEffort({
          projectId,
          projectRoot: workspace.getLocalPath(projectId),
          cases: approvedE2e,
          requirementTitle: workspaceTitle,
        });
        if (sync.ok && sync.written.length) {
          message.success(
            sync.message ||
              `Đã duyệt và ghi ${sync.written.length} TC → AItest/test-cases/`
          );
        } else if (!sync.ok || sync.via === "skipped") {
          message.warning(
            sync.errors[0] ||
              sync.message ||
              "Duyệt OK nhưng chưa ghi AItest/test-cases — gắn project root hoặc Connect IDE"
          );
        } else if (fail === 0) {
          message.success(`Đã duyệt ${ok} test case.`);
        }
      } else if (fail === 0) {
        message.success(`Đã duyệt ${ok} test case.`);
      }
      if (fail > 0) message.warning(`Duyệt: OK ${ok}, lỗi ${fail}.`);
      if (failReasons.length > 0) {
        const first = Array.from(new Set(failReasons)).slice(0, 3).join(" | ");
        message.error(`Lý do từ chối: ${first}`);
      }
      await queryClient.invalidateQueries({
        queryKey: coverageBoardKeys.all,
        // Approve sync may enrich testData/status/automationReady after the
        // immediate approve response; refresh active views from that DB state.
        refetchType: "active",
      });
    } finally {
      setApproveProgress(null);
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
  }

  async function saveEdit(values: TestCaseEditModalFormValues) {
    if (!editing) return;
    try {
      setEditBusy(true);
      const updated = await testcases.update(editing.id, {
        projectId: editing.projectId,
        ...values,
      });
      message.success("Đã cập nhật test case.");
      setEditing(null);
      queryClient.setQueryData<TestCase[]>(
        coverageBoardKeys.cases(projectId),
        (old) => (old ? old.map((item) => (item.id === editing.id ? { ...item, ...updated } : item)) : [])
      );
      void queryClient.invalidateQueries({
        queryKey: coverageBoardKeys.all,
        refetchType: "none",
      });
    } catch (e) {
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
          queryClient.setQueryData<TestCase[]>(
            coverageBoardKeys.cases(projectId),
            (old) => (old ? old.filter((item) => item.id !== row.id) : [])
          );
          void queryClient.invalidateQueries({
            queryKey: coverageBoardKeys.all,
            refetchType: "none",
          });
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Không xoá được test case");
          throw e;
        }
      },
    });
  }

  function confirmDeleteSelected() {
    if (selectedIds.length === 0) {
      message.info("Chưa chọn test case để xoá.");
      return;
    }
    const selectedRows = selectedIds
      .map((id) => cases.find((item) => item.id === id))
      .filter((item): item is TestCase => Boolean(item));
    const preview = selectedRows
      .slice(0, 3)
      .map((item) => `${item.testCaseId} · ${item.title}`)
      .join(" | ");
    modal.confirm({
      title: `Xoá ${selectedRows.length} test case đã chọn?`,
      content:
        selectedRows.length > 0
          ? `${preview}${selectedRows.length > 3 ? " ..." : ""}`
          : "Không thể hoàn tác.",
      okText: `Xoá (${selectedRows.length})`,
      okType: "danger",
      cancelText: "Huỷ",
      onOk: async () => {
        try {
          setBusy(true);
          const settled = await Promise.all(
            selectedRows.map(async (row) => {
              try {
                await testcases.remove(row.id);
                return { ok: true as const, id: row.id };
              } catch (error) {
                return {
                  ok: false as const,
                  id: row.id,
                  error: error instanceof Error ? error.message : String(error),
                };
              }
            })
          );
          const deletedIds = settled.filter((item) => item.ok).map((item) => item.id);
          const failed = settled.filter((item) => !item.ok);
          if (deletedIds.length > 0) {
            message.success(`Đã xoá ${deletedIds.length} test case.`);
            setSelected((prev) => prev.filter((key) => !deletedIds.includes(String(key))));
            if (editing && deletedIds.includes(editing.id)) setEditing(null);
            queryClient.setQueryData<TestCase[]>(
              coverageBoardKeys.cases(projectId),
              (old) => (old ? old.filter((item) => !deletedIds.includes(item.id)) : [])
            );
            void queryClient.invalidateQueries({
              queryKey: coverageBoardKeys.all,
              refetchType: "none",
            });
          }
          if (failed.length > 0) {
            const reason = Array.from(new Set(failed.map((item) => item.error))).join(" | ");
            message.error(
              `Không xoá được ${failed.length} test case${reason ? `: ${reason}` : ""}`
            );
            throw new Error(reason || "Bulk delete test cases failed");
          }
        } finally {
          setBusy(false);
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
        <div className="coverage-review-toolbar__filters">
          <div className="coverage-review-stat-badge">
            <span className="coverage-review-stat-badge__total">{filtered.length} TC</span>
            {cases.length !== filtered.length && (
              <span className="coverage-review-stat-badge__filtered">(lọc / {cases.length})</span>
            )}
            {pending.length > 0 && (
              <>
                <span className="coverage-review-stat-badge__dot">•</span>
                <span className="coverage-review-stat-badge__pending">{pending.length} chờ duyệt</span>
              </>
            )}
          </div>

          <Space size={8} wrap className="coverage-review-controls">
            <Select
              className="coverage-review-select-antd"
              value={engineSel}
              onChange={(v) => setEngineSel(v as EngineFilter)}
              aria-label="Lọc engine"
              options={[
                { value: "all", label: "Tất cả loại" },
                { value: "unit", label: "Unit" },
                { value: "e2e", label: "E2E" },
              ]}
              style={{ minWidth: 130 }}
            />
            <Select
              className="coverage-review-select-antd"
              value={statusSel}
              onChange={(v) => setStatusSel(v as StatusFilter)}
              aria-label="Lọc trạng thái"
              options={[
                { value: "__all__", label: "Tất cả trạng thái" },
                { value: "pending", label: "Chờ duyệt (Nháp)" },
                { value: "approved", label: "Đã duyệt" },
              ]}
              style={{ minWidth: 160 }}
            />
            <Select
              className="coverage-review-select-antd"
              value={moduleSel}
              onChange={(v) => setModuleSel(v)}
              aria-label="Lọc Function"
              options={[
                { value: "__all__", label: "Tất cả Function" },
                ...modules.map((m) => ({ value: m, label: m })),
              ]}
              style={{ minWidth: 170 }}
            />
          </Space>
        </div>

        <div className="coverage-review-toolbar__actions">
          <Space size={8} wrap>
            <Button
              icon={<DownloadOutlined />}
              disabled={filtered.length === 0}
              onClick={handleDownload}
            >
              Tải về
            </Button>
            <Button
              danger
              disabled={selectedIds.length === 0 || busy}
              loading={busy}
              icon={<DeleteOutlined />}
              onClick={() => confirmDeleteSelected()}
            >
              Xoá đã chọn ({selectedIds.length})
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
          </Space>
        </div>
      </div>

      {approveProgress ? (
        <div className="coverage-review-progress">
          <Progress
            percent={
              approveProgress.total
                ? Math.round((approveProgress.current / approveProgress.total) * 100)
                : 0
            }
            status="active"
            format={() => `${approveProgress.current}/${approveProgress.total}`}
          />
          <Typography.Text type="secondary" ellipsis>
            {approveProgress.label}
            {approveProgress.failed > 0 ? ` · lỗi ${approveProgress.failed}` : ""}
          </Typography.Text>
        </div>
      ) : null}

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
          rowClassName={(row) =>
            approveProgress?.activeId === row.id
              ? "coverage-review-row--approving"
              : ""
          }
          scroll={{ x: 1180, y: "max(40vh, 240px)" }}
          tableLayout="fixed"
          pagination={{ pageSize: 20, showSizeChanger: true, responsive: true }}
          locale={{ emptyText: "Không có test case khớp bộ lọc." }}
        />
      </div>

      <TestCaseEditModal
        editing={editing}
        onCancel={() => setEditing(null)}
        onSave={saveEdit}
        editBusy={editBusy}
        workspaceTitle={workspaceTitle || undefined}
      />
    </div>
  );
}
