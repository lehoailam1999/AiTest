import { useEffect, useMemo, useRef, useState } from "react";
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
  Tabs,
  Tag,
  Typography,
} from "antd";
import type { StepsProps } from "antd";
import { DeleteOutlined, CheckCircleOutlined, CloseCircleOutlined, PlayCircleOutlined, ToolOutlined, SaveOutlined, SettingOutlined } from "@ant-design/icons";
import { Link } from "react-router-dom";
import { applyWorkspaceToRepo } from "../../lib/unitWorkspace/applyManager";
import { discardWorkspaceRun } from "../../lib/unitWorkspace/discardManager";
import { runWorkspaceVerify } from "../../lib/unitWorkspace/verifyEngine";
import {
  AUTO_REPAIR_MAX_ATTEMPTS,
  runVerifyWithAutoRepair,
} from "../../lib/unitWorkspace/autoRepairLoop";
import type { UnitWorkspaceManifest, VerifyStageName } from "../../lib/unitWorkspace/types";
import {
  formatDurationMs,
  parseTestRunSummary,
} from "../../lib/unitWorkspace/parseTestRunSummary";
import { suggestWorkspaceVerifyCommands } from "../../lib/stackHints";
import type { ProjectMeta, StackInspect } from "../../api/types";
import { isTauri } from "../../tauri/bridge";
import { AITEST_ROOT } from "../../lib/testOutputLayout";

export const VERIFY_APPLY_CONSOLE_ID = "aitest-verify-apply-console";

export type VerifyApplyConsoleProps = {
  manifest: UnitWorkspaceManifest;
  projectRoot: string;
  language?: string | null;
  framework?: string | null;
  meta?: ProjectMeta | null;
  stackInspect?: StackInspect | null;
  busy: boolean;
  repairing?: boolean;
  /** Highlight Chạy Verify after generate */
  suggestVerify?: boolean;
  onBusy: (v: boolean) => void;
  onManifestChange: (m: UnitWorkspaceManifest) => void;
  onRepair?: () => void | Promise<void>;
  onRepairAsync?: (manifest: UnitWorkspaceManifest) => Promise<UnitWorkspaceManifest>;
};

type PipeKey = "staging" | VerifyStageName | "repair" | "apply";

function stageStatus(
  key: PipeKey,
  manifest: UnitWorkspaceManifest,
  runCoverage: boolean,
  hasCompile: boolean,
  autoRepairing: boolean,
  busy: boolean
): { status: StepsProps["status"]; description?: string } {
  const stages = manifest.verify?.stages || [];
  const find = (name: VerifyStageName) => stages.find((s) => s.stage === name);
  const applied = manifest.status === "applied";
  const verifying = manifest.status === "verifying" || (busy && !autoRepairing);

  if (key === "staging") {
    const n = manifest.files.filter((f) => f.op !== "delete").length;
    return {
      status: n > 0 ? "finish" : "wait",
      description: n > 0 ? `${n} file` : "Chưa có",
    };
  }
  if (key === "compile") {
    if (!hasCompile) return { status: "finish", description: "Bỏ qua" };
    const s = find("compile");
    if (s) {
      return {
        status: s.success ? "finish" : "error",
        description: formatDurationMs(s.durationMs),
      };
    }
    if (verifying) return { status: "process", description: "…" };
    return { status: "wait" };
  }
  if (key === "test") {
    const s = find("test");
    if (s) {
      return {
        status: s.success ? "finish" : "error",
        description: formatDurationMs(s.durationMs),
      };
    }
    if (verifying) return { status: "process", description: "Đang chạy" };
    return { status: "wait" };
  }
  if (key === "coverage") {
    if (!runCoverage) return { status: "finish", description: "Tắt" };
    const s = find("coverage");
    if (s) {
      return {
        status: s.success ? "finish" : "error",
        description: formatDurationMs(s.durationMs),
      };
    }
    if (verifying && find("test")?.success) return { status: "process" };
    return { status: "wait" };
  }
  if (key === "repair") {
    if (autoRepairing) {
      return {
        status: "process",
        description: manifest.autoRepairAttempts
          ? `Lần ${manifest.autoRepairAttempts}`
          : "…",
      };
    }
    if (manifest.status === "fail" && (manifest.autoRepairAttempts || manifest.repairAttempts)) {
      return {
        status: "error",
        description: `${manifest.autoRepairAttempts || manifest.repairAttempts}×`,
      };
    }
    if (manifest.status === "pass" && (manifest.autoRepairAttempts || 0) > 1) {
      return { status: "finish", description: "Đã sửa" };
    }
    return { status: "wait", description: "Khi fail" };
  }
  if (key === "apply") {
    if (applied) return { status: "finish", description: "Xong" };
    if (manifest.status === "pass") return { status: "process", description: "Sẵn sàng" };
    return { status: "wait" };
  }
  return { status: "wait" };
}

