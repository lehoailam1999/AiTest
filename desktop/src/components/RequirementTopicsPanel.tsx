import { useCallback, useEffect, useState } from "react";
import {
  App,
  Button,
  Card,
  Empty,
  Input,
  List,
  Space,
  Typography,
} from "antd";
import { DeleteOutlined, PlusOutlined, SaveOutlined } from "@ant-design/icons";
import { requirements } from "../api";
import type { RequirementTopic, RequirementTopicItem } from "../lib/requirementTopics";
import {
  emptyTopic,
  emptyTopicItem,
  newTopicId,
} from "../lib/requirementTopics";

type Props = {
  requirementId: string;
  initialTopics?: RequirementTopic[];
  onSaved?: (topics: RequirementTopic[]) => void;
};

export function RequirementTopicsPanel({
  requirementId,
  initialTopics = [],
  onSaved,
}: Props) {
  const { message } = App.useApp();
  const [topics, setTopics] = useState<RequirementTopic[]>(initialTopics);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setTopics(initialTopics);
    setDirty(false);
  }, [requirementId, initialTopics]);

  const markDirty = useCallback((next: RequirementTopic[]) => {
    setTopics(next);
    setDirty(true);
  }, []);

  async function save() {
    const valid = topics.filter((t) => t.title.trim());
    setSaving(true);
    try {
      const res = await requirements.putTopics(requirementId, valid);
      setTopics(res.topics);
      setDirty(false);
      onSaved?.(res.topics);
      message.success("Đã lưu chủ đề & mục");
    } catch (e) {
      message.error(e instanceof Error ? e.message : "Lưu chủ đề thất bại");
    } finally {
      setSaving(false);
    }
  }

  function addTopic() {
    markDirty([...topics, emptyTopic("Chủ đề mới")]);
  }

  function updateTopic(id: string, patch: Partial<RequirementTopic>) {
    markDirty(topics.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function removeTopic(id: string) {
    markDirty(topics.filter((t) => t.id !== id));
  }

  function addItem(topicId: string) {
    markDirty(
      topics.map((t) =>
        t.id === topicId
          ? { ...t, items: [...t.items, emptyTopicItem("Mục mới")] }
          : t
      )
    );
  }

  function updateItem(
    topicId: string,
    itemId: string,
    patch: Partial<RequirementTopicItem>
  ) {
    markDirty(
      topics.map((t) =>
        t.id === topicId
          ? {
              ...t,
              items: t.items.map((it) =>
                it.id === itemId ? { ...it, ...patch } : it
              ),
            }
          : t
      )
    );
  }

  function removeItem(topicId: string, itemId: string) {
    markDirty(
      topics.map((t) =>
        t.id === topicId
          ? { ...t, items: t.items.filter((it) => it.id !== itemId) }
          : t
      )
    );
  }

  return (
    <Card
      size="small"
      title="Chủ đề & mục (Phase 1 — sinh TC theo phạm vi)"
      extra={
        <Button
          type="primary"
          size="small"
          icon={<SaveOutlined />}
          disabled={!dirty}
          loading={saving}
          onClick={() => void save()}
        >
          Lưu chủ đề
        </Button>
      }
      style={{ marginBottom: 12 }}
    >
      <Typography.Paragraph type="secondary" style={{ marginBottom: 12 }}>
        Chia requirement thành các chủ đề (module). Trong mỗi chủ đề thêm các mục cần cover — AI
        sinh test case theo chủ đề thay vì lẻ tẻ từng case.
      </Typography.Paragraph>

      {topics.length === 0 ? (
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description="Chưa có chủ đề — thêm chủ đề để sinh TC có cấu trúc."
        >
          <Button icon={<PlusOutlined />} onClick={addTopic}>
            Thêm chủ đề
          </Button>
        </Empty>
      ) : (
        <Space orientation="vertical" size="middle" style={{ width: "100%" }}>
          {topics.map((topic, idx) => (
            <Card
              key={topic.id || `t-${idx}`}
              size="small"
              type="inner"
              title={`Chủ đề ${idx + 1}`}
              extra={
                <Button
                  type="text"
                  danger
                  size="small"
                  icon={<DeleteOutlined />}
                  onClick={() => removeTopic(topic.id)}
                />
              }
            >
              <Space orientation="vertical" style={{ width: "100%" }} size="small">
                <Input
                  placeholder="Tên chủ đề / module (VD: Đăng nhập)"
                  value={topic.title}
                  onChange={(e) => updateTopic(topic.id, { title: e.target.value })}
                />
                <Input.TextArea
                  rows={2}
                  placeholder="Ghi chú chủ đề (tuỳ chọn)"
                  value={topic.notes ?? ""}
                  onChange={(e) => updateTopic(topic.id, { notes: e.target.value })}
                />
                <Typography.Text type="secondary">Các mục trong chủ đề</Typography.Text>
                <List
                  size="small"
                  dataSource={topic.items}
                  locale={{ emptyText: "Chưa có mục — thêm mục để AI cover từng phần." }}
                  renderItem={(item) => (
                    <List.Item
                      actions={[
                        <Button
                          key="del"
                          type="link"
                          danger
                          size="small"
                          onClick={() => removeItem(topic.id, item.id)}
                        >
                          Xoá
                        </Button>,
                      ]}
                    >
                      <Space orientation="vertical" style={{ width: "100%" }} size={4}>
                        <Input
                          size="small"
                          placeholder="Tên mục (VD: Sai mật khẩu 5 lần)"
                          value={item.title}
                          onChange={(e) =>
                            updateItem(topic.id, item.id, { title: e.target.value })
                          }
                        />
                        <Input
                          size="small"
                          placeholder="Ghi chú mục (tuỳ chọn)"
                          value={item.notes ?? ""}
                          onChange={(e) =>
                            updateItem(topic.id, item.id, { notes: e.target.value })
                          }
                        />
                      </Space>
                    </List.Item>
                  )}
                />
                <Button
                  size="small"
                  icon={<PlusOutlined />}
                  onClick={() => addItem(topic.id)}
                >
                  Thêm mục
                </Button>
              </Space>
            </Card>
          ))}
          <Button icon={<PlusOutlined />} onClick={addTopic}>
            Thêm chủ đề
          </Button>
        </Space>
      )}
    </Card>
  );
}

/** Gán id ổn định trước khi gửi job nếu thiếu */
export function topicScopeForJob(topic: RequirementTopic): RequirementTopic {
  return {
    ...topic,
    id: topic.id || newTopicId(),
    items: topic.items.map((it) => ({ ...it, id: it.id || newTopicId() })),
  };
}
