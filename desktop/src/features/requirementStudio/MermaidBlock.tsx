/**
 * Knowledge BUSINESS_FLOWS Mermaid — ~3× compact size, centered in panel.
 */
import { useEffect, useId, useRef, useState } from "react";
import { Typography } from "antd";

type Props = {
  chart: string;
};

type MermaidApi = typeof import("mermaid").default;

let mermaidImport: Promise<MermaidApi> | null = null;

async function getMermaid(): Promise<MermaidApi> {
  if (!mermaidImport) {
    mermaidImport = import("mermaid").then((m) => m.default);
  }
  const mermaid = await mermaidImport;
  // Re-init each time so size/theme knobs stay in sync after code updates
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
      /* ~3× compact (6/22/28) */
      padding: 20,
      nodeSpacing: 66,
      rankSpacing: 84,
      useMaxWidth: true,
    },
  });
  return mermaid;
}

export default function MermaidBlock({ chart }: Props) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const reactId = useId().replace(/:/g, "");
  const [error, setError] = useState<string | null>(null);

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
          svgEl.removeAttribute("width");
          svgEl.removeAttribute("height");
          svgEl.setAttribute("class", "knowledge-mermaid-svg");
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

  return (
    <div className="knowledge-mermaid-card">
      <div ref={hostRef} className="knowledge-mermaid" />
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
