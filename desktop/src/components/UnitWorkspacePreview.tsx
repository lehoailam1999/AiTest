import type { ReactNode } from "react";
import { CheckOutlined, FileAddOutlined, FileOutlined, EditOutlined } from "@ant-design/icons";
import { Alert, Card, List, Space, Tag, Typography } from "antd";
import type { UnitWorkspaceManifest, WorkspacePreviewFile } from "../lib/unitWorkspace/types";
import { groupFilesByOp } from "../lib/unitWorkspace/manager";
import { aiTestDir } from "../lib/unitWorkspace/paths";

type Props = {
  manifest: UnitWorkspaceManifest;
  previews: WorkspacePreviewFile[];
  selectedTargetRel: string | null;
  onSelect: (targetRel: string) => void;
  projectRoot: string | null;
};

export function UnitWorkspacePreview({
  manifest,
  previews,
  selectedTargetRel,
  onSelect,
  projectRoot,
}: Props) {
  const { newFiles, modifiedFiles, deletedFiles } = groupFilesByOp(manifest);
  const selected =
    previews.find((p) => p.entry.targetRel === selectedTargetRel) ?? previews[0] ?? null;

  const sections: { key: string; title: string; icon: ReactNode; color: string; items: typeof newFiles }[] =
    [
      { key: "new", title: "New Files", icon: <FileAddOutlined />, color: "green", items: newFiles },
      {
        key: "mod",
        title: "Modified Files",
        icon: <EditOutlined />,
        color: "gold",
        items: modifiedFiles,
      },
      {
        key: "del",
        title: "Deleted Files",
        icon: <FileOutlined />,
        color: "red",
        items: deletedFiles,
      },
    ];

  return (
    <Card
      title="2. Staging preview"
      style={{ marginTop: 8 }}
      extra={
        <Space size={8} wrap>
          <Tag color="blue">run: {manifest.runId}</Tag>
          <Tag>{manifest.status}</Tag>
        </Space>
      }
    >
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        title="File staging — chưa ghi vào source"
        description={
          <>
            Thư mục tạm{" "}
            <Typography.Text code>
              {aiTestDir(manifest.packagePrefix)}/workspace/{manifest.runId}/
            </Typography.Text>
            {" — "}
            chạy <strong>Verify</strong> trước khi <strong>Apply</strong> vào package
            {manifest.packagePrefix ? (
              <>
                {" "}
                (<Typography.Text code>{manifest.packagePrefix}/AItest/</Typography.Text>)
              </>
            ) : (
              <>
                {" "}
                (<Typography.Text code>AItest/</Typography.Text>)
              </>
            )}
            . Không đặt AItest/.ai-test ở root monorepo khi source thuộc BE/FE. IDE không bắt buộc.
          </>
        }
      />
      <div className="unit-workspace-layout">
        <div className="unit-workspace-files">
          {sections.map((sec) =>
            sec.items.length === 0 ? null : (
              <div key={sec.key} style={{ marginBottom: 12 }}>
                <Typography.Text strong>
                  {sec.icon} {sec.title} ({sec.items.length})
                </Typography.Text>
                <List
                  size="small"
                  style={{ marginTop: 6 }}
                  dataSource={sec.items}
                  renderItem={(item) => {
                    const active = item.targetRel === (selected?.entry.targetRel ?? "");
                    return (
                      <List.Item
                        className={active ? "unit-ws-file-active" : "unit-ws-file"}
                        onClick={() => onSelect(item.targetRel)}
                        style={{ cursor: "pointer", padding: "6px 8px", borderRadius: 6 }}
                      >
                        <Space>
                          <CheckOutlined style={{ color: "var(--ant-color-success)" }} />
                          <Typography.Text code style={{ fontSize: 12 }}>
                            {item.targetRel}
                          </Typography.Text>
                          <Tag color={sec.color} style={{ margin: 0 }}>
                            {item.op}
                          </Tag>
                        </Space>
                      </List.Item>
                    );
                  }}
                />
              </div>
            )
          )}
        </div>

        <div className="unit-workspace-preview">
          {selected ? (
            <>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Preview · {selected.entry.targetRel}
                {selected.entry.op === "modify" && selected.baseContent != null
                  ? " (nội dung staging; source gốc vẫn trên đĩa)"
                  : null}
              </Typography.Text>
              <pre className="code" style={{ marginTop: 8, maxHeight: 420 }}>
                {selected.content}
              </pre>
            </>
          ) : (
            <Typography.Text type="secondary">Chọn file để xem preview.</Typography.Text>
          )}
        </div>
      </div>
    </Card>
  );
}
