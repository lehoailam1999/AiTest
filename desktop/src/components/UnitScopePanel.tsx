import { Alert, Button, List, Space, Tag, Typography } from "antd";
import { ReloadOutlined, AimOutlined, CheckOutlined } from "@ant-design/icons";
import type { UnitContextPacket } from "../lib/projectIntelligence/types";
import { GENERATED_TEST_FOLDERS } from "../lib/testOutputLayout";

type Props = {
  packet: UnitContextPacket | null;
  loading: boolean;
  onRefresh: () => void;
  autoScopeEnabled: boolean;
  /** Chọn ứng viên khác → đọc file local (không lưu DB) */
  onPickCandidate?: (pathRel: string) => void;
  /** Thêm file vào danh sách liên quan (giữ primary) */
  onAddRelated?: (pathRel: string) => void;
  broadLocal?: boolean;
};

export function UnitScopePanel({
  packet,
  loading,
  onRefresh,
  autoScopeEnabled,
  onPickCandidate,
  onAddRelated,
  broadLocal,
}: Props) {
  if (!autoScopeEnabled) {
    return (
      <Alert
        type="info"
        showIcon
        title="Ghép TC ↔ mã nguồn (local)"
        description="Mở thư mục dự án ở Workspace (Desktop). App đọc file trên máy theo test case — không upload source lên server/DB."
      />
    );
  }

  if (!packet?.seed) {
    return (
      <Alert
        type="warning"
        showIcon
        title="Chưa khớp được file từ test case"
        description={
          <>
            Hệ thống ưu tiên khớp theo <strong>module / chức năng</strong> của TC với tên thư mục/file.
            Có thể ghi đường dẫn file trong bước TC (vd.{" "}
            <Typography.Text code>src/Foo/Bar.cs</Typography.Text>). Hoặc chọn file thủ công bên dưới.
          </>
        }
        action={
          <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
            Quét lại
          </Button>
        }
      />
    );
  }

  const deps = packet.related.filter((r) => r.role === "dependency");
  const alts = (packet.candidates ?? []).filter((c) => c.pathRel !== packet.primaryPath);
  const mentioned = packet.mentionedPaths ?? [];

  return (
    <div className="unit-scope-panel">
      <Space style={{ width: "100%", justifyContent: "space-between", marginBottom: 8 }}>
        <Typography.Text strong>
          <AimOutlined /> Scope từ TC (local)
        </Typography.Text>
        <Button size="small" icon={<ReloadOutlined />} onClick={onRefresh} loading={loading}>
          Quét lại
        </Button>
      </Space>

      <Alert
        type="success"
        showIcon
        style={{ marginBottom: 8 }}
        title={`File chính: ${packet.primaryPath}`}
        description={
          <>
            {packet.seed.reason}
            {broadLocal ? " · Đang đọc rộng theo module (local)." : ""}
            {" · "}
            File gen sẽ vào{" "}
            <Typography.Text code>AItest/{GENERATED_TEST_FOLDERS.unit}/{"{Module}/"}</Typography.Text>
          </>
        }
      />

      {mentioned.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">File được nhắc trong TC</Typography.Text>
          <List
            size="small"
            style={{ marginTop: 4 }}
            dataSource={mentioned}
            renderItem={(p) => (
              <List.Item
                style={{ padding: "4px 0" }}
                actions={
                  onPickCandidate || onAddRelated
                    ? [
                        ...(onPickCandidate
                          ? [
                              <Button
                                key="use"
                                type="link"
                                size="small"
                                onClick={() => onPickCandidate(p)}
                              >
                                Đặt làm chính
                              </Button>,
                            ]
                          : []),
                        ...(onAddRelated
                          ? [
                              <Button
                                key="add"
                                type="link"
                                size="small"
                                onClick={() => onAddRelated(p)}
                              >
                                Thêm liên quan
                              </Button>,
                            ]
                          : []),
                      ]
                    : undefined
                }
              >
                <Tag color="purple">tc</Tag>
                <Typography.Text code style={{ fontSize: 12 }}>
                  {p}
                </Typography.Text>
              </List.Item>
            )}
          />
        </div>
      ) : null}

      {alts.length > 0 ? (
        <div style={{ marginBottom: 12 }}>
          <Typography.Text type="secondary">
            Ứng viên khác (sai file? chọn đúng — chỉ đọc local):
          </Typography.Text>
          <List
            size="small"
            style={{ marginTop: 6 }}
            dataSource={alts.slice(0, 5)}
            renderItem={(item) => (
              <List.Item
                style={{ padding: "6px 0" }}
                actions={
                  onPickCandidate || onAddRelated
                    ? [
                        ...(onPickCandidate
                          ? [
                              <Button
                                key="use"
                                type="link"
                                size="small"
                                icon={<CheckOutlined />}
                                onClick={() => onPickCandidate(item.pathRel)}
                              >
                                Đặt làm chính
                              </Button>,
                            ]
                          : []),
                        ...(onAddRelated
                          ? [
                              <Button
                                key="add"
                                type="link"
                                size="small"
                                onClick={() => onAddRelated(item.pathRel)}
                              >
                                Thêm liên quan
                              </Button>,
                            ]
                          : []),
                      ]
                    : undefined
                }
              >
                <Space orientation="vertical" size={0} style={{ width: "100%" }}>
                  <Typography.Text code style={{ fontSize: 12 }}>
                    {item.pathRel}
                  </Typography.Text>
                  <Typography.Text type="secondary" style={{ fontSize: 11 }}>
                    điểm {item.score} · {item.reason}
                  </Typography.Text>
                </Space>
              </List.Item>
            )}
          />
        </div>
      ) : null}

      {deps.length > 0 ? (
        <>
          <Typography.Text type="secondary">
            File liên quan gửi kèm AI ({deps.length}
            {broadLocal ? ", chế độ rộng" : ""})
          </Typography.Text>
          <List
            size="small"
            style={{ marginTop: 4 }}
            dataSource={deps.slice(0, 20)}
            renderItem={(item) => (
              <List.Item
                style={{ padding: "4px 0" }}
                actions={
                  onPickCandidate
                    ? [
                        <Button
                          key="primary"
                          type="link"
                          size="small"
                          onClick={() => onPickCandidate(item.pathRel)}
                        >
                          Đặt làm chính
                        </Button>,
                      ]
                    : undefined
                }
              >
                <Tag color="blue">rel</Tag>
                <Typography.Text code style={{ fontSize: 12 }}>
                  {item.pathRel}
                </Typography.Text>
              </List.Item>
            )}
          />
          {deps.length > 20 ? (
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              … và {deps.length - 20} file khác
            </Typography.Text>
          ) : null}
        </>
      ) : (
        <Typography.Text type="secondary">
          Chưa có file liên quan thêm. Bật «Đọc rộng source local» hoặc ghi path trong bước TC.
        </Typography.Text>
      )}

      {packet.truncated.length > 0 ? (
        <Typography.Text type="warning" style={{ fontSize: 12, display: "block", marginTop: 8 }}>
          Đã cắt bớt context: {packet.truncated.slice(0, 3).join(", ")}
          {packet.truncated.length > 3 ? "…" : ""}
        </Typography.Text>
      ) : null}
    </div>
  );
}
