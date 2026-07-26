import { useEffect, useRef, useState } from "react";
import { Alert, App, Button, List, Typography, Upload } from "antd";
import type { UploadProps } from "antd";
import { DeleteOutlined, InboxOutlined } from "@ant-design/icons";
import { requirements } from "../api";
import { assignFeatureTitles } from "../lib/featureTitle";
import RequirementRichPreview from "./RequirementRichPreview";

export type DocFilePart = {
  fileName: string;
  content: string;
  previewHtml?: string;
  warning?: string;
};

export type DocInput = {
  parts: DocFilePart[];
};

const ACCEPT =
  ".md,.txt,.csv,.json,.yaml,.yml,.xml,.html,.htm,.feature,.doc,.docx,.pdf,.xls,.xlsx";

type Props = {
  label: string;
  hint: string;
  value: DocInput | null;
  onChange: (value: DocInput | null) => void;
  /** Báo khi đang parse/upload file — parent nên khoá nút Lưu */
  onBusyChange?: (busy: boolean) => void;
};

export function docInputContent(doc: DocInput | null): string {
  if (!doc?.parts.length) return "";
  if (doc.parts.length === 1) return doc.parts[0].content.trim();
  return doc.parts
    .map((p) => `--- ${p.fileName} ---\n${p.content.trim()}`)
    .join("\n\n")
    .trim();
}

export function docInputPreviewHtml(doc: DocInput | null): string | null {
  if (!doc?.parts.length) return null;
  const blocks = doc.parts.map((p) => p.previewHtml?.trim()).filter(Boolean) as string[];
  if (!blocks.length) return null;
  if (blocks.length === 1) return blocks[0];
  return blocks.map((h) => `<div class="req-multi-doc">${h}</div>`).join("<hr/>");
}

export function docInputFileLabel(doc: DocInput | null): string | undefined {
  if (!doc?.parts.length) return undefined;
  if (doc.parts.length === 1) return doc.parts[0].fileName;
  return doc.parts.map((p) => p.fileName).join(", ");
}

function docInputWarnings(doc: DocInput | null): string[] {
  if (!doc?.parts.length) return [];
  return doc.parts.map((p) => p.warning).filter((w): w is string => Boolean(w?.trim()));
}

export default function RequirementDocField({
  label,
  hint,
  value,
  onChange,
  onBusyChange,
}: Props) {
  const { message } = App.useApp();
  const [parsing, setParsing] = useState(false);
  const partsRef = useRef<DocFilePart[]>(value?.parts ?? []);
  const uploadQueue = useRef(Promise.resolve());
  const pendingUploads = useRef(0);

  // Chỉ sync từ parent khi value đổi — tránh xoá partsRef giữa chừng upload
  useEffect(() => {
    partsRef.current = value?.parts ?? [];
  }, [value]);

  const setBusy = (busy: boolean) => {
    setParsing(busy);
    onBusyChange?.(busy);
  };

  const enqueueUpload = (file: File) => {
    uploadQueue.current = uploadQueue.current.then(async () => {
      const parsed = await requirements.parseFile(file);
      if (!parsed.text?.trim()) {
        throw new Error(parsed.warning || "Không đọc được nội dung file");
      }
      const part: DocFilePart = {
        fileName: parsed.fileName,
        content: parsed.text,
        previewHtml: parsed.html ?? undefined,
        warning: parsed.warning || undefined,
      };
      partsRef.current = [...partsRef.current, part];
      onChange({ parts: [...partsRef.current] });
    });
    return uploadQueue.current;
  };

  const uploadProps: UploadProps = {
    accept: ACCEPT,
    multiple: true,
    showUploadList: false,
    beforeUpload: (file) => {
      const starting = pendingUploads.current === 0;
      pendingUploads.current += 1;
      if (starting) setBusy(true);
      void enqueueUpload(file)
        .catch((e) => {
          message.error(e instanceof Error ? e.message : "Không đọc được file");
        })
        .finally(() => {
          pendingUploads.current = Math.max(0, pendingUploads.current - 1);
          if (pendingUploads.current === 0) setBusy(false);
        });
      return false;
    },
  };

  const parts = value?.parts ?? [];
  const merged = docInputContent(value);
  const previewHtml = docInputPreviewHtml(value);
  const warnings = docInputWarnings(value);

  const removeAt = (index: number) => {
    const next = parts.filter((_, i) => i !== index);
    partsRef.current = next;
    onChange(next.length ? { parts: next } : null);
  };

  const clearAll = () => {
    partsRef.current = [];
    onChange(null);
  };

  return (
    <div className="req-doc-field">
      <div className="req-doc-field-head">
        <Typography.Text strong>{label}</Typography.Text>
        <Typography.Text type="secondary" className="req-doc-hint">
          {hint}
          {parts.length > 0
            ? " · Nhiều file = nhiều chức năng (mỗi file một module khi sinh TC)."
            : ""}
        </Typography.Text>
      </div>

      {parts.length > 0 ? (
        <div className="req-doc-preview">
          <div className="req-doc-preview-head">
            <Typography.Text type="secondary">
              {parts.length} file / chức năng · {merged.length.toLocaleString()} ký tự
            </Typography.Text>
            <Button type="text" size="small" danger icon={<DeleteOutlined />} onClick={clearAll}>
              Gỡ tất cả
            </Button>
          </div>

          <List
            size="small"
            className="req-doc-file-list"
            dataSource={parts}
            renderItem={(item, index) => (
              <List.Item
                actions={[
                  <Button key="rm" type="link" size="small" danger onClick={() => removeAt(index)}>
                    Gỡ
                  </Button>,
                ]}
              >
                <List.Item.Meta
                  title={item.fileName}
                  description={`${item.content.length.toLocaleString()} ký tự`}
                />
              </List.Item>
            )}
          />

          {warnings.map((w) => (
            <Alert key={w} type="warning" showIcon title={w} style={{ marginBottom: 8 }} />
          ))}

          <RequirementRichPreview html={previewHtml} fallbackText={merged} />

          <Upload.Dragger {...uploadProps} disabled={parsing} className="req-doc-upload req-doc-upload-add">
            <p className="ant-upload-text">
              {parsing ? "Đang đọc file…" : "Thêm file khác (kéo thả hoặc chọn nhiều file)"}
            </p>
          </Upload.Dragger>
        </div>
      ) : (
        <Upload.Dragger {...uploadProps} disabled={parsing} className="req-doc-upload">
          <p className="ant-upload-drag-icon">
            <InboxOutlined />
          </p>
          <p className="ant-upload-text">
            {parsing ? "Đang đọc file…" : "Kéo thả hoặc bấm để chọn một hoặc nhiều file"}
          </p>
          <p className="ant-upload-hint">.docx, .doc (Confluence), .md, .txt — hiển thị cả hình ảnh nếu có</p>
        </Upload.Dragger>
      )}
    </div>
  );
}

