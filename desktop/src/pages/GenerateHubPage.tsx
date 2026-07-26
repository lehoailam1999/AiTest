import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Descriptions,
  Progress,
  Radio,
  Select,
  Space,
  Steps,
  Typography,
} from "antd";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import {
  CheckCircleOutlined,
  LoadingOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useTestingJourney } from "../hooks/useTestingJourney";
import { connection, jobs, projects, requirements, testcases } from "../api";
import type { Requirement, RequirementTopic } from "../api/types";
import { topicScopeForJob } from "../components/RequirementTopicsPanel";
import { TcGenerateModeField } from "../components/TcGenerateModeField";
import { buildTcJobContextPacket } from "../lib/buildTcJobContext";
import {
  createBatchRunControl,
  type BatchRunStatus,
} from "../lib/batchRunControl";
import { normalizeFunctionLabel } from "../lib/normalizeFunctionLabel";
import { workspaceUrl } from "../lib/testingJourney";
import { SCOPE_HINTS, SCOPE_LABELS, parseHubSearchParams, type ScopeLevel } from "../lib/testScope";
import { resolveTopicsForSystemFanOut } from "../lib/resolveTcFanOut";
import { tcGenerateModeSummary, type TcGenerateMode } from "../lib/tcGenerateMode";
import { waitForJob } from "../lib/waitForJob";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import { requirementUrl, ROUTES } from "../lib/productRoutes";