function runnerSummaryLabel(
  framework: string | null | undefined,
  testCmd: string,
  stackInspect?: StackInspect | null
): string {
  const fw = (framework || "").toLowerCase();
  const cmd = testCmd.toLowerCase();
  if (cmd.includes("aitest/jest.config") || cmd.includes("jest")) return "Jest · AItest config";
  if (fw.includes("vitest") || cmd.includes("vitest")) return "Vitest";
  if (fw.includes("pytest") || cmd.includes("pytest")) return "pytest";
  if (cmd.includes("dotnet")) return "dotnet test";
  if (cmd.includes("go test")) return "go test";
  if (stackInspect?.framework) return String(stackInspect.framework);
  return testCmd.trim() ? "Lệnh test đã chọn" : "Chưa có lệnh test";
}

/**
 * U5 — Verify / Apply console: pipeline sống, summary có cấu trúc, Apply gate, lệnh nâng cao.
 */
export function VerifyApplyConsole({
  manifest,
  projectRoot,
  language,
  framework,
  meta,
  stackInspect,
  busy,
  repairing = false,
  suggestVerify = false,
  onBusy,
  onManifestChange,
  onRepair,
  onRepairAsync,
}: VerifyApplyConsoleProps) {
  const { message, modal } = App.useApp();
  const logAnchorRef = useRef<HTMLDivElement | null>(null);
  const [autoRepairing, setAutoRepairing] = useState(false);
  const [applyOpen, setApplyOpen] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [activeLogStage, setActiveLogStage] = useState<string>("test");

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
        stackInspect,
      }),
    [language, framework, meta, targetPaths, manifest.packagePrefix, stackInspect]
  );

  const [compileCmd, setCompileCmd] = useState(hints.compile);
  const [testCmd, setTestCmd] = useState(hints.test);
  const [coverageCmd, setCoverageCmd] = useState(hints.coverage);
  const [runCoverage, setRunCoverage] = useState(Boolean(hints.coverage));

  useEffect(() => {
    setCompileCmd(hints.compile);
    setTestCmd(hints.test);
    setCoverageCmd(hints.coverage);
    setRunCoverage(Boolean(hints.coverage));
  }, [hints.compile, hints.test, hints.coverage, manifest.runId]);

  const verify = manifest.verify;
  const canApply = manifest.status === "pass" && isTauri();
  const applied = manifest.status === "applied";
  const summary = useMemo(
    () =>
      parseTestRunSummary({
        stages: verify?.stages,
        framework,
        language,
      }),
    [verify?.stages, framework, language]
  );

  const showRepairStep =
    autoRepairing ||
    manifest.status === "fail" ||
    (manifest.autoRepairAttempts || 0) > 0 ||
    (manifest.repairAttempts || 0) > 0;

  const pipeKeys = useMemo(() => {
    const keys: PipeKey[] = ["staging", "compile", "test"];
    if (runCoverage || verify?.stages?.some((s) => s.stage === "coverage")) keys.push("coverage");
    if (showRepairStep) keys.push("repair");
    keys.push("apply");
    return keys;
  }, [runCoverage, verify?.stages, showRepairStep]);

  const pipeItems: StepsProps["items"] = pipeKeys.map((key) => {
    const st = stageStatus(
      key,
      manifest,
      runCoverage,
      Boolean(compileCmd.trim()),
      autoRepairing,
      busy
    );
    const titles: Record<PipeKey, string> = {
      staging: "Staging",
      compile: "Compile",
      test: "Test",
      coverage: "Coverage",
      repair: "Repair",
      apply: "Apply",
    };
    return {
      title: titles[key],
      status: st.status,
      description: st.description,
      onClick: () => {
        if (key === "compile" || key === "test" || key === "coverage") {
          setActiveLogStage(key);
          logAnchorRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
        }
      },
      style: { cursor: "pointer" },
    };
  });

  const currentPipeIndex = useMemo(() => {
    if (applied) return pipeKeys.length - 1;
    if (autoRepairing) return Math.max(0, pipeKeys.indexOf("repair"));
    if (manifest.status === "verifying" || (busy && !autoRepairing)) {
      const t = pipeKeys.indexOf("test");
      return t >= 0 ? t : 1;
    }
    if (manifest.status === "pass") return pipeKeys.indexOf("apply");
    if (manifest.status === "fail") {
      const r = pipeKeys.indexOf("repair");
      return r >= 0 ? r : pipeKeys.indexOf("test");
    }
    return 0;
  }, [applied, autoRepairing, busy, manifest.status, pipeKeys]);

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
      if (next.verify?.overallPass) {
        const sync = next.verify.coverageSync;
        if (sync && sync.uploaded > 0) {
          const bits = [
            sync.linePct != null ? `coverage ${sync.linePct}%` : null,
            sync.junit?.tests != null
              ? `junit ${sync.junit.passed ?? 0}/${sync.junit.tests}`
              : null,
          ].filter(Boolean);
          message.success(
            bits.length ? `Verify PASS · sync ${bits.join(" · ")}` : "Verify PASS · đã sync báo cáo"
          );
        } else {
          message.success("Verify PASS");
        }
      } else message.warning("Verify FAIL — dùng Auto-Repair hoặc Repair with AI");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Verify thất bại");
    } finally {
      onBusy(false);
    }
  }

  async function onVerifyAutoRepair() {
    if (!isTauri() || !onRepairAsync) return;
    onBusy(true);
    setAutoRepairing(true);
    try {
      const result = await runVerifyWithAutoRepair({
        projectRoot,
        manifest,
        compileCommand: compileCmd,
        testCommand: testCmd,
        coverageCommand: runCoverage ? coverageCmd : "",
        maxAttempts: AUTO_REPAIR_MAX_ATTEMPTS,
        repair: onRepairAsync,
        onProgress: (p) => {
          if (p.phase === "repair" || p.phase === "verify") {
            message.loading({ content: p.message, key: "auto-repair", duration: 0 });
          }
        },
      });
      onManifestChange({
        ...result.manifest,
        autoRepairAttempts: result.attempts,
      });
      message.destroy("auto-repair");
      if (result.passed) {
        const base = result.repaired
          ? `Verify PASS sau Auto-Repair (${result.attempts} lần)`
          : "Verify PASS";
        message.success(base);
      } else {
        message.error(
          `Vẫn FAIL sau ${result.attempts} lần Verify (max ${AUTO_REPAIR_MAX_ATTEMPTS})`
        );
      }
    } catch (e) {
      message.destroy("auto-repair");
      message.error(e instanceof Error ? e.message : "Auto-Repair thất bại");
    } finally {
      setAutoRepairing(false);
      onBusy(false);
    }
  }

  async function onApplyConfirm() {
    onBusy(true);
    try {
      const result = await applyWorkspaceToRepo(projectRoot, manifest);
      onManifestChange(result.manifest);
      setApplyOpen(false);
      message.success(
        result.stagingCleaned
          ? `Đã Apply ${result.appliedPaths.length} file vào AItest/ · đã dọn .ai-test/workspace`
          : `Đã Apply ${result.appliedPaths.length} file vào AItest/`
      );
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Apply thất bại");
    } finally {
      onBusy(false);
    }
  }

  async function onDiscard() {
    modal.confirm({
      title: "Không Apply · Hủy bỏ Unit Job này?",
      content:
        "Xóa file đã gen dưới AItest/ (nếu còn trên đĩa) và dọn staging. Không ghi Apply. Production src không bị đụng.",
      okText: "Hủy bỏ & xóa file gen",
      okType: "danger",
      onOk: async () => {
        onBusy(true);
        try {
          const res = await discardWorkspaceRun(
            projectRoot,
            manifest.runId,
            manifest.packagePrefix
          );
          onManifestChange({
            ...manifest,
            status: "discarded",
            files: [],
          });
          message.success(
            `Đã hủy job · xóa ${res.removedTargets.length} file trên AItest/ (nếu có)`
          );
        } catch (e) {
          message.error(e instanceof Error ? e.message : "Hủy bỏ thất bại");
          throw e;
        } finally {
          onBusy(false);
        }
      },
    });
  }

  const aitestHint = manifest.packagePrefix
    ? `${manifest.packagePrefix}/${AITEST_ROOT}/`
    : `${AITEST_ROOT}/`;

  const isJestLike =
    /jest/i.test(testCmd) ||
    (framework || "").toLowerCase().includes("jest");

  return (
    <Card
      id={VERIFY_APPLY_CONSOLE_ID}
      title="3. Verify & Apply"
      style={{ marginTop: 8 }}
      extra={
        suggestVerify && !applied && manifest.status !== "pass" ? (
          <Tag color="processing">Tiếp theo: Chạy Verify</Tag>
        ) : null
      }
    >
      {!isTauri() ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          title="Verify / Apply cần ứng dụng Desktop (Tauri)"
        />
      ) : null}

      <Steps
        size="small"
        current={Math.max(0, currentPipeIndex)}
        style={{ marginBottom: 16 }}
        items={pipeItems}
      />

      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="Verify trên staging · Apply chỉ ghi AItest/"
        description={
          stackInspect?.is_monorepo_package
            ? `Monorepo · ${stackInspect.workspace_kind || "package"} · ${stackInspect.package_name || manifest.packageName || manifest.packagePrefix} — lệnh test khoanh vùng package. Sau Apply dọn .ai-test/workspace.`
            : `Staging tạm rồi rollback cho đến Apply. Apply ghi ${aitestHint} trên disk — không đụng src production. Sau Apply dọn .ai-test/workspace.`
        }
      />

      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 12,
          alignItems: "center",
          marginBottom: 12,
          padding: "10px 12px",
          background: "var(--ant-color-fill-quaternary, #fafafa)",
          borderRadius: 8,
        }}
      >
        <div style={{ flex: 1, minWidth: 180 }}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            Runner
          </Typography.Text>
          <div>
            <Typography.Text strong>
              {runnerSummaryLabel(framework, testCmd, stackInspect)}
            </Typography.Text>
          </div>
        </div>
        {coverageCmd ? (
          <Checkbox checked={runCoverage} onChange={(e) => setRunCoverage(e.target.checked)}>
            Coverage
          </Checkbox>
        ) : null}
        <Button
          type="link"
          icon={<SettingOutlined />}
          onClick={() => setShowAdvanced((v) => !v)}
        >
          {showAdvanced ? "Ẩn lệnh" : "Sửa lệnh"}
        </Button>
      </div>

      {showAdvanced ? (
        <Space orientation="vertical" size={10} style={{ width: "100%", marginBottom: 12 }}>
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
              placeholder="vd. pytest · npx vitest run · jest"
            />
          </div>
          {coverageCmd ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Coverage: <Typography.Text code>{coverageCmd}</Typography.Text>
            </Typography.Text>
          ) : null}
          {isJestLike ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              Jest: scaffold AItest/tsconfig + jest.config được làm mới mỗi lần Verify.
            </Typography.Text>
          ) : null}
        </Space>
      ) : null}

      <Space wrap style={{ marginBottom: 12 }}>
        <Button
          type={canApply || applied ? "default" : "primary"}
          icon={<PlayCircleOutlined />}
          onClick={() => void onVerify()}
          loading={busy && !autoRepairing}
          disabled={!isTauri() || applied || !testCmd.trim() || autoRepairing}
        >
          Chạy Verify
        </Button>
        <Button
          icon={<ToolOutlined />}
          onClick={() => void onVerifyAutoRepair()}
          loading={autoRepairing}
          disabled={
            !isTauri() ||
            applied ||
            !testCmd.trim() ||
            busy ||
            repairing ||
            !onRepairAsync
          }
        >
          Verify + Auto-Repair
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
          danger
          icon={<DeleteOutlined />}
          disabled={!isTauri() || busy || applied || manifest.status === "discarded"}
          onClick={() => void onDiscard()}
        >
          Không Apply · Hủy bỏ
        </Button>
        <Button
          icon={<ToolOutlined />}
          disabled={manifest.status !== "fail" || busy || repairing || !onRepair}
          loading={repairing}
          onClick={() => void onRepair?.()}
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
            {manifest.autoRepairAttempts
              ? ` · ${manifest.autoRepairAttempts}×`
              : manifest.repairAttempts
                ? ` · repair ${manifest.repairAttempts}`
                : ""}
          </Tag>
        ) : null}
        {applied ? <Tag color="blue">Đã Apply</Tag> : null}
      </Space>

      {manifest.status === "fail" ? (
        <Alert
          type="error"
          showIcon
          style={{ marginBottom: 12 }}
          title="Verify FAIL"
          description="Ưu tiên Verify + Auto-Repair (tối đa 3 lần). Hoặc Repair with AI rồi Verify lại. Có thể sửa lệnh test ở «Sửa lệnh»."
          action={
            onRepairAsync ? (
              <Button
                size="small"
                type="primary"
                danger
                loading={autoRepairing}
                onClick={() => void onVerifyAutoRepair()}
              >
                Auto-Repair
              </Button>
            ) : null
          }
        />
      ) : null}

      {autoRepairing ? (
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          title={`Auto-Repair · ${manifest.autoRepairAttempts || "…"}/${AUTO_REPAIR_MAX_ATTEMPTS}`}
          description="Đang verify → repair → verify lại trên staging."
        />
      ) : null}

      {canApply ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          title="Sẵn sàng Apply"
          description={
            <>
              Sẽ ghi <strong>{targetPaths.length}</strong> file dưới{" "}
              <Typography.Text code>{aitestHint}</Typography.Text>
              {" · "}
              không đụng production src · sau Apply dọn staging.
              <div style={{ marginTop: 8 }}>
                {targetPaths.slice(0, 5).map((p) => (
                  <div key={p}>
                    <Typography.Text code style={{ fontSize: 12 }}>
                      {p}
                    </Typography.Text>
                  </div>
                ))}
                {targetPaths.length > 5 ? (
                  <Typography.Text type="secondary">
                    … +{targetPaths.length - 5} file
                  </Typography.Text>
                ) : null}
              </div>
            </>
          }
        />
      ) : null}

      {applied ? (
        <Alert
          type="success"
          showIcon
          style={{ marginBottom: 12 }}
          title="Đã ghi test vào repo (AItest/)"
          description={
            <>
              {targetPaths.map((p) => (
                <Typography.Text code key={p} style={{ marginRight: 6 }}>
                  {p}
                </Typography.Text>
              ))}
              <br />
              Chạy full suite trên{" "}
              <Link to={`/run?cmd=${encodeURIComponent(testCmd.trim())}`}>Chạy test</Link>
              {" · "}staging job đã được dọn (nếu cleanup thành công).
            </>
          }
        />
      ) : null}

      {verify?.stages?.length ? (
        <div ref={logAnchorRef}>
          <Space wrap style={{ marginBottom: 8 }}>
            {summary.hasCounts ? (
              <>
                <Tag color="success">{summary.passed} passed</Tag>
                <Tag color={summary.failed ? "error" : "default"}>{summary.failed} failed</Tag>
                {summary.skipped > 0 ? <Tag>{summary.skipped} skipped</Tag> : null}
                <Tag>{summary.total} total</Tag>
              </>
            ) : (
              <Tag>{verify.overallPass ? "PASS" : "FAIL"}</Tag>
            )}
            <Tag>{summary.runnerLabel}</Tag>
            <Typography.Text type="secondary">
              {formatDurationMs(summary.durationMs)}
            </Typography.Text>
          </Space>

          {summary.failedNames.length > 0 ? (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 8 }}
              title="Test fail (trích từ log)"
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {summary.failedNames.map((n) => (
                    <li key={n}>
                      <Typography.Text style={{ fontSize: 13 }}>{n}</Typography.Text>
                    </li>
                  ))}
                </ul>
              }
            />
          ) : null}

          <Tabs
            size="small"
            activeKey={activeLogStage === "summary" ? "summary" : "full"}
            onChange={(k) => setActiveLogStage(k === "summary" ? "summary" : "test")}
            items={[
              {
                key: "summary",
                label: "Tóm tắt",
                children: (
                  <Space orientation="vertical" size={8} style={{ width: "100%" }}>
                    {verify.stages.map((s) => (
                      <div key={s.stage}>
                        <Tag color={s.success ? "success" : "error"}>{s.stage}</Tag>
                        <Typography.Text type="secondary" style={{ marginLeft: 8 }}>
                          exit {s.exitCode} · {formatDurationMs(s.durationMs)}
                        </Typography.Text>
                        <div>
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {s.command || "(skip)"}
                          </Typography.Text>
                        </div>
                      </div>
                    ))}
                  </Space>
                ),
              },
              {
                key: "full",
                label: "Đầy đủ",
                children: (
                  <Collapse
                    activeKey={activeLogStage === "summary" ? undefined : [activeLogStage]}
                    onChange={(keys) => {
                      const k = Array.isArray(keys) ? keys[0] : keys;
                      if (k) setActiveLogStage(String(k));
                    }}
                    items={verify.stages.map((s) => ({
                      key: s.stage,
                      label: (
                        <Space>
                          <Tag color={s.success ? "success" : "error"}>
                            {s.stage.toUpperCase()}
                          </Tag>
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {s.command || "(skip)"}
                          </Typography.Text>
                          <Typography.Text type="secondary">
                            exit {s.exitCode} · {formatDurationMs(s.durationMs)}
                          </Typography.Text>
                        </Space>
                      ),
                      children: (
                        <pre className="code" style={{ maxHeight: 280, margin: 0 }}>
                          {s.logExcerpt || "(không có log)"}
                        </pre>
                      ),
                    }))}
                  />
                ),
              },
            ]}
          />
        </div>
      ) : (
        <Alert
          type="info"
          showIcon
          style={{ marginTop: 4 }}
          title="Chưa chạy Verify"
          description="Bấm Chạy Verify để compile/test trên staging. PASS xong mới Apply vào AItest/."
        />
      )}

      {verify?.coverageSync && verify.coverageSync.uploaded > 0 ? (
        <Alert
          type="success"
          showIcon
          style={{ marginTop: 12 }}
          title="Đã đồng bộ coverage / JUnit → PostgreSQL"
          description={
            <Space wrap size={8}>
              {verify.coverageSync.linePct != null ? (
                <Tag color="blue">Line {verify.coverageSync.linePct}%</Tag>
              ) : null}
              {verify.coverageSync.junit?.tests != null ? (
                <Tag color="geekblue">
                  JUnit {verify.coverageSync.junit.passed ?? 0}/{verify.coverageSync.junit.tests}
                </Tag>
              ) : null}
              <Link to="/reports">Reports</Link>
            </Space>
          }
        />
      ) : null}

      <Modal
        title="Apply vào AItest/?"
        open={applyOpen}
        onCancel={() => setApplyOpen(false)}
        onOk={() => void onApplyConfirm()}
        okText="Apply"
        confirmLoading={busy}
      >
        <Typography.Paragraph>
          Ghi <strong>{targetPaths.length}</strong> file dưới{" "}
          <Typography.Text code>{aitestHint}</Typography.Text>. Không đụng production src. Sau
          Apply, staging <Typography.Text code>.ai-test/workspace</Typography.Text> sẽ được dọn.
        </Typography.Paragraph>
        <ul style={{ margin: 0, paddingLeft: 20 }}>
          {manifest.files
            .filter((f) => f.op !== "delete")
            .map((f) => (
              <li key={f.targetRel}>
                <Typography.Text code>
                  {f.op === "new" ? "+" : "~"} {f.targetRel}
                </Typography.Text>
              </li>
            ))}
        </ul>
      </Modal>
    </Card>
  );
}