function buildSources(userStory: DocInput | null, srs: DocInput | null): {
  sources: {
    sourceType: string;
    content: string;
    fileName?: string;
    title?: string;
    previewHtml?: string;
  }[];
} {
  const sources: {
    sourceType: string;
    content: string;
    fileName?: string;
    title?: string;
    previewHtml?: string;
  }[] = [];
  const usContent = docInputContent(userStory);
  if (usContent) {
    const usPreview = docInputPreviewHtml(userStory);
    sources.push({
      sourceType: "UserStory",
      content: usContent,
      fileName: docInputFileLabel(userStory),
      previewHtml: usPreview && usPreview.length <= 80_000 ? usPreview : undefined,
    });
  }
  for (const part of srs?.parts ?? []) {
    const text = part.content.trim();
    if (!text) continue;
    const preview =
      part.previewHtml && part.previewHtml.length <= 80_000 ? part.previewHtml : undefined;
    sources.push({
      sourceType: "Feature",
      content: text,
      fileName: part.fileName,
      title: "", // set below
      previewHtml: preview,
    });
  }
  const featureSources = sources.filter((s) => s.sourceType === "Feature");
  const titles = assignFeatureTitles(
    featureSources.map((s) => ({ fileName: s.fileName || "file.txt" }))
  );
  featureSources.forEach((s, i) => {
    s.title = titles[i];
  });
  return { sources };
}

export function buildRequirementPayload(
  title: string,
  requirementText: string,
  userStory: DocInput | null,
  srs: DocInput | null
) {
  const content = requirementText.trim();
  if (!content) {
    throw new Error("Nhập yêu cầu (Requirement) — phần AI dùng để xác định phạm vi sinh test case");
  }
  const { sources } = buildSources(userStory, srs);
  return { title: title.trim(), sources, content };
}

export function sourcesToDocs(
  sources:
    | {
        sourceType: string;
        content: string;
        fileName?: string | null;
        title?: string | null;
        previewHtml?: string | null;
      }[]
    | null
    | undefined
) {
  const list = Array.isArray(sources) ? sources : [];
  const find = (type: string) => list.find((s) => s.sourceType === type);
  const us = find("UserStory");
  const notes = find("Requirement");
  const features = list.filter((s) => s.sourceType === "Feature" && s.content?.trim());
  const legacySrs = find("SRS");

  const toDoc = (row: (typeof list)[number] | undefined): DocInput | null => {
    if (!row?.content?.trim()) return null;
    return {
      parts: [
        {
          fileName: row.fileName?.trim() || row.title?.trim() || "Đã lưu",
          content: row.content,
          previewHtml: row.previewHtml ?? undefined,
        },
      ],
    };
  };

  let srs: DocInput | null = null;
  if (features.length > 0) {
    srs = {
      parts: features.map((f, i) => ({
        fileName: f.fileName?.trim() || `${f.title?.trim() || `Chức năng ${i + 1}`}.txt`,
        content: f.content,
        previewHtml: f.previewHtml ?? undefined,
      })),
    };
  } else if (legacySrs?.content?.trim()) {
    const markRe = /^---\s*(.+?)\s*---\s*$/gm;
    const text = legacySrs.content;
    const marks = [...text.matchAll(markRe)];
    if (marks.length >= 2) {
      const parts: DocFilePart[] = [];
      for (let i = 0; i < marks.length; i++) {
        const m = marks[i];
        const start = (m.index ?? 0) + m[0].length;
        const end = i + 1 < marks.length ? (marks[i + 1].index ?? text.length) : text.length;
        const body = text.slice(start, end).trim();
        if (body) {
          parts.push({ fileName: (m[1] || `file-${i + 1}`).trim(), content: body });
        }
      }
      srs = parts.length ? { parts } : toDoc(legacySrs);
    } else {
      srs = toDoc(legacySrs);
    }
  }

  return {
    userStory: toDoc(us),
    srs,
    requirement: notes?.content ?? "",
  };
}
