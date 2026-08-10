/**
 * Phase 4 — File tree + screenshot paths from IDE codegen callbacks.
 */
import { useEffect } from "react";
import { Button, Empty, List, Space, Tag, Typography } from "antd";
import { dispatchIdeCommand } from "../lib/ideBridge/commandBus";
import { useCodegenUiStore } from "../lib/ideProtocol/codegenUiStore";
import { isIdeCodegenReady } from "../lib/ideProtocol";

const { Text, Title } = Typography;

export function CodegenResultPanel(props?: { title?: string }) {
  const files = useCodegenUiStore((s) => s.files);
  const runReport = useCodegenUiStore((s) => s.runReport);
  const status = useCodegenUiStore((s) => s.status);
  const progressMessage = useCodegenUiStore((s) => s.progressMessage);
  const logExcerpt = useCodegenUiStore((s) => s.logExcerpt);
  const hydrate = useCodegenUiStore((s) => s.hydrateFromMemory);

  useEffect(() => {
    hydrate();
  }, [hydrate]);

  const bridgeOk = isIdeCodegenReady();

  if (!files.length && !runReport) {
    return (
      <Empty
        description={
          bridgeOk
            ? "Chưa có Apply/Run qua IDE Extension — chạy Apply hoặc Verify khi bridge connected."
            : "IDE bridge offline — kết nối Extension để xem cây file Apply/Run."
        }
      />
    );
  }

  return (
    <div style={{ padding: 12 }}>
      <Space direction="vertical" style={{ width: "100%" }} size="middle">
        <div>
          <Title level={5} style={{ margin: 0 }}>
            {props?.title || "IDE Codegen — File tree & kết quả"}
          </Title>
          <Space size="small" wrap>
            {status ? <Tag color={status === "COMPLETED" ? "green" : "orange"}>{status}</Tag> : null}
            {bridgeOk ? <Tag color="blue">bridge online</Tag> : <Tag>bridge offline</Tag>}
            {progressMessage ? <Text type="secondary">{progressMessage}</Text> : null}
          </Space>
        </div>

        {runReport ? (
          <Text>
            Run: passed={runReport.passed} failed={runReport.failed} skipped={runReport.skipped}{" "}
            ({runReport.durationMs}ms)
          </Text>
        ) : null}

        <List
          size="small"
          header={<Text strong>Generated files</Text>}
          bordered
          dataSource={files}
          locale={{ emptyText: "Không có file" }}
          renderItem={(item) => (
            <List.Item
              actions={[
                <Button
                  key="open"
                  type="link"
                  size="small"
                  onClick={() =>
                    void dispatchIdeCommand({ type: "ide.openFile", pathRel: item.path })
                  }
                >
                  Open
                </Button>,
              ]}
            >
              <Space>
                <Tag
                  color={
                    item.status === "CREATED" || item.status === "UPDATED"
                      ? "green"
                      : item.status === "REJECTED_JAIL"
                        ? "red"
                        : "default"
                  }
                >
                  {item.status}
                </Tag>
                <Text code>{item.path}</Text>
                {item.error ? <Text type="danger">{item.error}</Text> : null}
              </Space>
            </List.Item>
          )}
        />

        {runReport?.errors?.length ? (
          <List
            size="small"
            header={<Text strong>Errors / screenshots</Text>}
            bordered
            dataSource={runReport.errors}
            renderItem={(err) => (
              <List.Item
                actions={
                  err.screenshotPath
                    ? [
                        <Button
                          key="shot"
                          type="link"
                          size="small"
                          onClick={() =>
                            void dispatchIdeCommand({
                              type: "ide.openFile",
                              pathRel: err.screenshotPath!.replace(/\\/g, "/"),
                            })
                          }
                        >
                          Screenshot
                        </Button>,
                      ]
                    : undefined
                }
              >
                <Space direction="vertical" size={0}>
                  <Text>{err.title || "failure"}</Text>
                  <Text type="secondary" style={{ whiteSpace: "pre-wrap", fontSize: 12 }}>
                    {(err.stacktrace || "").slice(0, 600)}
                  </Text>
                </Space>
              </List.Item>
            )}
          />
        ) : null}

        {logExcerpt ? (
          <pre
            style={{
              maxHeight: 180,
              overflow: "auto",
              fontSize: 11,
              background: "var(--ant-color-fill-quaternary, #f5f5f5)",
              padding: 8,
              borderRadius: 6,
            }}
          >
            {logExcerpt.slice(0, 4000)}
          </pre>
        ) : null}
      </Space>
    </div>
  );
}
