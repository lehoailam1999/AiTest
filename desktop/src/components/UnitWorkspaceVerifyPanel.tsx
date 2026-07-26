import { useEffect, useMemo, useState } from "react";
import {
  Alert,
  App,
  Button,
  Card,
  Checkbox,
  Collapse,
  Input,
  Modal,
  Space,
  Steps,
  Tag,
  Typography,
} from "antd";
import {
  CheckCircleOutlined,
  CloseCircleOutlined,
  PlayCircleOutlined,
  ToolOutlined,
  SaveOutlined,
} from "@ant-design/icons";
import { Link } from "react-router-dom";
import { applyWorkspaceToRepo } from "../lib/unitWorkspace/applyManager";
import { runWorkspaceVerify } from "../lib/unitWorkspace/verifyEngine";
import type { UnitWorkspaceManifest } from "../lib/unitWorkspace/types";
import { suggestWorkspaceVerifyCommands } from "../lib/stackHints";
import type { ProjectMeta } from "../api/types";
import { isTauri } from "../tauri/bridge";
import { useIdeBridgeSession } from "../lib/ideBridge/session";

type Props = {
  manifest: UnitWorkspaceManifest;
  projectRoot: string;
  language?: string | null;
  framework?: string | null;
  meta?: ProjectMeta | null;
  busy: boolean;
  repairing?: boolean;
  onBusy: (v: boolean) => void;
  onManifestChange: (m: UnitWorkspaceManifest) => void;
  onRepair?: () => void;
};

