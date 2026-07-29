import { useCallback, useEffect, useMemo, useRef, useState, type Dispatch, type ReactNode, type SetStateAction } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Collapse,
  Form,
  Input,
  Modal,
  Radio,
  Select,
  Space,
  Spin,
  Table,
  Tag,
  Typography,
} from "antd";
import type { ColumnsType } from "antd/es/table";
import { Link, useLocation, useNavigate, useSearchParams } from "react-router-dom";
import { connection, requirements, testcases } from "../api";
import { TestingJourney } from "../components/TestingJourney";
import { useTestingJourney } from "../hooks/useTestingJourney";
import { generateTcUrl } from "../lib/testingJourney";
import { activityUrl, e2eTestUrl, unitTestUrl } from "../lib/productRoutes";
import { ENGINE_TOOLTIP, TC_TYPE_OPTIONS } from "../lib/testEngine";
import type { Requirement, RequirementSource, TestCase } from "../api/types";
import RequirementDocField, {
  buildRequirementPayload,
  docInputContent,
  docInputFileLabel,
  docInputPreviewHtml,
  sourcesToDocs,
  type DocInput,
} from "../components/RequirementDocField";
import RequirementRichPreview from "../components/RequirementRichPreview";
import {
  RequirementTopicsPanel,
} from "../components/RequirementTopicsPanel";
import type { RequirementTopic } from "../api/types";
import { labelOf, priorityLabel, displayReviewStatus, isTcPendingReview, typeLabel } from "../i18n/labels";
import { useProject } from "../state/ProjectContext";

function groupBySource(cases: TestCase[]): Record<string, TestCase[]> {
  const map: Record<string, TestCase[]> = {};
  for (const tc of cases) {
    const key = tc.sourceId ?? "";
    if (!key) continue;
    (map[key] ??= []).push(tc);
  }
  return map;
}

const emptyDocs = () => ({ userStory: null as DocInput | null, srs: null as DocInput | null });

