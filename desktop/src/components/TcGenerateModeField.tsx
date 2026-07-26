import { useEffect, useState } from "react";
import { Alert, Segmented, Typography } from "antd";
import { testcases } from "../api";
import { normalizeFunctionLabel } from "../lib/normalizeFunctionLabel";
import type { ScopeLevel } from "../lib/testScope";
import {
  TC_GENERATE_MODE_OPTIONS,
  type TcGenerateMode,
} from "../lib/tcGenerateMode";

type Props = {
  projectId: string;
  requirementId: string | undefined;
  scopeLevel: ScopeLevel;
  moduleTitle?: string;
  value: TcGenerateMode;
  onChange: (mode: TcGenerateMode) => void;
  /** Nhiều lượt AI — replace chỉ áp dụng lượt đầu */
  multiJob?: boolean;
};

function tcInScope(
  tcModule: string | null | undefined,
  scopeLevel: ScopeLevel,
  moduleTitle?: string
): boolean {
  if (scopeLevel !== "module" || !moduleTitle?.trim()) return true;
  return (
    normalizeFunctionLabel(tcModule ?? "").toLowerCase() ===
    normalizeFunctionLabel(moduleTitle).toLowerCase()
  );
}

export function TcGenerateModeField({
  projectId,
  requirementId,
  scopeLevel,
  moduleTitle,
  value,
  onChange,
  multiJob = false,
}: Props) {
  const [draftCount, setDraftCount] = useState<number | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!requirementId) {
      setDraftCount(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    void testcases
      .list({ projectId, sourceId: requirementId, reviewStatus: "Draft" }, 1, 500)
      .then(({ items }) => {
        if (cancelled) return;
        const n = items.filter((tc) => tcInScope(tc.module, scopeLevel, moduleTitle)).length;
        setDraftCount(n);
      })
      .catch(() => {
        if (!cancelled) setDraftCount(null);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId, requirementId, scopeLevel, moduleTitle]);

  useEffect(() => {
    if (value === "replace" && draftCount === 0 && !loading) onChange("append");
  }, [draftCount, loading, value, onChange]);

  const selected = TC_GENERATE_MODE_OPTIONS.find((o) => o.value === value)!;
  const replaceDisabled = draftCount === 0 && !loading;

  return (
    <div>
      <Typography.Text strong>Chế độ sinh</Typography.Text>
      <Segmented
        block
        style={{ marginTop: 8 }}
        value={value}
        onChange={(v) => onChange(v as TcGenerateMode)}
        options={TC_GENERATE_MODE_OPTIONS.map((o) => ({
          value: o.value,
          label: o.label,
          disabled: o.value === "replace" && replaceDisabled,
        }))}
      />
      <Typography.Paragraph type="secondary" style={{ marginTop: 8, marginBottom: 0, fontSize: 13 }}>
        {selected.hint}
        {loading ? " · Đang đếm TC nháp…" : null}
        {!loading && draftCount != null ? (
          <>
            {" "}
            · Trong phạm vi hiện tại: <strong>{draftCount}</strong> TC nháp
          </>
        ) : null}
      </Typography.Paragraph>
      {value === "replace" && draftCount != null && draftCount > 0 ? (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          title={`Sẽ xóa ${draftCount} TC nháp trước khi sinh`}
          description={
            multiJob
              ? "Bạn đang sinh nhiều chức năng: lượt đầu làm mới nháp toàn requirement, các lượt sau chỉ thêm TC."
              : scopeLevel === "module" && moduleTitle
                ? `Chỉ TC nháp thuộc chức năng «${moduleTitle}». TC đã duyệt giữ nguyên.`
                : "Chỉ TC nháp của requirement này. TC đã duyệt giữ nguyên."
          }
        />
      ) : null}
      {replaceDisabled && value === "append" ? (
        <Typography.Text type="secondary" style={{ display: "block", marginTop: 8, fontSize: 12 }}>
          Chưa có TC nháp — mặc định thêm mới. «Làm mới bản nháp» sẽ khả dụng khi đã có nháp.
        </Typography.Text>
      ) : null}
    </div>
  );
}
