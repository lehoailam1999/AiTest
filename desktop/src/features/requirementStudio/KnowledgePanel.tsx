/**
 * R3 Knowledge — tiêu chí đánh giá SRS sẵn sàng Sinh TC (master–detail).
 */
import { useEffect, useMemo, useState } from "react";
import { Alert, Button, Empty, List, Space, Tag, Typography } from "antd";
import { ReloadOutlined, ThunderboltOutlined } from "@ant-design/icons";
import type { KnowledgePayload, KnowledgeWorkspaceView } from "../../api/types";

type KnowledgePanelProps = {
  knowledge: KnowledgeWorkspaceView | null;
  loading?: boolean;
  building?: boolean;
  canBuild: boolean;
  onBuild: () => void;
  onRefresh: () => void;
  /** Navigate to Sinh test case (primary after Phân tích) */
  onOpenFreeze?: () => void;
};

type SectionKey =
  | "summary"
  | "features"
  | "actors"
  | "useCases"
  | "executionContexts"
  | "businessRules"
  | "validationRules"
  | "apiSummary"
  | "exceptions"
  | "acceptanceCriteria"
  | "constraints"
  | "gaps";

const SECTIONS: { key: SectionKey; label: string }[] = [
  { key: "summary", label: "Tóm tắt & phạm vi" },
  { key: "features", label: "Chức năng" },
  { key: "actors", label: "Actors & quyền" },
  { key: "useCases", label: "Luồng nghiệp vụ" },
  { key: "executionContexts", label: "Execution Context" },
  { key: "businessRules", label: "Business rules" },
  { key: "validationRules", label: "Validation & dữ liệu" },
  { key: "apiSummary", label: "API / giao diện" },
  { key: "exceptions", label: "Xử lý lỗi" },
  { key: "acceptanceCriteria", label: "Acceptance" },
  { key: "constraints", label: "Ràng buộc NFR" },
  { key: "gaps", label: "Thiếu sót" },
];

/** Criteria that strongly affect Generate TC quality */
const READINESS_KEYS: { key: SectionKey; label: string }[] = [
  { key: "features", label: "Chức năng" },
  { key: "useCases", label: "Luồng nghiệp vụ" },
  { key: "validationRules", label: "Validation" },
  { key: "acceptanceCriteria", label: "Acceptance" },
  { key: "gaps", label: "Thiếu sót" },
];

function sectionCount(payload: KnowledgePayload, key: SectionKey): number {
  if (key === "summary") return payload.summary?.trim() ? 1 : 0;
  if (key === "gaps") {
    const gaps = payload.gaps;
    if (Array.isArray(gaps) && gaps.length) return gaps.length;
    const legacy =
      (payload.openQuestions?.length ?? 0) + (payload.missingInformation?.length ?? 0);
    return legacy;
  }
  const list = payload[key];
  return Array.isArray(list) ? list.length : 0;
}

function gapsList(payload: KnowledgePayload): { text: string }[] {
  if (Array.isArray(payload.gaps) && payload.gaps.length) return payload.gaps;
  const out: { text: string }[] = [];
  for (const row of payload.openQuestions ?? []) {
    if (row?.text) out.push({ text: row.text });
  }
  for (const row of payload.missingInformation ?? []) {
    if (row?.text) out.push({ text: row.text });
  }
  return out;
}