export default function RequirementsPage() {
  const { message, modal } = App.useApp();
  const navigate = useNavigate();
  const location = useLocation();
  const [searchParams] = useSearchParams();
  const reviewMode = searchParams.get("review") === "1";
  const focusModule = searchParams.get("module")?.trim() || undefined;
  const focusRequirementId =
    searchParams.get("requirementId")?.trim() ||
    (location.state as { focusRequirementId?: string } | null)?.focusRequirementId;
  const { project } = useProject();
  const [items, setItems] = useState<Requirement[]>([]);
  const [casesByReq, setCasesByReq] = useState<Record<string, TestCase[]>>({});
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [expandedKeys, setExpandedKeys] = useState<string[]>([]);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editItem, setEditItem] = useState<Requirement | null>(null);
  const [createDocs, setCreateDocs] = useState(emptyDocs());
  const [editDocs, setEditDocs] = useState(emptyDocs());
  const createDocsRef = useRef(createDocs);
  const editDocsRef = useRef(editDocs);
  createDocsRef.current = createDocs;
  editDocsRef.current = editDocs;
  /** Snapshot docs khi mở Sửa — tránh Lưu đè mất file nếu state bị trống */
  const editBaselineRef = useRef(emptyDocs());
  const editClearedDocsRef = useRef(false);
  const [editLoading, setEditLoading] = useState(false);
  const [docsBusy, setDocsBusy] = useState(false);
  const docsBusyCount = useRef(0);
  const onDocBusyChange = useCallback((busy: boolean) => {
    docsBusyCount.current += busy ? 1 : -1;
    if (docsBusyCount.current < 0) docsBusyCount.current = 0;
    setDocsBusy(docsBusyCount.current > 0);
  }, []);
  const [versionBump, setVersionBump] = useState<{
    reqId: string;
    title: string;
    version: number;
    changeSummary?: string | null;
    staleCount: number;
  } | null>(null);
  const [createForm] = Form.useForm();
  const [editForm] = Form.useForm();
  const { status: journey, refresh: refreshJourney } = useTestingJourney();

  const specHighlight =
    journey.draftCount > 0 || journey.testCaseTotal > 0 ? "review" : "spec";

  const loadCases = useCallback(async () => {
    if (!project) return;
    const items = await testcases.listAll({ projectId: project.id });
    setCasesByReq(groupBySource(items));
  }, [project]);

  useEffect(() => {
    if (focusRequirementId) {
      setExpandedKeys((keys) =>
        keys.includes(focusRequirementId) ? keys : [...keys, focusRequirementId]
      );
    }
  }, [focusRequirementId]);

  useEffect(() => {
    if (!reviewMode || items.length === 0) return;
    const withDraft = items
      .filter((r) =>
        (casesByReq[r.id] ?? []).some(
          (c) => isTcPendingReview(c.reviewStatus)
        )
      )
      .map((r) => r.id);
    if (withDraft.length) setExpandedKeys((keys) => [...new Set([...keys, ...withDraft])]);
  }, [reviewMode, items, casesByReq]);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const page = await requirements.list(project.id);
      setItems(page.items);
      await loadCases();
      void refreshJourney();
      try {
        const conn = await connection.get(project.id);
        setAiReady(conn.status === "Ready" || conn.status === "Connected");
      } catch {
        setAiReady(false);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Load failed");
    } finally {
      setLoading(false);
    }
  }, [project, message, loadCases, refreshJourney]);

  useEffect(() => {
    void load();
  }, [load]);

  function openCreate() {
    setCreateDocs(emptyDocs());
    createForm.resetFields();
    setDocsBusy(false);
    docsBusyCount.current = 0;
    setCreateOpen(true);
  }

  async function refreshReqCases(sourceId: string) {
    const page = await testcases.list({ sourceId }, 1, 200);
    setCasesByReq((prev) => ({ ...prev, [sourceId]: page.items }));
  }

  async function tcAction(
    fn: () => Promise<unknown>,
    sourceId: string,
    okMsg?: string,
    opts?: { afterApprove?: boolean }
  ) {
    try {
      await fn();
      if (okMsg) message.success(okMsg);
      await refreshReqCases(sourceId);
      void refreshJourney();
      if (opts?.afterApprove) {
        message.success({
          content: "Đã duyệt — cập nhật Requirement.",
          duration: 2,
        });
        navigate("/requirement");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Action failed");
    }
  }


  function saveRequirement(
    title: string,
    requirementText: string,
    docs: { userStory: DocInput | null; srs: DocInput | null }
  ) {
    return buildRequirementPayload(title, requirementText, docs.userStory, docs.srs);
  }

  function assertDocsInPayload(
    docs: { userStory: DocInput | null; srs: DocInput | null },
    payload: { sources: { sourceType: string }[] }
  ) {
    const fileCount = (docs.srs?.parts.length ?? 0) + (docs.userStory?.parts.length ?? 0);
    if (fileCount === 0) return;
    const saved = payload.sources.filter(
      (s) => s.sourceType === "Feature" || s.sourceType === "UserStory" || s.sourceType === "SRS"
    ).length;
    if (saved === 0) {
      throw new Error("File đã chọn chưa được đưa vào dữ liệu lưu — thử tải lại file rồi Lưu.");
    }
  }

  async function onCreate() {
    if (!project) return;
    if (docsBusy) {
      message.warning("Đang đọc file — chờ xong rồi lưu.");
      return;
    }
    try {
      const values = await createForm.validateFields();
      setSaving(true);
      const docs = createDocsRef.current;
      const payload = saveRequirement(values.title, values.requirement ?? "", docs);
      assertDocsInPayload(docs, payload);
      const fileCount = (docs.srs?.parts.length ?? 0) + (docs.userStory?.parts.length ?? 0);
      await requirements.create({ projectId: project.id, ...payload });
      setCreateOpen(false);
      createForm.resetFields();
      setCreateDocs(emptyDocs());
      message.success(
        fileCount > 0
          ? `Đã tạo requirement (${fileCount} file tài liệu).`
          : "Đã tạo requirement"
      );
      await load();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Create failed");
    } finally {
      setSaving(false);
    }
  }

  async function openEdit(r: Requirement) {
    setDocsBusy(false);
    docsBusyCount.current = 0;
    editClearedDocsRef.current = false;
    setEditLoading(true);
    try {
      const d = await requirements.get(r.id);
      const parsed = sourcesToDocs(d.sources ?? []);
      const docs = { userStory: parsed.userStory, srs: parsed.srs };
      editBaselineRef.current = docs;
      setEditDocs(docs);
      setEditItem(r);
      requestAnimationFrame(() => {
        editForm.setFieldsValue({
          title: d.title || r.title,
          requirement: parsed.requirement,
          changeSummary: "",
        });
      });
      if (
        !docs.srs?.parts.length &&
        !docs.userStory?.parts.length &&
        (r.hasSrs || (r.featureCount ?? 0) > 0)
      ) {
        message.warning("Requirement chưa có nội dung file trong hệ thống — hãy tải lại file rồi Lưu.");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Không tải được requirement");
    } finally {
      setEditLoading(false);
    }
  }

  async function onUpdate() {
    if (!editItem) return;
    if (docsBusy) {
      message.warning("Đang đọc file — chờ xong rồi lưu.");
      return;
    }
    const prevVersion = editItem.contentVersion ?? 1;
    const reqId = editItem.id;
    const reqTitle = editItem.title;
    try {
      const values = await editForm.validateFields();
      setSaving(true);
      let docs = editDocsRef.current;
      const baseline = editBaselineRef.current;
      const localEmpty = !docs.srs?.parts.length && !docs.userStory?.parts.length;
      const baselineHas =
        Boolean(baseline.srs?.parts.length) || Boolean(baseline.userStory?.parts.length);
      // Nếu state trống ngoài ý muốn (không phải user bấm Gỡ tất cả) → giữ file đã load
      if (localEmpty && baselineHas && !editClearedDocsRef.current) {
        docs = baseline;
        setEditDocs(baseline);
      }
      const payload = {
        ...saveRequirement(values.title, values.requirement ?? "", docs),
        changeSummary: values.changeSummary?.trim() || undefined,
        clearDocuments: editClearedDocsRef.current && localEmpty,
      };
      assertDocsInPayload(docs, payload);
      const updated = await requirements.update(reqId, payload);
      setEditItem(null);
      await load();
      if ((updated.contentVersion ?? 1) > prevVersion) {
        const tcPage = await testcases.list({ sourceId: reqId }, 1, 200);
        const stale = tcPage.items.filter((c) => c.needsReview ?? c.isStale).length;
        setVersionBump({
          reqId,
          title: reqTitle,
          version: updated.contentVersion ?? 1,
          changeSummary: updated.changeSummary,
          staleCount: stale,
        });
        setExpandedKeys((keys) => (keys.includes(reqId) ? keys : [...keys, reqId]));
        message.success(`Đã lưu — tài liệu lên v${updated.contentVersion}`);
      } else {
        message.success("Đã cập nhật");
      }
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Update failed");
    } finally {
      setSaving(false);
    }
  }

  function onDelete(r: Requirement) {
    const linked = casesByReq[r.id] ?? [];
    const topicCount = r.topics?.filter((t) => t.title.trim()).length ?? 0;
    modal.confirm({
      title: `Xoá requirement «${r.title}»?`,
      content: (
        <div>
          <p>
            Sẽ xoá luôn {topicCount > 0 ? <strong>{topicCount} chức năng</strong> : "các chức năng"}{" "}
            và <strong>{linked.length}</strong> test case gắn kèm. Không thể hoàn tác.
          </p>
        </div>
      ),
      okText: "Xoá",
      okType: "danger",
      cancelText: "Huỷ",
      onOk: async () => {
        try {
          const res = await requirements.remove(r.id);
          const n = res.deletedTestCases ?? linked.length;
          message.success(
            n > 0 ? `Đã xoá requirement và ${n} test case.` : "Đã xoá requirement."
          );
          await load();
          void refreshJourney();
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Xoá thất bại");
          throw e;
        }
      },
    });
  }

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2}>Yêu cầu &amp; Test Case</Typography.Title>
        <Alert type="error" showIcon title="Chưa chọn dự án. Vào tab Dự án để chọn." />
      </div>
    );
  }

  const columns: ColumnsType<Requirement> = [
    { title: "Tiêu đề", dataIndex: "title", key: "title" },
    {
      title: "Tài liệu",
      key: "docs",
      width: 160,
      render: (_, r) => (
        <Space size={4} wrap>
          {r.hasUserStory ? <Tag color="geekblue">User Story</Tag> : null}
          {r.hasSrs ? <Tag color="purple">SRS</Tag> : null}
          {!r.hasUserStory && !r.hasSrs ? (
            <Typography.Text type="secondary">Yêu cầu</Typography.Text>
          ) : null}
        </Space>
      ),
    },
    {
      title: "Chủ đề",
      key: "topics",
      width: 90,
      render: (_, r) => {
        const n = r.topics?.filter((t) => t.title.trim()).length ?? 0;
        return n > 0 ? <Tag color="cyan">{n}</Tag> : <Typography.Text type="secondary">—</Typography.Text>;
      },
    },
    {
      title: "Test case",
      key: "tcCount",
      width: 120,
      render: (_, r) => {
        const cases = casesByReq[r.id] ?? [];
        const stale = cases.filter((c) => c.isStale).length;
        return (
          <Space size={4}>
            {cases.length > 0 ? (
              <Tag color="blue">{cases.length}</Tag>
            ) : (
              <Typography.Text type="secondary">0</Typography.Text>
            )}
            {stale > 0 ? <Tag color="orange">{stale} cần review</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: "Hành động",
      key: "actions",
      width: 160,
      render: (_, r) => (
        <Space wrap>
          <Button size="small" loading={editLoading} onClick={() => openEdit(r)}>
            Sửa
          </Button>
          <Button size="small" danger onClick={() => onDelete(r)}>
            Xoá
          </Button>
        </Space>
      ),
    },
  ];

  const formModal = (
    title: string,
    open: boolean,
    onCancel: () => void,
    onOk: () => void,
    form: ReturnType<typeof Form.useForm>[0],
    docs: { userStory: DocInput | null; srs: DocInput | null },
    setDocs: Dispatch<
      SetStateAction<{ userStory: DocInput | null; srs: DocInput | null }>
    >,
    showChangeSummary = false
  ) => (
    <Modal
      title={title}
      open={open}
      onCancel={onCancel}
      onOk={onOk}
      confirmLoading={saving}
      okText={docsBusy ? "Đang đọc file…" : "Lưu"}
      cancelText="Huỷ"
      okButtonProps={{ disabled: docsBusy }}
      width={820}
      destroyOnHidden
      className="req-form-modal"
      styles={{ body: { maxHeight: "min(72vh, 640px)", overflowY: "auto", overflowX: "hidden" } }}
    >
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="title" label="Tiêu đề requirement" rules={[{ required: true, message: "Nhập tiêu đề" }]}>
          <Input placeholder="VD: Đăng nhập hệ thống" />
        </Form.Item>

        <Typography.Text type="secondary" style={{ display: "block", marginBottom: 8 }}>
          User Story & SRS là tài liệu tham chiếu. Phần <strong>Yêu cầu (Requirement)</strong> bên dưới là
          phạm vi bắt buộc để AI xác định sinh test case.
        </Typography.Text>

        <div className="req-doc-grid">
          <RequirementDocField
            label="User Story"
            hint="Kịch bản người dùng, acceptance criteria (tuỳ chọn)"
            value={docs.userStory}
            onChange={(userStory) => {
              if (showChangeSummary) {
                if (userStory == null && editBaselineRef.current.userStory) {
                  editClearedDocsRef.current = true;
                } else if (userStory?.parts.length) {
                  editClearedDocsRef.current = false;
                }
              }
              setDocs((prev) => ({ ...prev, userStory }));
            }}
            onBusyChange={onDocBusyChange}
          />
          <RequirementDocField
            label="SRS"
            hint="Mỗi file = một chức năng (module) khi sinh TC — có thể tải nhiều file"
            value={docs.srs}
            onChange={(srs) => {
              if (showChangeSummary) {
                if (srs == null && editBaselineRef.current.srs) {
                  editClearedDocsRef.current = true;
                } else if (srs?.parts.length) {
                  editClearedDocsRef.current = false;
                }
              }
              setDocs((prev) => ({ ...prev, srs }));
            }}
            onBusyChange={onDocBusyChange}
          />
        </div>

        <div className="req-requirement-block">
          <Form.Item
            name="requirement"
            label="Yêu cầu (Requirement)"
            rules={[
              { required: true, whitespace: true, message: "Nhập yêu cầu — AI dùng phần này để sinh test case" },
            ]}
            extra="Mô tả rõ phạm vi, tiêu chí chấp nhận và kịch bản cần kiểm thử."
          >
            <Input.TextArea
              rows={5}
              placeholder="VD: Hệ thống phải cho phép đăng nhập bằng email/mật khẩu; sai 5 lần khóa 15 phút; bắt buộc OTP khi đăng nhập thiết bị mới…"
            />
          </Form.Item>
        </div>

        {showChangeSummary ? (
          <Form.Item
            name="changeSummary"
            label="Tóm tắt thay đổi (tuỳ chọn)"
            extra="Nếu bỏ trống, hệ thống tự suy ra khi nội dung User Story / SRS thay đổi."
          >
            <Input.TextArea
              rows={2}
              placeholder="VD: Thêm quy tắc OTP 6 số, cập nhật SRS phần đăng nhập…"
            />
          </Form.Item>
        ) : null}
      </Form>
    </Modal>
  );

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Spec
          </Typography.Title>
          <Typography.Text type="secondary">
            Phase A — soạn requirement &amp; duyệt TC. Sinh TC chỉ qua nút «Sinh test case» (một entry).
          </Typography.Text>
        </div>
        <Space wrap>
          <Button onClick={openCreate}>Tạo requirement</Button>
          <Link to={generateTcUrl()}>
            <Button type="primary">Sinh test case</Button>
          </Link>
        </Space>
      </header>

      <TestingJourney
        status={journey}
        highlight={specHighlight}
        compact
        showNextAction={false}
      />

      {journey.reviewDone ? (
        <Card
          style={{ marginBottom: 12 }}
          size="small"
          title="Bước tiếp theo — Automate"
        >
          <Typography.Paragraph style={{ marginBottom: 12 }}>
            Có {journey.approvedCount} TC Approved. Chọn engine theo loại TC (Unit = SUT · E2E = UI +
            Target URL). Tooltip: {ENGINE_TOOLTIP}
          </Typography.Paragraph>
          <Space wrap>
            <Link to={unitTestUrl()}>
              <Button type="primary">
                {journey.hasLocalPath ? "Chạy Unit Job" : "Gắn root · Unit Job"}
              </Button>
            </Link>
            <Link to={e2eTestUrl()}>
              <Button type="primary" ghost>
                {journey.hasLocalPath ? "Chạy E2E Job" : "Gắn root · E2E Job"}
              </Button>
            </Link>
            <Link to={activityUrl({ tab: "unit-jobs" })}>
              <Button>Job Board</Button>
            </Link>
          </Space>
        </Card>
      ) : null}

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="Một điểm vào để sinh test case"
        description={
          <>
            Nút <strong>Sinh test case</strong> (header hoặc menu) — không sinh TC trùng từ form Spec.
          </>
        }
      />

      {aiReady === false ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="AI chưa Ready — vào tab Cấu hình AI để thiết lập & Xác minh trước khi sinh test case."
        />
      ) : null}

      {versionBump ? (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setVersionBump(null)}
          title={`«${versionBump.title}» đã lên phiên bản v${versionBump.version}`}
          description={
            <Space orientation="vertical" size="small" style={{ width: "100%" }}>
              {versionBump.changeSummary ? (
                <Typography.Text type="secondary">{versionBump.changeSummary}</Typography.Text>
              ) : null}
              <Typography.Text>
                {versionBump.staleCount > 0
                  ? `${versionBump.staleCount} test case cần review lại sau khi tài liệu thay đổi.`
                  : "Hãy sinh test case để bổ sung hoặc sinh lại theo tài liệu mới."}
              </Typography.Text>
              <Button
                size="small"
                type="primary"
                disabled={aiReady === false}
                onClick={() => {
                  navigate(generateTcUrl(versionBump.reqId));
                  setVersionBump(null);
                }}
              >
                Mở Sinh test case
              </Button>
            </Space>
          }
        />
      ) : null}

      {reviewMode ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Chế độ duyệt từ Requirement"
          description={
            <span>
              Đang lọc TC nháp
              {focusModule ? (
                <>
                  {" "}
                  · chức năng <Tag>{focusModule}</Tag>
                </>
              ) : null}
              . Sau Approve sẽ quay về{" "}
              <Link to="/requirement">Requirement</Link>.
            </span>
          }
        />
      ) : null}

      <Table
        rowKey="id"
        loading={loading}
        columns={columns}
        dataSource={items}
        pagination={{ pageSize: 10 }}
        expandable={{
          expandedRowKeys: expandedKeys,
          onExpandedRowsChange: (keys) => setExpandedKeys(keys as string[]),
          expandedRowRender: (r) => (
            <RequirementPanel
              req={r}
              cases={casesByReq[r.id] ?? []}
              aiReady={aiReady !== false}
              initialModuleFilter={focusModule}
              reviewOnly={reviewMode}
              onTopicsSaved={(topics) =>
                setItems((prev) =>
                  prev.map((row) => (row.id === r.id ? { ...row, topics } : row))
                )
              }
              onApprove={(id) =>
                tcAction(
                  () => testcases.approve(id),
                  r.id,
                  reviewMode ? undefined : "Đã duyệt",
                  { afterApprove: reviewMode }
                )
              }
              onDelete={(id) =>
                modal.confirm({
                  title: "Xoá test case?",
                  content: "Không thể hoàn tác.",
                  okText: "Xoá",
                  okType: "danger",
                  onOk: () =>
                    tcAction(() => testcases.remove(id), r.id, "Đã xoá test case"),
                })
              }
              onEdited={() => void refreshReqCases(r.id)}
            />
          ),
        }}
        locale={{ emptyText: "Chưa có requirement. Bấm Tạo requirement để thêm." }}
      />

      {createOpen
        ? formModal(
            "Requirement mới",
            createOpen,
            () => setCreateOpen(false),
            onCreate,
            createForm,
            createDocs,
            setCreateDocs
          )
        : null}
      {editItem
        ? formModal(
            "Cập nhật requirement",
            true,
            () => setEditItem(null),
            onUpdate,
            editForm,
            editDocs,
            setEditDocs,
            true
          )
        : null}

    </div>
  );
}

