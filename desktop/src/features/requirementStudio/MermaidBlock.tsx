/**
 * Knowledge BUSINESS_FLOWS Mermaid — full height; zoom width only.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Button, Space, Typography } from "antd";
import {
  ZoomInOutlined,
  ZoomOutOutlined,
} from "@ant-design/icons";

type Props = {
  chart: string;
};

type MermaidApi = typeof import("mermaid").default;

const MIN_SCALE = 0.5;
const MAX_SCALE = 2.5;
const STEP = 0.25;
const DEFAULT_SCALE = MIN_SCALE;

let mermaidImport: Promise<MermaidApi> | null = null;

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidImport) {
    mermaidImport = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidImport;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: "base",
    themeVariables: {
      fontFamily:
        "ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif",
      fontSize: "18px",
      primaryColor: "#f8fafc",
      primaryTextColor: "#0f172a",
      primaryBorderColor: "#64748b",
      secondaryColor: "#ecfdf5",
      tertiaryColor: "#ffffff",
      lineColor: "#94a3b8",
      textColor: "#0f172a",
      mainBkg: "#f8fafc",
      nodeBorder: "#64748b",
      clusterBkg: "#f8fafc",
      titleColor: "#0f172a",
      edgeLabelBackground: "#ffffff",
    },
    flowchart: {
      htmlLabels: false,
      curve: "basis",
      padding: 20,
      nodeSpacing: 66,
      rankSpacing: 84,
      // false: keep intrinsic size so parent width zoom works (useMaxWidth → 0-width parent collapses)
      useMaxWidth: false,
    },
  });
  return mermaid;
}

export default function MermaidBlock({ chart }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId().replace(/:/g, "");
  const [error, setError] = useState<string | null>(null);
  const [scale, setScale] = useState(DEFAULT_SCALE);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      const src = (chart || "").trim();
      if (!src || !hostRef.current) return;
      setError(null);
      try {
        const mermaid = await getMermaid();
        const id = `mmd-${reactId}-${Math.random().toString(36).slice(2, 8)}`;
        const { svg } = await mermaid.render(id, src);
        if (cancelled || !hostRef.current) return;
        hostRef.current.innerHTML = svg;
        const svgEl = hostRef.current.querySelector("svg");
        if (svgEl) {
          svgEl.setAttribute("role", "img");
          svgEl.removeAttribute("height");
          svgEl.setAttribute("class", "knowledge-mermaid-svg");
          // Width driven by CSS (.knowledge-mermaid-host width %); keep aspect via viewBox
          svgEl.style.width = "100%";
          svgEl.style.height = "auto";
          svgEl.style.maxHeight = "none";
        }
      } catch (e) {
        if (!cancelled) {
          setError(e instanceof Error ? e.message : String(e));
          if (hostRef.current) hostRef.current.innerHTML = "";
        }
      }
    };
    void run();
    return () => {
      cancelled = true;
    };
  }, [chart, reactId]);

  if (!chart.trim()) return null;

  const zoomOut = () =>
    setScale((s) => Math.max(MIN_SCALE, Math.round((s - STEP) * 100) / 100));
  const zoomIn = () =>
    setScale((s) => Math.min(MAX_SCALE, Math.round((s + STEP) * 100) / 100));
  const zoomReset = () => setScale(DEFAULT_SCALE);

  return (
    <div className="knowledge-mermaid-card">
      <div className="knowledge-mermaid-toolbar">
        <Space size={4}>
          <Button
            type="text"
            size="small"
            icon={<ZoomOutOutlined />}
            onClick={zoomOut}
            disabled={scale <= MIN_SCALE}
            aria-label="Zoom out"
          />
          <Button type="text" size="small" onClick={zoomReset} aria-label="Reset zoom">
            {Math.round(scale * 100)}%
          </Button>
          <Button
            type="text"
            size="small"
            icon={<ZoomInOutlined />}
            onClick={zoomIn}
            disabled={scale >= MAX_SCALE}
            aria-label="Zoom in"
          />
        </Space>
      </div>
      <div className="knowledge-mermaid">
        <div
          ref={hostRef}
          className="knowledge-mermaid-host"
          style={{ width: `${scale * 100}%` }}
        />
      </div>
      {error ? (
        <Typography.Paragraph
          type="secondary"
          className="knowledge-mermaid-fallback"
        >
          {chart}
        </Typography.Paragraph>
      ) : null}
    </div>
  );
}
