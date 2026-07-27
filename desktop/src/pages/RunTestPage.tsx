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
  Tag,
  Typography,
} from "antd";
import { Link, useSearchParams } from "react-router-dom";
import { PlayCircleOutlined, ReloadOutlined } from "@ant-design/icons";
import { executions, projects } from "../api";
import type { Execution, Project } from "../api/types";
import { runnerLabelFromCommand, suggestTestCommand } from "../lib/stackHints";
import { useProject } from "../state/ProjectContext";
import { workspace } from "../workspace";
import {
  isTauri,
  runDotnetTest,
  runTestCommand,
  type TestRunResult,
} from "../tauri/bridge";

import { ensureAitestJestTsconfigInWorkspace } from "../lib/unitWorkspace/ensureAitestJestTsconfig";

type HistoryFilter = "all" | "Passed" | "Failed" | "Error";

export default function RunTestPage() {
  const { project } = useProject();
  const [searchParams] = useSearchParams();
  const [serverProject, setServerProject] = useState<Project | null>(null);
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
        setCommand((prev) => fromUrl || prev || suggestTestCommand(p));
      })
      .catch(() => undefined);
  }, [project?.id, searchParams]);

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
      setError("Cần mở project local (tab Mở dự án).");
      return;
    }
    const cmd = command.trim();
    if (!cmd) {
      setError("Nhập lệnh chạy test phù hợp stack dự án (vd. npm test, pytest, dotnet test).");
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
              packagePrefix: "",
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
      const isDotnet = /^dotnet\s+test\b/i.test(runCmd);
      const result = isDotnet
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
      setMessage("Đã upload kết quả execution lên server.");
      await loadHistory();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Run failed");
    } finally {
      setRunning(false);
    }
  }

  if (!project) {
    return (
      <div className="page">
        <Typography.Title level={3}>Chạy test</Typography.Title>
        <Alert
          type="warning"
          showIcon
          message="Chưa chọn project"
          description={
            <>
              Vào tab <Link to="/projects">Dự án</Link> để chọn hoặc tạo dự án trước.
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
    <div className="page">
      <header className="page-head">
        <div>
          <Typography.Title level={3} style={{ margin: 0 }}>
            Chạy test
          </Typography.Title>
          <Typography.Paragraph type="secondary" style={{ marginBottom: 0 }}>
            Phase B — chạy lệnh local, parse kết quả, lưu Execution · {project.name}
            <br />
            Stack: <Typography.Text strong>{stackHint}</Typography.Text>
            {" · "}
            Parser: <Typography.Text code>{runnerLabel}</Typography.Text>
            {" · "}
            <Link to="/reports">Báo cáo / Coverage</Link>
          </Typography.Paragraph>
        </div>
      </header>

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
              Vào <Link to="/unit-test">Unit test</Link> → <strong>Gắn root Apply</strong> trước khi
              chạy lệnh test.
            </>
          }
        />
      ) : null}
      {error ? (
        <Alert type="error" showIcon message={error} style={{ marginBottom: 16 }} closable onClose={() => setError(null)} />
      ) : null}
      {message ? (
        <Alert type="success" showIcon message={message} style={{ marginBottom: 16 }} closable onClose={() => setMessage(null)} />
      ) : null}

      <Card title="Lệnh test" style={{ marginBottom: 16 }}>
        <Space direction="vertical" size="middle" style={{ width: "100%" }}>
          <div>
            <Typography.Text type="secondary">Lệnh chạy test</Typography.Text>
            <Input
              style={{ marginTop: 4 }}
              placeholder="vd. npm test · pytest · go test ./... · dotnet test"
              value={command}
              onChange={(e) => setCommand(e.target.value)}
            />
            {localPath ? (
              <Typography.Text type="secondary" style={{ display: "block", marginTop: 6, fontSize: 12 }}>
                Root Apply: <Typography.Text code>{localPath}</Typography.Text>
                {" — "}npm tự chạy trong thư mục có{" "}
                <Typography.Text code>package.json</Typography.Text> (vd. backend/) nếu root monorepo
                không có.
              </Typography.Text>
            ) : null}
          </div>
          {/^dotnet\s+test\b/i.test(command.trim()) ? (
            <div>
              <Typography.Text type="secondary">Filter (tuỳ chọn, .sln / .csproj tương đối)</Typography.Text>
              <Input
                style={{ marginTop: 4 }}
                placeholder="Tests/My.Tests.csproj"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
              />
            </div>
          ) : null}
          <Space wrap>
            <Button
              type="primary"
              icon={<PlayCircleOutlined />}
              onClick={() => void execute()}
              loading={running}
              disabled={!isTauri() || !localPath}
            >
              Chạy test
            </Button>
            <Button
              icon={<ReloadOutlined />}
              disabled={!serverProject}
              onClick={() => setCommand(suggestTestCommand(serverProject))}
            >
              Gợi ý theo stack
            </Button>
          </Space>
        </Space>
      </Card>

      {run ? (
        <Card title="Kết quả lần chạy" style={{ marginBottom: 16 }}>
          <Space direction="vertical" size="large" style={{ width: "100%" }}>
            <Row gutter={[16, 16]}>
              <Col xs={12} sm={6}>
                <Statistic title="Passed" value={run.passed} valueStyle={{ color: "#3f8600" }} />
              </Col>
              <Col xs={12} sm={6}>
                <Statistic title="Failed" value={run.failed} valueStyle={{ color: run.failed > 0 ? "#cf1322" : undefined }} />
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
            ) : (
              <Alert
                type="info"
                showIcon
                message="Không parse được số test từ log"
                description="Kiểm tra log bên dưới — parser hỗ trợ pytest, Jest/Vitest, go test, dotnet console/TRX."
              />
            )}
            <Space wrap>
              <Tag color={run.success ? "success" : "error"}>{run.success ? "Passed" : "Failed"}</Tag>
              <Tag>exit {run.exitCode}</Tag>
              <Tag>{run.durationMs} ms</Tag>
              <Typography.Text type="secondary" copyable={{ text: run.command }}>
                {run.command}
              </Typography.Text>
            </Space>
            <Typography.Paragraph>
              <pre className="code" style={{ maxHeight: 360, overflow: "auto" }}>
                {run.log}
              </pre>
            </Typography.Paragraph>
          </Space>
        </Card>
      ) : null}

      <Card
        title="Lịch sử execution"
        extra={
          <Select<HistoryFilter>
            value={historyFilter}
            style={{ width: 160 }}
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
        <Table<Execution>
          rowKey="id"
          size="small"
          pagination={{ pageSize: 10, hideOnSinglePage: true }}
          locale={{ emptyText: "Chưa có lần chạy nào." }}
          dataSource={filteredHistory}
          columns={[
            {
              title: "Trạng thái",
              dataIndex: "status",
              render: (status: string) => (
                <Tag color={status === "Passed" ? "success" : status === "Failed" ? "error" : "default"}>
                  {status}
                </Tag>
              ),
            },
            {
              title: "Passed / Failed / Skipped / Total",
              render: (_, e) => `${e.passed} / ${e.failed} / ${e.skipped ?? 0} / ${e.total}`,
            },
            {
              title: "Lệnh",
              dataIndex: "command",
              ellipsis: true,
              render: (cmd: string) => (
                <Typography.Text ellipsis={{ tooltip: cmd }} style={{ maxWidth: 280 }}>
                  {cmd || "—"}
                </Typography.Text>
              ),
            },
            {
              title: "Thời gian",
              dataIndex: "durationMs",
              width: 100,
              render: (ms: number) => `${ms} ms`,
            },
            {
              title: "Lúc",
              dataIndex: "startedAt",
              width: 180,
              render: (t: string) => new Date(t).toLocaleString(),
            },
          ]}
        />
      </Card>
    </div>
  );
}