/** Bước sinh test case (Design). Sau Approved → Unit test (Connect IDE). */
export default function GenerateHubPage() {
  const { message } = App.useApp();
  const { project } = useProject();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const initial = useMemo(() => parseHubSearchParams(searchParams), [searchParams]);
  const { refresh: refreshJourney } = useTestingJourney();

  const [step, setStep] = useState(initial.requirementId ? 0 : 0);
  const [scopeLevel, setScopeLevel] = useState<ScopeLevel>(initial.scope);
  const [reqList, setReqList] = useState<Requirement[]>([]);
  const [requirementId, setRequirementId] = useState<string | undefined>(initial.requirementId);
  const [topicId, setTopicId] = useState<string | undefined>();
  const [tcMode, setTcMode] = useState<TcGenerateMode>("append");
  const [useSourceContext, setUseSourceContext] = useState(false);
  const [aiReady, setAiReady] = useState<boolean | null>(null);
  const [running, setRunning] = useState(false);
  const [loading, setLoading] = useState(false);
  type GenQueueItem = { title: string; status: "pending" | "running" | "done" | "error" };
  const [genQueue, setGenQueue] = useState<GenQueueItem[] | null>(null);
  const [planTitles, setPlanTitles] = useState<string[]>([]);
  const [planLoading, setPlanLoading] = useState(false);
  const [batchRunStatus, setBatchRunStatus] = useState<BatchRunStatus>("idle");
  const [lastGenCount, setLastGenCount] = useState<number | null>(null);
  const batchControlRef = useRef(createBatchRunControl());

  useEffect(() => {
    return batchControlRef.current.subscribe(setBatchRunStatus);
  }, []);

  useEffect(() => {
    if (initial.phase === 2) {
      navigate(
        workspaceUrl({
          artifact: initial.kind === "api" ? "api" : "unit",
          mode: initial.module ? "module" : initial.testCaseId ? "single" : undefined,
          module: initial.module,
          testCaseId: initial.testCaseId,
        }),
        { replace: true }
      );
    }
  }, [initial, navigate]);

  const selectedReq = reqList.find((r) => r.id === requirementId);
  const [topics, setTopics] = useState<RequirementTopic[]>([]);
  const selectedTopic: RequirementTopic | null =
    topicId && topics.length ? topics.find((t) => t.id === topicId) ?? null : null;

  useEffect(() => {
    if (!requirementId) {
      setTopics([]);
      return;
    }
    let cancelled = false;
    void requirements
      .getTopics(requirementId)
      .then(({ topics: t }) => {
        if (cancelled) return;
        const list = t.filter((x) => x.title.trim());
        setTopics(list);
        if (initial.module) {
          const want = normalizeFunctionLabel(initial.module).toLowerCase();
          const match = list.find(
            (x) => normalizeFunctionLabel(x.title).toLowerCase() === want
          );
          if (match) setTopicId(match.id);
        }
      })
      .catch(() => {
        if (!cancelled) setTopics((selectedReq?.topics ?? []).filter((t) => t.title.trim()));
      });
    return () => {
      cancelled = true;
    };
  }, [requirementId, initial.module, selectedReq?.topics]);

  const load = useCallback(async () => {
    if (!project) return;
    setLoading(true);
    try {
      const reqPage = await requirements.list(project.id);
      setReqList(reqPage.items);
      if (!requirementId && reqPage.items.length > 0) {
        setRequirementId(initial.requirementId ?? reqPage.items[0].id);
      }
      try {
        const conn = await connection.get(project.id);
        setAiReady(conn.status === "Ready" || conn.status === "Connected");
      } catch {
        setAiReady(false);
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Tải thất bại");
    } finally {
      setLoading(false);
    }
  }, [project, message, requirementId, initial.requirementId]);

  useEffect(() => {
    if (initial.requirementId) {
      setRequirementId(initial.requirementId);
      setStep(0);
    }
    if (initial.scope === "module") {
      setScopeLevel("module");
    }
  }, [initial.requirementId, initial.scope]);

  useEffect(() => {
    void load();
  }, [load]);

  /** Danh sách chức năng sẽ chạy — hiển thị ở bước xác nhận */
  useEffect(() => {
    if (step !== 1 || !requirementId) {
      setPlanTitles([]);
      return;
    }
    let cancelled = false;
    setPlanLoading(true);
    void (async () => {
      try {
        if (scopeLevel === "module") {
          const title = selectedTopic?.title?.trim();
          if (!cancelled) setPlanTitles(title ? [title] : []);
          return;
        }
        if (scopeLevel === "system") {
          const candidates = await resolveTopicsForSystemFanOut(requirementId);
          if (cancelled) return;
          if (candidates.length > 1) {
            setPlanTitles(candidates.map((t) => t.title));
          } else {
            setPlanTitles([selectedReq?.title?.trim() || "Requirement"]);
          }
          return;
        }
        if (!cancelled) setPlanTitles(["Một test case"]);
      } catch {
        if (!cancelled) setPlanTitles([]);
      } finally {
        if (!cancelled) setPlanLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [step, requirementId, scopeLevel, selectedTopic?.title, selectedReq?.title]);

  async function runTcJob() {
    if (!project || !requirementId || !selectedReq) {
      message.error("Chọn requirement.");
      return;
    }
    if (aiReady === false) {
      message.error("AI chưa Ready — vào Cấu hình AI.");
      return;
    }
    if (scopeLevel === "module" && topics.length > 0 && !selectedTopic) {
      message.error("Chọn chủ đề (module).");
      return;
    }
    setRunning(true);
    const control = batchControlRef.current;
    control.start();
    try {
      let contextPacket: Record<string, unknown> | undefined;
      const localPath = workspace.getLocalPath(project.id);
      if (useSourceContext && localPath) {
        try {
          const p = await projects.get(project.id);
          const packet = await buildTcJobContextPacket({
            projectRoot: localPath,
            projectId: project.id,
            language: p.language,
            framework: p.framework,
          });
          if (packet?.files.length) {
            contextPacket = packet as unknown as Record<string, unknown>;
          }
        } catch {
          /* optional */
        }
      }
      const topicScope =
        scopeLevel === "module" && selectedTopic
          ? (topicScopeForJob(selectedTopic) as unknown as Record<string, unknown>)
          : undefined;

      // Toàn hệ thống + nhiều chức năng → 1 job / chức năng (tránh LLM chỉ cover 1 module)
      let fanOutTopics: RequirementTopic[] | null = null;
      if (scopeLevel === "system") {
        const candidates = await resolveTopicsForSystemFanOut(requirementId);
        if (candidates.length > 1) {
          fanOutTopics = candidates;
        } else if ((selectedReq.featureCount ?? 0) > 1) {
          message.warning(
            "Chỉ thấy một chức năng trong dữ liệu đã lưu — kiểm tra đã Lưu đủ 5 file SRS chưa."
          );
        }
      }

      const queueTitles =
        fanOutTopics?.map((t) => t.title) ??
        (scopeLevel === "module" && selectedTopic
          ? [selectedTopic.title]
          : [selectedReq.title || "Requirement"]);
      setGenQueue(queueTitles.map((title) => ({ title, status: "pending" as const })));

      let totalCount = 0;
      if (fanOutTopics) {
        for (let i = 0; i < fanOutTopics.length; i++) {
          await control.waitIfPaused();
          const t = fanOutTopics[i];
          setGenQueue((prev) =>
            prev?.map((row, idx) => ({
              ...row,
              status:
                idx < i ? "done" : idx === i ? "running" : row.status === "error" ? "error" : "pending",
            })) ?? null
          );
          const job = await jobs.create({
            projectId: project.id,
            sourceId: requirementId,
            mode: i === 0 ? tcMode : "append",
            useSourceContext,
            contextPacket,
            topicScope: topicScopeForJob(t) as unknown as Record<string, unknown>,
          });
          const done = await waitForJob(job.id);
          if (done.status === "Failed") {
            setGenQueue((prev) =>
              prev?.map((row, idx) => (idx === i ? { ...row, status: "error" } : row)) ?? null
            );
            throw new Error(done.error ?? `Sinh TC thất bại: ${t.title}`);
          }
          totalCount += (await testcases.list({ jobId: job.id }, 1, 200)).items.length;
          setGenQueue((prev) =>
            prev?.map((row, idx) => (idx === i ? { ...row, status: "done" } : row)) ?? null
          );
        }
      } else {
        setGenQueue((prev) =>
          prev?.map((row, idx) => (idx === 0 ? { ...row, status: "running" } : row)) ?? null
        );
        const job = await jobs.create({
          projectId: project.id,
          sourceId: requirementId,
          mode: tcMode,
          useSourceContext,
          contextPacket,
          topicScope,
        });
        const done = await waitForJob(job.id);
        if (done.status === "Failed") {
          setGenQueue((prev) =>
            prev?.map((row, idx) => (idx === 0 ? { ...row, status: "error" } : row)) ?? null
          );
          throw new Error(done.error ?? "Sinh TC thất bại");
        }
        totalCount = (await testcases.list({ jobId: job.id }, 1, 200)).items.length;
        setGenQueue((prev) =>
          prev?.map((row, idx) => (idx === 0 ? { ...row, status: "done" } : row)) ?? null
        );
      }

      message.success({
        key: "hub",
        content: totalCount
          ? `Đã sinh ${totalCount} test case (Draft).`
          : "Không có test case mới.",
      });
      setLastGenCount(totalCount);
      setStep(2);
      await refreshJourney();
    } catch (e) {
      message.error({
        key: "hub",
        content: e instanceof Error ? e.message : "Sinh TC thất bại",
      });
    } finally {
      control.reset();
      setRunning(false);
      setGenQueue(null);
    }
  }

  const scopeLabelForMode =
    scopeLevel === "module" && selectedTopic
      ? `chức năng «${selectedTopic.title}»`
      : scopeLevel === "module"
        ? "module đã chọn"
        : "requirement này";

  const summaryLines = useMemo(() => {
    const lines: { label: string; value: string }[] = [
      { label: "Phạm vi", value: SCOPE_LABELS[scopeLevel] },
    ];
    if (selectedReq) lines.push({ label: "Requirement", value: selectedReq.title });
    if (scopeLevel === "module" && selectedTopic) {
      lines.push({ label: "Chức năng", value: selectedTopic.title });
    }
    lines.push({
      label: "Chế độ",
      value: tcGenerateModeSummary(tcMode, null, scopeLabelForMode),
    });
    if (planTitles.length > 1) {
      lines.push({
        label: "Số lượt AI",
        value: `${planTitles.length} chức năng (lần lượt)`,
      });
    }
    return lines;
  }, [scopeLevel, selectedReq, selectedTopic, tcMode, planTitles.length, scopeLabelForMode]);

  const genProgressPercent = useMemo(() => {
    if (!genQueue?.length) return 0;
    const done = genQueue.filter((x) => x.status === "done").length;
    const running = genQueue.some((x) => x.status === "running") ? 0.5 : 0;
    return Math.round(((done + running) / genQueue.length) * 100);
  }, [genQueue]);

  const multiJobPlanned = useMemo(
    () =>
      scopeLevel === "system" &&
      ((selectedReq?.featureCount ?? 0) > 1 || topics.length > 1 || planTitles.length > 1),
    [scopeLevel, selectedReq?.featureCount, topics.length, planTitles.length]
  );

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={2}>Sinh test case</Typography.Title>
        <Alert type="error" showIcon title="Chưa chọn dự án." />
      </div>
    );
  }

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={2} style={{ margin: 0 }}>
            Sinh test case
          </Typography.Title>
          <Typography.Text type="secondary">
            Design: chọn phạm vi → AI sinh TC (Draft) → duyệt Approved → mới sang Sinh Unit.
          </Typography.Text>
        </div>
        <Link to={ROUTES.requirement}>
          <Button>Quay Requirement board</Button>
        </Link>
      </header>

      {aiReady === false ? (
        <Alert
          type="warning"
          showIcon
          style={{ margin: "16px 0" }}
          title="AI chưa Ready"
          description={
            <span>
              Vào <Link to="/settings/ai">Cấu hình AI</Link> trước khi sinh.
            </span>
          }
        />
      ) : null}

      {reqList.length === 0 ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 16 }}
          title="Chưa có requirement"
          description={
            <span>
              Soạn Requirement trước tại <Link to="/requirement">Requirement Studio</Link>.
            </span>
          }
        />
      ) : null}

      <Steps
        current={step}
        style={{ margin: "20px 0", maxWidth: 560 }}
        items={[
          { title: "Chọn phạm vi" },
          { title: "Sinh" },
          { title: "Kết quả" },
        ]}
      />

      {step === 0 ? (
        <Card title="Cấu hình sinh test case" loading={loading}>
          <Space orientation="vertical" style={{ width: "100%" }} size="middle">
            <Alert
              type="info"
              showIcon
              title="Trang này chỉ sinh test case (Draft)"
              description="Không sinh file unit. Sau khi xong → Duyệt TC → Unit test."
            />
            <div>
              <Typography.Text strong>Phạm vi sinh</Typography.Text>
              <Radio.Group
                value={scopeLevel}
                onChange={(e) => setScopeLevel(e.target.value as ScopeLevel)}
                style={{ display: "block", marginTop: 8 }}
              >
                <Space orientation="vertical" size={12}>
                  {(["system", "module", "feature"] as ScopeLevel[]).map((key) => (
                    <Radio key={key} value={key} style={{ alignItems: "flex-start" }}>
                      <div>
                        <div>{SCOPE_LABELS[key]}</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {SCOPE_HINTS[key]}
                        </Typography.Text>
                      </div>
                    </Radio>
                  ))}
                </Space>
              </Radio.Group>
            </div>
            <div>
              <Typography.Text strong>Requirement</Typography.Text>
              <Select
                style={{ width: "100%", marginTop: 6 }}
                value={requirementId}
                onChange={(id) => {
                  setRequirementId(id);
                  setTopicId(undefined);
                }}
                options={reqList.map((r) => ({ value: r.id, label: r.title }))}
              />
            </div>
            {scopeLevel === "module" && topics.length > 0 ? (
              <div>
                <Typography.Text strong>Chủ đề (module)</Typography.Text>
                <Select
                  style={{ width: "100%", marginTop: 6 }}
                  placeholder="Chọn chủ đề"
                  value={topicId}
                  onChange={setTopicId}
                  options={topics.map((t) => ({ value: t.id, label: t.title }))}
                />
              </div>
            ) : null}
            {scopeLevel === "module" && topics.length === 0 ? (
              <Alert
                type="info"
                showIcon
                title="Chưa có chủ đề"
                description="Thêm chủ đề trong Yêu cầu & TC hoặc chọn phạm vi toàn hệ thống."
              />
            ) : null}
            {scopeLevel === "module" &&
            (selectedReq?.featureCount ?? 0) > 1 &&
            initial.module ? (
              <Alert
                type="warning"
                showIcon
                title="Chỉ sinh một chức năng"
                description={
                  <>
                    Link từ bảng Coverage đang giới hạn module «{initial.module}». Để sinh đủ{" "}
                    {selectedReq?.featureCount} file/chức năng, chọn phạm vi{" "}
                    <strong>{SCOPE_LABELS.system}</strong> (hệ thống chạy lần lượt từng chức năng).
                  </>
                }
              />
            ) : null}
            {scopeLevel === "system" && (selectedReq?.featureCount ?? topics.length) > 1 ? (
              <Alert
                type="info"
                showIcon
                title={`${topics.length > 1 ? topics.length : selectedReq?.featureCount} chức năng / file SRS`}
                description="Ở bước tiếp theo bạn sẽ thấy danh sách từng chức năng. AI chạy lần lượt — mỗi chức năng khoảng 1–3 phút."
              />
            ) : null}
            <TcGenerateModeField
              projectId={project.id}
              requirementId={requirementId}
              scopeLevel={scopeLevel}
              moduleTitle={selectedTopic?.title}
              value={tcMode}
              onChange={setTcMode}
              multiJob={multiJobPlanned}
            />
            <Checkbox
              checked={useSourceContext}
              onChange={(e) => setUseSourceContext(e.target.checked)}
            >
              Bổ sung ngữ cảnh từ mã nguồn local (tuỳ chọn)
            </Checkbox>
          </Space>
          <Space style={{ marginTop: 16 }}>
            <Button
              type="primary"
              onClick={() => setStep(1)}
              disabled={reqList.length === 0}
            >
              Tiếp — xác nhận & sinh
            </Button>
          </Space>
        </Card>
      ) : null}

      {step === 1 ? (
        <Card
          title={running ? "Đang sinh test case…" : "Xác nhận & sinh"}
          extra={
            running && genQueue && genQueue.length > 1 ? (
              <Typography.Text type="secondary">
                {genQueue.filter((x) => x.status === "done").length}/{genQueue.length} chức năng
              </Typography.Text>
            ) : null
          }
        >
          {running && genQueue ? (
            <div style={{ marginBottom: 20 }}>
              <Progress
                percent={genProgressPercent}
                status={batchRunStatus === "paused" ? "normal" : "active"}
              />
              <ul style={{ margin: "16px 0 0", paddingLeft: 0, listStyle: "none" }}>
                {genQueue.map((row, idx) => (
                  <li key={`${idx}-${row.title}`} style={{ marginBottom: 8, display: "flex", gap: 8 }}>
                    {row.status === "done" ? (
                      <CheckCircleOutlined style={{ color: "#52c41a", marginTop: 3 }} />
                    ) : row.status === "running" ? (
                      <LoadingOutlined style={{ color: "#1677ff", marginTop: 3 }} />
                    ) : row.status === "error" ? (
                      <Typography.Text type="danger">✕</Typography.Text>
                    ) : (
                      <span style={{ width: 14, marginTop: 3, opacity: 0.35 }}>○</span>
                    )}
                    <span
                      style={{
                        fontWeight: row.status === "running" ? 600 : 400,
                        opacity: row.status === "pending" ? 0.65 : 1,
                      }}
                    >
                      {row.title}
                    </span>
                  </li>
                ))}
              </ul>
              {genQueue.length > 1 ? (
                <Space wrap style={{ marginTop: 12 }}>
                  {batchRunStatus === "running" ? (
                    <Button
                      icon={<PauseCircleOutlined />}
                      onClick={() => batchControlRef.current.pause()}
                    >
                      Tạm dừng
                    </Button>
                  ) : null}
                  {batchRunStatus === "paused" ? (
                    <Button
                      type="primary"
                      icon={<PlayCircleOutlined />}
                      onClick={() => batchControlRef.current.resume()}
                    >
                      Tiếp tục
                    </Button>
                  ) : null}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {batchRunStatus === "paused"
                      ? "Tạm dừng sau chức năng hiện tại · bấm Tiếp tục để chạy hết hàng đợi."
                      : "Tạm dừng sẽ chờ xong chức năng đang chạy rồi dừng trước mục kế."}
                  </Typography.Text>
                </Space>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  Vui lòng không đóng trang cho đến khi hoàn tất.
                </Typography.Text>
              )}
            </div>
          ) : (
            <>
              <Descriptions column={1} size="small" bordered style={{ marginBottom: 16 }}>
                {summaryLines.map((row) => (
                  <Descriptions.Item key={row.label} label={row.label}>
                    {row.value}
                  </Descriptions.Item>
                ))}
              </Descriptions>
              {planLoading ? (
                <Typography.Text type="secondary">Đang tải danh sách chức năng…</Typography.Text>
              ) : planTitles.length > 0 ? (
                <div style={{ marginBottom: 16 }}>
                  <Typography.Text strong>
                    {planTitles.length > 1
                      ? `Thứ tự sinh (${planTitles.length} chức năng)`
                      : "Phạm vi nội dung"}
                  </Typography.Text>
                  <ol style={{ marginTop: 8, marginBottom: 0, paddingLeft: 20 }}>
                    {planTitles.map((t) => (
                      <li key={t}>{t}</li>
                    ))}
                  </ol>
                </div>
              ) : scopeLevel === "module" ? (
                <Alert
                  type="warning"
                  showIcon
                  style={{ marginBottom: 16 }}
                  title="Chưa chọn chức năng"
                  description="Quay lại bước trước và chọn chủ đề (module)."
                />
              ) : null}
              <Alert
                type="info"
                showIcon
                style={{ marginBottom: 16 }}
                title="Sau khi sinh xong"
                description={
                  <>
                    Bạn sẽ thấy màn kết quả với CTA <strong>Đi duyệt</strong>. Chỉ TC đã duyệt mới
                    dùng được ở Sinh Unit.
                  </>
                }
              />
            </>
          )}
          <Space>
            <Button onClick={() => setStep(0)} disabled={running}>
              Quay lại
            </Button>
            <Button
              type="primary"
              icon={<ThunderboltOutlined />}
              loading={running && batchRunStatus === "running"}
              disabled={
                running ||
                batchRunStatus === "paused" ||
                (scopeLevel === "module" && topics.length > 0 && !selectedTopic) ||
                aiReady === false
              }
              onClick={() => void runTcJob()}
            >
              Sinh test case
            </Button>
          </Space>
        </Card>
      ) : null}

      {step === 2 ? (
        <Card style={{ textAlign: "center", padding: "32px 16px" }}>
          <CheckCircleOutlined style={{ fontSize: 40, color: "#52c41a", marginBottom: 12 }} />
          <Typography.Title level={4} style={{ marginTop: 0 }}>
            {lastGenCount
              ? `Đã sinh ${lastGenCount} test case (Draft)`
              : "Không có test case mới"}
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ maxWidth: 440, margin: "0 auto 20px" }}>
            Duyệt (Approve) trước khi sinh Unit. Chưa Approved thì trang Unit sẽ chỉ hiện một CTA
            quay lại đây.
          </Typography.Paragraph>
          <Space wrap>
            <Link to={requirementUrl({ tab: "review" })}>
              <Button type="primary" size="large">
                Đi duyệt TC
              </Button>
            </Link>
            <Button size="large" onClick={() => { setStep(0); setLastGenCount(null); }}>
              Sinh thêm
            </Button>
            <Link to={ROUTES.requirement}>
              <Button size="large">Requirement board</Button>
            </Link>
          </Space>
        </Card>
      ) : null}
    </div>
  );
}
