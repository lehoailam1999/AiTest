import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Alert,
  Button,
  Card,
  Col,
  Input,
  Progress,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tabs,
  Tag,
  Tooltip,
  Typography,
} from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { executions, projects } from "../api";
import type { Execution, Project } from "../api/types";
import { runnerLabelFromCommand, suggestTestCommand } from "../lib/stackHints";
import {
  classifyExecutionLane,
  resolveE2eRunCommand,
  resolveUnitRunCommand,
  type RunLane,
} from "../lib/runCenter";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import { IdeConnectPanel } from "../components/IdeConnectPanel";
import {
  isTauri,
  runDotnetTest,
  runTestCommand,
  type TestRunResult,
} from "../tauri/bridge";
import { ensureAitestJestTsconfigInWorkspace } from "../lib/unitWorkspace/ensureAitestJestTsconfig";
import { ROUTES, e2eTestUrl, unitTestUrl } from "../lib/productRoutes";

type HistoryFilter = "all" | "Passed" | "Failed" | "Error";

function laneFromSearch(raw: string | null): RunLane {
  const v = (raw || "").toLowerCase();
  if (v === "e2e" || v === "unit" || v === "advanced") return v;
  return "unit";
}

export default function RunTestPage() {
  const { project } = useProject();
  const [searchParams, setSearchParams] = useSearchParams();
  const [serverProject, setServerProject] = useState<Project | null>(null);
  const [lane, setLane] = useState<RunLane>(() => laneFromSearch(searchParams.get("lane")));
  const [packagePrefix, setPackagePrefix] = useState("");
  const [command, setCommand] = useState("");
  const [filter, setFilter] = useState("");
  const [running, setRunning] = useState(false);
  const [run, setRun] = useState<TestRunResult | null>(null);
  const [history, setHistory] = useState<Execution[]>([]);
  const [historyFilter, setHistoryFilter] = useState<HistoryFilter>("all");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const localPath = project ? workspace.getLocalPath(project.id) : null;

  const loadHistory = useCallback(async () => {
    if (!project) return;
    try {
      const page = await executions.list(project.id);
      setHistory(page.items);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [project]);

  useEffect(() => {
    void loadHistory();
  }, [loadHistory]);

  useEffect(() => {
    if (!project) {
      setServerProject(null);
      setCommand("");
      return;
    }
    void projects
      .get(project.id)
      .then((p) => {
        setServerProject(p);
        const fromUrl = searchParams.get("cmd")?.trim();
        const urlLane = laneFromSearch(searchParams.get("lane"));
        if (fromUrl) {
          setLane("advanced");
          setCommand(fromUrl);
          return;
        }
        setLane(urlLane);
        const pkg = packagePrefix.trim() || null;
        if (urlLane === "e2e") setCommand(resolveE2eRunCommand(pkg));
        else if (urlLane === "unit") setCommand(resolveUnitRunCommand(p, pkg));
        else setCommand((prev) => prev || suggestTestCommand(p));
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- packagePrefix applied via Apply preset buttons
  }, [project?.id, searchParams]);

  const applyLanePreset = useCallback(
    (next: RunLane) => {
      setLane(next);
      const q = new URLSearchParams(searchParams);
      if (next === "unit") q.set("lane", "unit");
      else if (next === "e2e") q.set("lane", "e2e");
      else q.set("lane", "advanced");
      q.delete("cmd");
      setSearchParams(q, { replace: true });
      const pkg = packagePrefix.trim() || null;
      if (next === "unit") setCommand(resolveUnitRunCommand(serverProject, pkg));
      else if (next === "e2e") setCommand(resolveE2eRunCommand(pkg));
      else setCommand(suggestTestCommand(serverProject));
    },
    [packagePrefix, searchParams, serverProject, setSearchParams]
  );

  const runnerLabel = useMemo(() => runnerLabelFromCommand(command), [command]);

  const filteredHistory = useMemo(() => {
    if (historyFilter === "all") return history;
    return history.filter((e) => e.status === historyFilter);
  }, [history, historyFilter]);

  const passRate = useMemo(() => {
    if (!run || run.total <= 0) return 0;
    return Math.round((run.passed / run.total) * 100);
  }, [run]);

  async function execute() {
    if (!project || !localPath) {
      setError("Cần gắn project root (Unit test / E2E → Gắn root).");
      return;
    }
    const cmd = command.trim();
    if (!cmd) {
      setError("Chưa có lệnh chạy — chọn Unit/E2E hoặc nhập lệnh Advanced.");
      return;
    }
    setRunning(true);
    setError(null);
    setMessage(null);
    try {
      let runCmd = cmd;
      const isJest = /jest/i.test(cmd) || cmd === "npm test";
      if (isJest) {
        try {
          await ensureAitestJestTsconfigInWorkspace({
            projectRoot: localPath,
            manifest: {
              version: 1,
              projectId: project.id,
              runId: "run-page",
              testCaseId: "",
              status: "draft",
              packagePrefix: packagePrefix.trim(),
              createdAt: new Date().toISOString(),
              files: [],
            },
          });
        } catch {
          /* best effort */
        }
        if (cmd === "npm test" || cmd === "npx jest" || cmd === "jest") {
          runCmd = "npx jest --config AItest/jest.config.cjs --runInBand --passWithNoTests";
        }
      }
      const isBareDotnet =
        /^dotnet\s+test\b/i.test(runCmd) && !/\.csproj\b/i.test(runCmd);
      const result = isBareDotnet
        ? await runDotnetTest(localPath, filter.trim() || undefined)
        : await runTestCommand(localPath, runCmd);
      setRun(result);
      const status = result.success
        ? "Passed"
        : result.exitCode !== 0 || result.failed > 0
          ? "Failed"
          : "Error";
      await executions.create({
        projectId: project.id,
        command: result.command,
        exitCode: result.exitCode,
        status,
        passed: result.passed,
        failed: result.failed,
        skipped: result.skipped,
        total: result.total,
        durationMs: result.durationMs,
        logExcerpt: result.log,
        trxFileName: result.trxFileName,
        filter: result.filter,
      });
      setMessage("Đã lưu kết quả vào lịch sử Execution.");
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  if (!project) {
    return (
      <div className="page run-test-page">
        <Typography.Title level={3}>Chạy test</Typography.Title>
        <Alert
          type="warning"
          showIcon
          message="Chưa chọn project"
          description={
            <>
              Vào tab <Link to={ROUTES.projects}>Dự án</Link> để chọn hoặc tạo dự án trước.
            </>
          }
        />
      </div>
    );
  }

  const stackHint =
    [serverProject?.language, serverProject?.framework, ...(serverProject?.meta?.stacks ?? [])]
      .filter(Boolean)
      .join(" · ") || "chưa nhận diện stack";

  return (
    <div className="page run-test-page">
      <header className="page-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Chạy test
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Regression trên code đã <strong>Apply</strong> — không sinh TC / không sinh code tại đây.
            <br />
            {project.name} · Stack: <Typography.Text strong>{stackHint}</Typography.Text>
          </Typography.Paragraph>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => void loadHistory()} loading={running}>
          Tải lại lịch sử
        </Button>
      </header>

      <div style={{ marginBottom: 12, marginTop: 12 }}>
        <IdeConnectPanel compact projectPath={localPath ?? undefined} />
      </div>

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 16 }}
        message="Tách flow"
        description={
          <>
            Sinh / Verify / Apply:{" "}
            <Link to={unitTestUrl()}>Unit test</Link>
            {" · "}
            <Link to={e2eTestUrl()}>E2E</Link>
            . Trang này chỉ chạy lại test đã nằm trong repo (AItest/).
          </>
        }
      />

      {!isTauri() ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Cần app Desktop (Tauri)"
          description="Dùng `npm run dev` trong thư mục desktop — không chạy trên trình duyệt thuần."
        />
      ) : null}
      {!localPath ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 16 }}
          message="Chưa mở project local"
          description={
            <>
              Vào <Link to={ROUTES.unitTest}>Unit test</Link> hoặc{" "}
              <Link to={ROUTES.e2eTest}>E2E</Link> → gắn root Apply trước.
            </>
          }
        />
      ) : null}
      {error ? (
        <Alert
          type="error"
          showIcon
          message={error}
          style={{ marginBottom: 16 }}
          closable
          onClose={() => setError(null)}
        />
      ) : null}
      {message ? (
        <Alert
          type="success"
          showIcon
          message={message}
          style={{ marginBottom: 16 }}
          closable
          onClose={() => setMessage(null)}
        />
      ) : null}

      <Card style={{ marginBottom: 16 }}>
        <Tabs
          activeKey={lane}
          onChange={(k) => applyLanePreset(k as RunLane)}
          items={[
            {
              key: "unit",
              label: "Unit",
              children: (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    Chạy AItest Unit đã Apply (dotnet / jest / vitest / pytest theo stack). Không gọi AI
                    generate.
                  </Typography.Text>
                  <div>
                    <Typography.Text type="secondary">Package prefix (monorepo, tuỳ chọn)</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      placeholder="vd. backend · src/Lib · để trống = root"
                      value={packagePrefix}
                      onChange={(e) => setPackagePrefix(e.target.value)}
                      onBlur={() => {
                        if (lane === "unit") {
                          setCommand(
                            resolveUnitRunCommand(serverProject, packagePrefix.trim() || null)
                          );
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Typography.Text type="secondary">Lệnh</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                  </div>
                  {/^dotnet\s+test\b/i.test(command.trim()) ? (
                    <div>
                      <Typography.Text type="secondary">
                        Filter .NET (tuỳ chọn) — truyền vào runDotnetTest
                      </Typography.Text>
                      <Input
                        style={{ marginTop: 4 }}
                        placeholder="FullyQualifiedName~MyTest"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                    </div>
                  ) : null}
                </Space>
              ),
            },
            {
              key: "e2e",
              label: "E2E",
              children: (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    Playwright trên suite <Typography.Text code>AItest/E2ETest</Typography.Text> đã
                    Apply. Auth/env cấu hình ở trang E2E — trang này không regenerate Spec/POM.
                  </Typography.Text>
                  <div>
                    <Typography.Text type="secondary">Package prefix (tuỳ chọn)</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      placeholder="vd. frontend"
                      value={packagePrefix}
                      onChange={(e) => setPackagePrefix(e.target.value)}
                      onBlur={() => {
                        if (lane === "e2e") {
                          setCommand(resolveE2eRunCommand(packagePrefix.trim() || null));
                        }
                      }}
                    />
                  </div>
                  <div>
                    <Typography.Text type="secondary">Lệnh</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                  </div>
                </Space>
              ),
            },
            {
              key: "advanced",
              label: "Advanced",
              children: (
                <Space direction="vertical" size="middle" style={{ width: "100%" }}>
                  <Typography.Text type="secondary">
                    Lệnh tùy chỉnh (giữ hành vi cũ). Dùng khi preset Unit/E2E chưa khớp monorepo.
                  </Typography.Text>
                  <div>
                    <Typography.Text type="secondary">Lệnh chạy test</Typography.Text>
                    <Input
                      style={{ marginTop: 4 }}
                      placeholder="vd. npm test · pytest · go test ./... · dotnet test"
                      value={command}
                      onChange={(e) => setCommand(e.target.value)}
                    />
                    {localPath ? (
                      <Typography.Text
                        type="secondary"
                        className="run-test-cmd"
                        style={{ display: "block", marginTop: 6, fontSize: 12 }}
                      >
                        Root:{" "}
                        <Typography.Text code className="run-test-cmd">
                          {localPath}
                        </Typography.Text>
                      </Typography.Text>
                    ) : null}
                  </div>
                  {/^dotnet\s+test\b/i.test(command.trim()) ? (
                    <div>
                      <Typography.Text type="secondary">Filter (tuỳ chọn)</Typography.Text>
                      <Input
                        style={{ marginTop: 4 }}
                        placeholder="Tests/My.Tests.csproj"
                        value={filter}
                        onChange={(e) => setFilter(e.target.value)}
                      />
                    </div>
                  ) : null}
                  <Button
                    icon={<ReloadOutlined />}
                    disabled={!serverProject}
                    onClick={() => setCommand(suggestTestCommand(serverProject))}
                  >
                    Gợi ý theo stack
                  </Button>
                </Space>
              ),
            },
          ]}
        />
        <Space wrap style={{ marginTop: 16 }}>
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => void execute()}
            loading={running}
            disabled={!isTauri() || !localPath}
          >
            Chạy {lane === "unit" ? "Unit" : lane === "e2e" ? "E2E" : "test"}
          </Button>
          <Button
            icon={<ReloadOutlined />}
            disabled={!serverProject || lane === "advanced"}
            onClick={() => applyLanePreset(lane)}
          >
            Reset preset
          </Button>
        </Space>
      </Card>

      {run ? (
        <Card title="Kết quả lần chạy" className="run-test-result" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6}>
                <Statistic title="Passed" value={run.passed} valueStyle={{ color: "#3f8600" }} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic
                  title="Failed"
                  value={run.failed}
                  valueStyle={{ color: run.failed > 0 ? "#cf1322" : undefined }}
                />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title="Skipped" value={run.skipped} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title="Total" value={run.total} />
              </Col>
            </Row>
            {run.total > 0 ? (
              <div>
                <Typography.Text type="secondary">Tỷ lệ pass</Typography.Text>
                <Progress percent={passRate} status={run.failed > 0 ? "exception" : "success"} />
              </div>
            ) : null}
            <Typography.Paragraph className="run-test-cmd" style={{ marginBottom: 0 }}>
              <Typography.Text type="secondary">Command: </Typography.Text>
              <Typography.Text code className="run-test-cmd">
                {run.command}
              </Typography.Text>
            </Typography.Paragraph>
            {run.log ? (
              <pre className="run-test-log">{run.log.slice(0, 8000)}</pre>
            ) : null}
          </Space>
        </Card>
      ) : null}

      <Card
        title="Lịch sử Execution"
        extra={
          <Select
            style={{ width: 140 }}
            value={historyFilter}
            onChange={setHistoryFilter}
            options={[
              { value: "all", label: "Tất cả" },
              { value: "Passed", label: "Passed" },
              { value: "Failed", label: "Failed" },
              { value: "Error", label: "Error" },
            ]}
          />
        }
      >
        <Table
          rowKey="id"
          size="small"
          className="batch-run-table run-test-history-table"
          dataSource={filteredHistory}
          pagination={{ pageSize: 8 }}
          columns={[
            {
              title: "Lane",
              width: 90,
              render: (_: unknown, row: Execution) => {
                const l = classifyExecutionLane(row.command);
                const color = l === "e2e" ? "purple" : l === "unit" ? "blue" : "default";
                return <Tag color={color}>{l}</Tag>;
              },
            },
            {
              title: "Status",
              dataIndex: "status",
              width: 90,
              render: (s: string) => (
                <Tag color={s === "Passed" ? "success" : s === "Failed" ? "error" : "warning"}>
                  {s}
                </Tag>
              ),
            },
            {
              title: "P/F/T",
              width: 100,
              render: (_: unknown, row: Execution) =>
                `${row.passed}/${row.failed}/${row.total}`,
            },
            {
              title: "Command",
              dataIndex: "command",
              width: 280,
              render: (v: string) => (
                <Tooltip title={v} placement="topLeft">
                  <div className="batch-clamp batch-clamp-1">{v || "—"}</div>
                </Tooltip>
              ),
            },
            {
              title: "When",
              dataIndex: "finishedAt",
              width: 180,
              render: (v: string) => (v ? new Date(v).toLocaleString() : "—"),
            },
          ]}
        />
      </Card>
    </div>
  );
}