export function UnitWorkspaceVerifyPanel({
  manifest,
  projectRoot,
  language,
  framework,
  meta,
  busy,
  repairing = false,
  onBusy,
  onManifestChange,
  onRepair,
}: Props) {
  const { message } = App.useApp();
  const ideConnected = useIdeBridgeSession((s) => s.status === "connected");
  const [lastOpenedInIde, setLastOpenedInIde] = useState<string[]>([]);
  const targetPaths = useMemo(
    () => manifest.files.filter((f) => f.op !== "delete").map((f) => f.targetRel),
    [manifest.files]
  );

  const hints = useMemo(
    () =>
      suggestWorkspaceVerifyCommands({
        language,
        framework: framework === "auto" ? "" : framework,
        meta,
        targetRelPaths: targetPaths,
        packagePrefix: manifest.packagePrefix,
      }),
    [language, framework, meta, targetPaths, manifest.packagePrefix]
  );

  const [compileCmd, setCompileCmd] = useState(hints.compile);
  const [testCmd, setTestCmd] = useState(hints.test);
  const [coverageCmd, setCoverageCmd] = useState(hints.coverage);
  const [runCoverage, setRunCoverage] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);

  useEffect(() => {
    setCompileCmd(hints.compile);
    setTestCmd(hints.test);
    setCoverageCmd(hints.coverage);
  }, [hints.compile, hints.test, hints.coverage, manifest.runId]);

  const verify = manifest.verify;
  const canApply = manifest.status === "pass" && isTauri();
  const applied = manifest.status === "applied";

  const stepIndex =
    manifest.status === "verifying"
      ? 1
      : manifest.status === "pass" || manifest.status === "fail"
        ? 2
        : manifest.status === "applied"
          ? 3
          : 0;

  async function onVerify() {
    if (!isTauri()) return;
    onBusy(true);
    try {
      const { manifest: next } = await runWorkspaceVerify({
        projectRoot,
        manifest,
        compileCommand: compileCmd,
        testCommand: testCmd,
        coverageCommand: runCoverage ? coverageCmd : "",
      });
      onManifestChange(next);
    } finally {
      onBusy(false);
    }
  }

  async function onApplyConfirm() {
    onBusy(true);
    try {
      const result = await applyWorkspaceToRepo(projectRoot, manifest, {
        openInIde: true,
      });
      onManifestChange(result.manifest);
      setLastOpenedInIde(result.openedInIde);
      setApplyOpen(false);
      if (result.openedInIde.length) {
        message.success(
          `Đã Apply · mở trong IDE: ${result.openedInIde.map((p) => p.split("/").pop()).join(", ")}`
        );
      } else if (result.ideOpenError) {
        message.warning(`Đã Apply vào AItest/. ${result.ideOpenError}`);
      } else {
        message.success("Đã Apply vào AItest/");
      }
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Apply thất bại");
    } finally {
      onBusy(false);
    }
  }

  return (
    <Card title="3. Verify & Apply (Agent Staging)" style={{ marginTop: 8 }}>
      <Steps
        size="small"
        current={stepIndex}
        style={{ marginBottom: 16 }}
        items={[
          { title: "Generated" },
          { title: "Verify" },
          { title: verify?.overallPass ? "Pass" : manifest.status === "fail" ? "Fail" : "Result" },
          { title: "Apply" },
        ]}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="Verify trên Agent Staging"
        description="File được ghi tạm vào đúng path trong repo để chạy lệnh, sau đó rollback — repo không đổi cho đến khi bạn Apply."
      />

      <Space orientation="vertical" size={10} style={{ width: "100%" }}>
        <div>
          <Typography.Text strong>Compile (tuỳ chọn)</Typography.Text>
          <Input
            style={{ marginTop: 4 }}
            value={compileCmd}
            onChange={(e) => setCompileCmd(e.target.value)}
            placeholder="vd. dotnet build — để trống nếu không cần"
          />
        </div>
        <div>
          <Typography.Text strong>Test</Typography.Text>
          <Input
            style={{ marginTop: 4 }}
            value={testCmd}
            onChange={(e) => setTestCmd(e.target.value)}
            placeholder="vd. pytest tests/..."
          />
        </div>
        {coverageCmd ? (
          <Checkbox checked={runCoverage} onChange={(e) => setRunCoverage(e.target.checked)}>
            Chạy coverage: <Typography.Text code>{coverageCmd}</Typography.Text>
          </Checkbox>
        ) : null}

        <Space wrap>
          <Button
            type={canApply || applied ? "default" : "primary"}
            icon={<PlayCircleOutlined />}
            onClick={() => void onVerify()}
            loading={busy}
            disabled={!isTauri() || applied || !testCmd.trim()}
          >
            Chạy Verify
          </Button>
          <Button
            type={canApply ? "primary" : "default"}
            icon={<SaveOutlined />}
            disabled={!canApply || busy || applied}
            onClick={() => setApplyOpen(true)}
          >
            Apply vào source
          </Button>
          <Button
            icon={<ToolOutlined />}
            disabled={manifest.status !== "fail" || busy || repairing || !onRepair}
            loading={repairing}
            onClick={() => onRepair?.()}
          >
            Repair with AI
          </Button>
          {manifest.status === "pass" ? (
            <Tag icon={<CheckCircleOutlined />} color="success">
              VERIFY PASS
            </Tag>
          ) : null}
          {manifest.status === "fail" ? (
            <Tag icon={<CloseCircleOutlined />} color="error">
              VERIFY FAIL
            </Tag>
          ) : null}
          {applied ? <Tag color="blue">Đã Apply</Tag> : null}
        </Space>
      </Space>

      {applied && testCmd.trim() ? (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 12 }}
          message="Đã ghi test vào repo (AItest/)"
          description={
            <>
              {lastOpenedInIde.length ? (
                <Typography.Paragraph style={{ marginBottom: 8 }}>
                  Đã mở trong IDE:{" "}
                  {lastOpenedInIde.map((p) => (
                    <Typography.Text code key={p} style={{ marginRight: 6 }}>
                      {p}
                    </Typography.Text>
                  ))}
                </Typography.Paragraph>
              ) : null}
              Chạy full suite trên{" "}
              <Link to={`/run?cmd=${encodeURIComponent(testCmd.trim())}`}>Chạy test</Link> — lệnh
              gợi ý giống bước Verify.
            </>
          }
        />
      ) : null}

      {verify?.stages?.length ? (
        <Collapse
          style={{ marginTop: 12 }}
          items={verify.stages.map((s) => ({
            key: s.stage,
            label: (
              <Space>
                <Tag color={s.success ? "success" : "error"}>{s.stage.toUpperCase()}</Tag>
                <Typography.Text code style={{ fontSize: 12 }}>
                  {s.command || "(skip)"}
                </Typography.Text>
                <Typography.Text type="secondary">exit {s.exitCode}</Typography.Text>
              </Space>
            ),
            children: (
              <pre className="code" style={{ maxHeight: 280, margin: 0 }}>
                {s.logExcerpt || "(không có log)"}
              </pre>
            ),
          }))}
        />
      ) : null}

      <Modal
        title="Apply thay đổi vào repo?"
        open={applyOpen}
        onCancel={() => setApplyOpen(false)}
        onOk={() => void onApplyConfirm()}
        okText="Apply"
        confirmLoading={busy}
      >
        <Typography.Paragraph>
          Ghi <strong>{manifest.files.length}</strong> file vào{" "}
          <Typography.Text code>AItest/</Typography.Text> (path phẳng, path jail).
          {ideConnected
            ? " IDE đang connected — sẽ mở file test sau Apply."
            : " Connect IDE để tự mở file sau Apply."}
        </Typography.Paragraph>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {manifest.files.map((f) => (
            <li key={f.targetRel}>
              <Typography.Text code>
                {f.op === "new" ? "+" : f.op === "modify" ? "~" : "-"} {f.targetRel}
              </Typography.Text>
            </li>
          ))}
        </ul>
      </Modal>
    </Card>
  );
}