function RequirementPanel({
  req,
  cases,
  aiReady,
  initialModuleFilter,
  reviewOnly,
  onTopicsSaved,
  onApprove,
  onDelete,
  onEdited,
}: {
  req: Requirement;
  cases: TestCase[];
  aiReady: boolean;
  initialModuleFilter?: string;
  reviewOnly?: boolean;
  onTopicsSaved: (topics: RequirementTopic[]) => void;
  onApprove: (id: string) => void;
  onDelete: (id: string) => void;
  onEdited?: () => void;
}) {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const [sources, setSources] = useState<RequirementSource[]>([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState<TestCase | null>(null);
  const [editBusy, setEditBusy] = useState(false);
  const [editForm] = Form.useForm<{
    title: string;
    module?: string;
    type?: string;
    priority?: string;
    precondition?: string;
    steps: string;
    expectedResult: string;
    testData?: string;
  }>();

  useEffect(() => {
    setLoading(true);
    requirements
      .get(req.id)
      .then((d) => setSources(d.sources ?? []))
      .catch(() => setSources([]))
      .finally(() => setLoading(false));
  }, [req.id]);

  const parsed = sourcesToDocs(sources);

  const collapseItems: { key: string; label: ReactNode; children: ReactNode }[] = [];
  const pushDoc = (key: string, title: string, doc: DocInput | null) => {
    if (!doc?.parts.length) return;
    const text = docInputContent(doc);
    const fileName = docInputFileLabel(doc);
    collapseItems.push({
      key,
      label: (
        <span>
          {title}
          {fileName ? (
            <Typography.Text type="secondary" style={{ fontWeight: 400, marginLeft: 8 }}>
              ({fileName})
            </Typography.Text>
          ) : null}
        </span>
      ),
      children: (
        <RequirementRichPreview html={docInputPreviewHtml(doc)} fallbackText={text} />
      ),
    });
  };
  pushDoc("userStory", "User Story", parsed.userStory);
  pushDoc("srs", "SRS", parsed.srs);
  if (parsed.requirement.trim()) {
    collapseItems.push({
      key: "requirement",
      label: "Yêu cầu (Requirement)",
      children: <pre className="detail-block req-doc-plain">{parsed.requirement}</pre>,
    });
  }

  const defaultOpen = collapseItems.map((i) => i.key);

  const needsReview = (t: TestCase) => t.needsReview ?? t.isStale;

  const moduleLabel = (t: TestCase) => (t.module || "").trim() || "(Chưa gán module)";

  const [moduleFilter, setModuleFilter] = useState<string>(() => {
    if (!initialModuleFilter) return "__all__";
    return initialModuleFilter;
  });
  const [tcView, setTcView] = useState<"flat" | "group">("group");

  useEffect(() => {
    if (initialModuleFilter) setModuleFilter(initialModuleFilter);
  }, [initialModuleFilter]);

  const moduleOptions = useMemo(() => {
    const set = new Set<string>();
    for (const c of cases) set.add(moduleLabel(c));
    return [...set].sort((a, b) => a.localeCompare(b, "vi"));
  }, [cases]);

  const filteredCases = useMemo(() => {
    let list = cases;
    if (moduleFilter !== "__all__") {
      list = list.filter((c) => {
        const lab = moduleLabel(c);
        return (
          lab === moduleFilter ||
          lab.toLowerCase() === moduleFilter.toLowerCase()
        );
      });
    }
    if (reviewOnly) {
      list = list.filter(
        (c) => isTcPendingReview(c.reviewStatus)
      );
    }
    return list;
  }, [cases, moduleFilter, reviewOnly]);

  const groupedCases = useMemo(() => {
    const map = new Map<string, TestCase[]>();
    for (const c of filteredCases) {
      const k = moduleLabel(c);
      const arr = map.get(k) ?? [];
      arr.push(c);
      map.set(k, arr);
    }
    return [...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "vi"));
  }, [filteredCases]);

  function openEditTc(row: TestCase) {
    setEditing(row);
    editForm.setFieldsValue({
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

  async function saveEditTc() {
    if (!editing) return;
    try {
      const values = await editForm.validateFields();
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
      onEdited?.();
    } catch (e) {
      if (e && typeof e === "object" && "errorFields" in e) return;
      message.error(e instanceof Error ? e.message : "Không cập nhật được test case");
    } finally {
      setEditBusy(false);
    }
  }

  const tcColumns: ColumnsType<TestCase> = [
    { title: "ID", dataIndex: "testCaseId", key: "code", width: 90 },
    { title: "Tiêu đề", dataIndex: "title", key: "title", width: 100 },
    {
      title: "Module / chủ đề",
      dataIndex: "module",
      key: "module",
      width: 140,
      render: (v: string | null | undefined) =>
        v ? <Tag>{v}</Tag> : <Typography.Text type="secondary">—</Typography.Text>,
    },
    {
      title: "Phiên bản",
      key: "version",
      width: 90,
      render: (_, t) =>
        t.generatedFromVersion ? (
          <Tag color={needsReview(t) ? "orange" : "default"}>v{t.generatedFromVersion}</Tag>
        ) : (
          <Typography.Text type="secondary">—</Typography.Text>
        ),
    },
    {
      title: "Loại",
      dataIndex: "type",
      key: "type",
      width: 110,
      render: (v: string) => labelOf(typeLabel, v),
    },
    {
      title: "Ưu tiên",
      dataIndex: "priority",
      key: "priority",
      width: 100,
      render: (v: string) => labelOf(priorityLabel, v),
    },
    {
      title: "Trạng thái",
      dataIndex: "reviewStatus",
      key: "review",
      width: 110,
      render: (s: string, t) => {
        const { label, color } = displayReviewStatus(s);
        return (
          <Space size={4} wrap>
            <Tag color={color}>{label}</Tag>
            {needsReview(t) ? <Tag color="orange">Cần xem lại</Tag> : null}
          </Space>
        );
      },
    },
    {
      title: "Thao tác",
      key: "actions",
      width: 220,
      align: "center",
      render: (_, t) => (
        <Space wrap size="small" className="tc-review-actions">
          <Button size="small" onClick={() => openEditTc(t)}>
            Sửa
          </Button>
          {isTcPendingReview(t.reviewStatus) ? (
            <Button size="small" type="primary" onClick={() => onApprove(t.id)}>
              Duyệt
            </Button>
          ) : null}
          <Button size="small" type="link" danger onClick={() => onDelete(t.id)}>
            Xoá
          </Button>
        </Space>
      ),
    },
  ];

  const tcExpandable = {
    expandedRowRender: (t: TestCase) => (
      <div className="tc-detail">
        {t.precondition ? (
          <div>
            <Typography.Text type="secondary">Precondition</Typography.Text>
            <pre className="detail-block">{t.precondition}</pre>
          </div>
        ) : null}
        <div>
          <Typography.Text type="secondary">Steps</Typography.Text>
          <pre className="detail-block">{t.steps}</pre>
        </div>
        <div>
          <Typography.Text type="secondary">Expected result</Typography.Text>
          <pre className="detail-block">{t.expectedResult}</pre>
        </div>
      </div>
    ),
  };

  const tcTable = (data: TestCase[]) => (
    <Table
      rowKey="id"
      size="small"
      columns={tcColumns}
      dataSource={data}
      pagination={false}
      expandable={tcExpandable}
    />
  );

  return (
    <div className="req-panel">
      {loading ? (
        <Spin size="small" />
      ) : (
        <>
          {req.contentVersion && req.contentVersion > 1 ? (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              title={`Tài liệu phiên bản v${req.contentVersion} — test case sinh từ bản cũ được đánh dấu «Cần review».`}
              description={req.changeSummary ?? undefined}
            />
          ) : null}
          {collapseItems.length > 0 ? (
            <Collapse
              className="req-panel-collapse"
              defaultActiveKey={defaultOpen}
              items={collapseItems}
            />
          ) : null}
          <RequirementTopicsPanel
            requirementId={req.id}
            initialTopics={req.topics ?? []}
            onSaved={onTopicsSaved}
          />
        </>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 12, marginBottom: 8 }}>
        <Typography.Text type="secondary">
          Test cases ({cases.length}
          {moduleFilter !== "__all__" ? ` · lọc: ${moduleFilter}` : ""})
        </Typography.Text>
        <Button
          type="primary"
          ghost
          size="small"
          onClick={() => navigate(unitTestUrl({ reqId: req.id }))}
        >
          ⚡ Sinh Unit Test cho Requirement này
        </Button>
      </div>

      {cases.length > 0 ? (
        <Space wrap style={{ marginBottom: 12 }}>
          <Select
            size="small"
            style={{ minWidth: 200 }}
            value={moduleFilter}
            onChange={setModuleFilter}
            options={[
              { value: "__all__", label: "Tất cả module" },
              ...moduleOptions.map((m) => ({ value: m, label: m })),
            ]}
          />
          <Radio.Group
            size="small"
            value={tcView}
            onChange={(e) => setTcView(e.target.value as "flat" | "group")}
          >
            <Radio.Button value="group">Theo module</Radio.Button>
            <Radio.Button value="flat">Danh sách</Radio.Button>
          </Radio.Group>
        </Space>
      ) : null}

      {cases.length === 0 ? (
        <Alert
          type="info"
          showIcon
          title="Chưa có test case"
          description={
            <Space orientation="vertical" size="small">
              <span>Bước tiếp theo: sinh test case tại menu «Sinh test case», gắn sẵn requirement này.</span>
              <Button
                type="default"
                size="small"
                disabled={!aiReady}
                onClick={() => navigate(generateTcUrl(req.id))}
              >
                Sinh test case cho requirement này
              </Button>
            </Space>
          }
        />
      ) : filteredCases.length === 0 ? (
        <Alert type="info" showIcon title="Không có test case trong module đã chọn." />
      ) : tcView === "group" && groupedCases.length > 1 ? (
        <Collapse
          size="small"
          defaultActiveKey={groupedCases.map(([k]) => k)}
          items={groupedCases.map(([mod, rows]) => ({
            key: mod,
            label: (
              <span>
                {mod}{" "}
                <Tag style={{ marginLeft: 8 }}>{rows.length} TC</Tag>
              </span>
            ),
            children: tcTable(rows),
          }))}
        />
      ) : (
        tcTable(filteredCases)
      )}

      <Modal
        title={editing ? `Sửa ${editing.testCaseId}` : "Sửa test case"}
        open={!!editing}
        onCancel={() => setEditing(null)}
        onOk={() => void saveEditTc()}
        okText="Lưu"
        cancelText="Huỷ"
        confirmLoading={editBusy}
        destroyOnHidden
        width={640}
      >
        <Form form={editForm} layout="vertical" style={{ marginTop: 8 }}>
          <Form.Item
            name="title"
            label="Tiêu đề"
            rules={[{ required: true, message: "Nhập tiêu đề" }]}
          >
            <Input />
          </Form.Item>
          <Form.Item name="module" label="Module">
            <Input placeholder="Tên chức năng / module" />
          </Form.Item>
          <Form.Item name="type" label="Loại (engine)">
            <Select options={[...TC_TYPE_OPTIONS]} />
          </Form.Item>
          <Form.Item name="priority" label="Ưu tiên">
            <Select
              options={[
                { value: "Low", label: "Thấp" },
                { value: "Medium", label: "Trung bình" },
                { value: "High", label: "Cao" },
                { value: "Critical", label: "Nghiêm trọng" },
              ]}
            />
          </Form.Item>
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