export default function KnowledgePanel({
  knowledge,
  loading,
  building,
  canBuild,
  onBuild,
  onRefresh,
  onOpenFreeze,
}: KnowledgePanelProps) {
  const status = knowledge?.status ?? "empty";
  const enrichPending = Boolean(knowledge?.enrichPending);
  const payload = enrichPending ? null : knowledge?.payload;
  const [active, setActive] = useState<SectionKey>("summary");

  const nav = useMemo(() => {
    if (!payload) return [];
    return SECTIONS.map((s) => ({
      ...s,
      count: sectionCount(payload, s.key),
    }));
  }, [payload]);

  useEffect(() => {
    if (!payload) return;
    const prefer = nav.find((n) => n.key !== "summary" && n.count > 0);
    if (prefer && sectionCount(payload, "summary") === 0) setActive(prefer.key);
  }, [knowledge?.version]); // eslint-disable-line react-hooks/exhaustive-deps

  if (enrichPending || status === "building" || building) {
    return (
      <div className="knowledge-panel">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              Đang phân tích bằng AI…
              <br />
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                Kết quả sẽ hiện khi hoàn tất — không dùng bản tạm.
              </Typography.Text>
            </span>
          }
        >
          <Button type="primary" icon={<ThunderboltOutlined />} loading disabled>
            Đang phân tích tài liệu…
          </Button>
        </Empty>
      </div>
    );
  }

  if (status === "empty" || !payload) {
    return (
      <div className="knowledge-panel">
        <Empty
          image={Empty.PRESENTED_IMAGE_SIMPLE}
          description={
            <span>
              Chưa có bản Phân tích. Sau khi tài liệu đã tách đoạn, bấm{" "}
              <strong>Phân tích</strong>.
            </span>
          }
        >
          <Button
            type="primary"
            icon={<ThunderboltOutlined />}
            loading={building}
            disabled={!canBuild}
            onClick={onBuild}
          >
            Phân tích
          </Button>
        </Empty>
        {!canBuild ? (
          <Alert
            style={{ marginTop: 12 }}
            type="info"
            showIcon
            title="Cần ít nhất một tài liệu đã tách đoạn"
          />
        ) : null}
      </div>
    );
  }

  const gapCount = sectionCount(payload, "gaps");
  const missingCritical = READINESS_KEYS.filter(
    (r) => r.key !== "gaps" && sectionCount(payload, r.key) === 0
  );

  return (
    <div className={`knowledge-panel knowledge-panel--split${loading ? " is-loading" : ""}`}>
      {knowledge?.enrichError ? (
        <Alert
          style={{ marginBottom: 12 }}
          type="warning"
          showIcon
          title="Phân tích AI không hoàn tất"
          description={knowledge.enrichError}
        />
      ) : null}
      <div className="knowledge-toolbar">
        <Space wrap>
          <Tag color={status === "ready" ? "success" : status === "stale" ? "warning" : "default"}>
            {status === "ready"
              ? "Sẵn sàng"
              : status === "stale"
                ? "Cần cập nhật"
                : status}
          </Tag>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            v{knowledge?.version ?? 0}
            {knowledge?.builder ? ` · ${knowledge.builder}` : ""}
            {knowledge?.sourceChunkCount
              ? ` · ${knowledge.sourceFileCount} file / ${knowledge.sourceChunkCount} đoạn`
              : ""}
          </Typography.Text>
        </Space>
        <Space wrap>
          {onOpenFreeze && (status === "ready" || status === "stale") ? (
            <Button type="primary" onClick={onOpenFreeze}>
              Tiếp tục: Tạo test case
            </Button>
          ) : null}
          <Button icon={<ReloadOutlined />} onClick={onRefresh} disabled={building}>
            Tải lại
          </Button>
          <Button
            type={onOpenFreeze && (status === "ready" || status === "stale") ? "default" : "primary"}
            icon={<ThunderboltOutlined />}
            loading={building}
            disabled={!canBuild}
            onClick={onBuild}
          >
            {building
              ? "Đang phân tích tài liệu…"
              : status === "stale" || status === "ready"
                ? "Phân tích lại"
                : "Phân tích"}
          </Button>
        </Space>
      </div>

      {status === "stale" ? (
        <Alert
          type="warning"
          showIcon
          title="Phân tích cần cập nhật"
          description="Tài liệu vừa thay đổi. Phân tích lại trước khi tạo test case."
        />
      ) : null}

      {gapCount > 0 || missingCritical.length > 0 ? (
        <Alert
          type="info"
          showIcon
          title={
            gapCount > 0
              ? `${gapCount} mục thiếu sót — xem trước khi tạo test case`
              : "Một số tiêu chí tạo test case còn trống"
          }
          description={
            missingCritical.length
              ? `Thiếu: ${missingCritical.map((m) => m.label).join(", ")}.`
              : "Hệ thống vẫn tổng hợp tài liệu và phân tích; bổ sung SRS sẽ chính xác hơn."
          }
        />
      ) : null}

      <div className="knowledge-split">
        <nav className="knowledge-nav" aria-label="Tiêu chí Phân tích">
          {nav.map((item) => {
            const isActive = item.key === active;
            const warn =
              (item.key === "gaps" && item.count > 0) ||
              (item.key !== "summary" &&
                item.key !== "gaps" &&
                item.key !== "constraints" &&
                item.key !== "apiSummary" &&
                item.key !== "exceptions" &&
                item.count === 0 &&
                ["features", "useCases", "validationRules", "acceptanceCriteria"].includes(
                  item.key
                ));
            return (
              <button
                key={item.key}
                type="button"
                className={`knowledge-nav-item${isActive ? " is-active" : ""}${
                  warn ? " is-warn" : ""
                }`}
                onClick={() => setActive(item.key)}
              >
                <span className="knowledge-nav-label">{item.label}</span>
                <span className="knowledge-nav-count">{item.count}</span>
              </button>
            );
          })}
        </nav>

        <div className="knowledge-detail" aria-live="polite">
          <header className="knowledge-detail-head">
            <Typography.Title level={5} style={{ margin: 0 }}>
              {SECTIONS.find((s) => s.key === active)?.label}
            </Typography.Title>
          </header>
          <div className="knowledge-detail-body">{renderSection(active, payload)}</div>
        </div>
      </div>
    </div>
  );
}

function ReadinessStrip({ payload }: { payload: KnowledgePayload }) {
  return (
    <div className="knowledge-readiness" style={{ marginBottom: 12 }}>
      <Typography.Text type="secondary" style={{ fontSize: 12, display: "block", marginBottom: 6 }}>
        Sẵn sàng tạo test case
      </Typography.Text>
      <Space wrap size={[6, 6]}>
        {READINESS_KEYS.map((r) => {
          const n = sectionCount(payload, r.key);
          const ok = r.key === "gaps" ? n === 0 : n > 0;
          return (
            <Tag key={r.key} color={ok ? "success" : "warning"}>
              {r.label}: {r.key === "gaps" ? (n === 0 ? "OK" : n) : n || "thiếu"}
            </Tag>
          );
        })}
      </Space>
    </div>
  );
}

function renderSection(key: SectionKey, payload: KnowledgePayload) {
  if (key === "summary") {
    const text = payload.summary?.trim();
    return (
      <>
        <ReadinessStrip payload={payload} />
        {text ? (
          <Typography.Paragraph className="knowledge-summary-text">{text}</Typography.Paragraph>
        ) : (
          <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Chưa có tóm tắt" />
        )}
      </>
    );
  }

  if (key === "features") {
    const features = payload.features ?? [];
    if (!features.length) return <EmptyHint label="Chưa có Chức năng / Feature" />;
    return (
      <List
        size="small"
        dataSource={features}
        renderItem={(f) => (
          <List.Item>
            <Space orientation="vertical" size={0}>
              <Typography.Text strong>{f.name}</Typography.Text>
              {f.description ? (
                <Typography.Text type="secondary">{f.description}</Typography.Text>
              ) : null}
            </Space>
          </List.Item>
        )}
      />
    );
  }

  if (key === "businessRules") {
    const rules = payload.businessRules ?? [];
    if (!rules.length) return <EmptyHint />;
    return (
      <List
        size="small"
        dataSource={rules}
        renderItem={(r) => (
          <List.Item>
            <Space orientation="vertical" size={0}>
              <Typography.Text code>{r.id || "BR"}</Typography.Text>
              <span>{r.text}</span>
            </Space>
          </List.Item>
        )}
      />
    );
  }

  if (key === "actors") {
    const actors = payload.actors ?? [];
    if (!actors.length) return <EmptyHint />;
    return (
      <List
        size="small"
        dataSource={actors}
        renderItem={(a) => (
          <List.Item>
            <Space orientation="vertical" size={0}>
              <strong>{a.name}</strong>
              {a.description ? (
                <Typography.Text type="secondary">{a.description}</Typography.Text>
              ) : null}
              {a.permissions ? (
                <Typography.Text type="secondary">Quyền: {a.permissions}</Typography.Text>
              ) : null}
            </Space>
          </List.Item>
        )}
      />
    );
  }

  if (key === "useCases") {
    const useCases = payload.useCases ?? [];
    if (!useCases.length) return <EmptyHint label="Chưa có luồng nghiệp vụ" />;
    return (
      <List
        size="small"
        dataSource={useCases}
        renderItem={(u) => (
          <List.Item>
            <Space orientation="vertical" size={0} style={{ width: "100%" }}>
              <Typography.Text strong>{u.name}</Typography.Text>
              {u.steps ? (
                <Typography.Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
                  {u.steps}
                </Typography.Text>
              ) : null}
            </Space>
          </List.Item>
        )}
      />
    );
  }

  if (key === "executionContexts") {
    const rows = payload.executionContexts ?? [];
    if (!rows.length) return <EmptyHint label="Chưa có Execution Context (WHO cho E2E)" />;
    return (
      <List
        size="small"
        dataSource={rows}
        renderItem={(c) => (
          <List.Item>
            <Space orientation="vertical" size={0} style={{ width: "100%" }}>
              <Typography.Text strong>{c.name}</Typography.Text>
              <Typography.Text type="secondary">
                {[
                  c.actor ? `actor: ${c.actor}` : null,
                  typeof c.authRequired === "boolean"
                    ? `authRequired: ${c.authRequired}`
                    : null,
                  c.roles?.length ? `roles: ${c.roles.join(", ")}` : null,
                  c.sessionHint ? `session: ${c.sessionHint}` : null,
                  c.permissions || null,
                ]
                  .filter(Boolean)
                  .join(" · ")}
              </Typography.Text>
              {c.notes ? (
                <Typography.Text type="secondary" style={{ whiteSpace: "pre-wrap" }}>
                  {c.notes}
                </Typography.Text>
              ) : null}
            </Space>
          </List.Item>
        )}
      />
    );
  }

  if (key === "validationRules") {
    const rows = payload.validationRules ?? [];
    if (!rows.length) return <EmptyHint label="Chưa có Validation & dữ liệu" />;
    return (
      <List
        size="small"
        dataSource={rows}
        renderItem={(v) => (
          <List.Item>
            {v.field ? <Typography.Text code>{v.field}</Typography.Text> : null}
            <span>{v.field ? ` — ${v.rule}` : v.rule}</span>
          </List.Item>
        )}
      />
    );
  }

  if (key === "apiSummary") {
    const apis = payload.apiSummary ?? [];
    if (!apis.length) return <EmptyHint />;
    return (
      <List
        size="small"
        dataSource={apis}
        renderItem={(a) => (
          <List.Item>
            <Tag>{a.method || "?"}</Tag>
            <Typography.Text code>{a.path}</Typography.Text>
            {a.note ? <Typography.Text type="secondary"> · {a.note}</Typography.Text> : null}
          </List.Item>
        )}
      />
    );
  }

  if (key === "exceptions") {
    const rows = payload.exceptions ?? [];
    if (!rows.length) return <EmptyHint />;
    return (
      <List size="small" dataSource={rows} renderItem={(e) => <List.Item>{e.text}</List.Item>} />
    );
  }

  if (key === "acceptanceCriteria") {
    const rows = payload.acceptanceCriteria ?? [];
    if (!rows.length) return <EmptyHint label="Chưa có Acceptance criteria" />;
    return (
      <List size="small" dataSource={rows} renderItem={(a) => <List.Item>{a.text}</List.Item>} />
    );
  }

  if (key === "constraints") {
    const constraints = payload.constraints ?? [];
    if (!constraints.length) return <EmptyHint />;
    return (
      <List size="small" dataSource={constraints} renderItem={(c) => <List.Item>{c.text}</List.Item>} />
    );
  }

  const missing = gapsList(payload);
  if (!missing.length) return <EmptyHint label="Không còn thiếu sót — tốt" />;
  return (
    <List
      size="small"
      dataSource={missing}
      renderItem={(m) => (
        <List.Item>
          <Typography.Text type="warning">{m.text}</Typography.Text>
        </List.Item>
      )}
    />
  );
}

function EmptyHint({ label = "Chưa có dữ liệu trong mục này" }: { label?: string }) {
  return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={label} />;
}
