import { useCallback, useEffect, useState } from "react";
import type { FormEvent } from "react";
import { connection } from "../api";
import type { Connection } from "../api/types";
import { useProject } from "../state/ProjectContext";

const PROVIDERS: { value: string; label: string }[] = [
  { value: "openai", label: "OpenAI" },
  { value: "anthropic", label: "Anthropic" },
  { value: "gemini", label: "Google Gemini" },
  { value: "ollama", label: "Ollama (local)" },
  { value: "antigravity", label: "Antigravity (Google API / tùy chọn proxy)" },
];

export default function SettingsPage() {
  const { project } = useProject();
  const [conn, setConn] = useState<Connection | null>(null);
  const [provider, setProvider] = useState("openai");
  const [modelName, setModelName] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!project) return;
    try {
      const c = await connection.get(project.id);
      setConn(c);
      setProvider(c.provider || "openai");
      setModelName(c.modelName ?? "");
      setBaseUrl(c.baseUrl ?? "");
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Load failed");
    }
  }, [project]);

  useEffect(() => {
    void load();
  }, [load]);

  async function onSave(e: FormEvent) {
    e.preventDefault();
    if (!project) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const c = await connection.save(project.id, {
        provider,
        modelName: modelName.trim() || undefined,
        // Always send baseUrl for ollama/antigravity so clearing the field persists.
        ...(provider === "ollama" || provider === "antigravity"
          ? { baseUrl: baseUrl.trim() || "" }
          : {}),
        apiKey: apiKey.trim() || undefined,
      });
      setConn(c);
      setBaseUrl(c.baseUrl ?? "");
      setApiKey("");
      setMessage("Đã lưu cấu hình.");
    } catch (e) {
      setError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setBusy(false);
    }
  }

  async function onVerify() {
    if (!project) return;
    setBusy(true);
    setError(null);
    setMessage(null);
    try {
      const c = await connection.verify(project.id);
      setConn(c);
      setMessage(c.status === "Ready" ? "Xác minh thành công — AI đã Ready." : `Trạng thái: ${c.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Xác minh thất bại");
    } finally {
      setBusy(false);
    }
  }

  if (!project) {
    return (
      <div className="page">
        <h1>Cấu hình AI</h1>
        <p className="error">Chưa chọn dự án. Vào tab Dự án để chọn.</p>
      </div>
    );
  }

  const isOllama = provider === "ollama";
  const isAntigravity = provider === "antigravity";
  const showBaseUrl = isOllama || isAntigravity;
  const apiKeyOptional =
    isOllama ||
    (isAntigravity &&
      Boolean(baseUrl.trim()) &&
      /127\.0\.0\.1|localhost/i.test(baseUrl));

  return (
    <div className="page">
      <header className="page-head">
        <div>
          <h1>Cấu hình AI</h1>
          <p className="muted">Thiết lập LLM cho dự án · {project.name}</p>
        </div>
        {conn ? <span className={`badge status-${conn.status}`}>{conn.status}</span> : null}
      </header>

      {error ? <p className="error">{error}</p> : null}
      {message ? <p className="ok">{message}</p> : null}

      <section className="card">
        <form onSubmit={onSave} className="stack">
          <label>
            Nhà cung cấp
            <select value={provider} onChange={(e) => setProvider(e.target.value)}>
              {PROVIDERS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
          </label>
          <label>
            Tên model{" "}
            {isOllama
              ? "(vd. llama3.2)"
              : isAntigravity
                ? "(vd. gemini-2.0-flash)"
                : "(tuỳ chọn)"}
            <input
              value={modelName}
              onChange={(e) => setModelName(e.target.value)}
              placeholder={
                isAntigravity ? "gemini-2.0-flash" : "mặc định theo provider"
              }
            />
          </label>

          {showBaseUrl ? (
            <label>
              Base URL {isAntigravity ? "(để trống = Google Gemini API)" : "(Ollama)"}
              <input
                value={baseUrl}
                onChange={(e) => setBaseUrl(e.target.value)}
                placeholder={
                  isAntigravity
                    ? "để trống · hoặc http://127.0.0.1:11435/v1 (proxy)"
                    : "http://127.0.0.1:11434"
                }
              />
            </label>
          ) : null}

          <label>
            API Key {apiKeyOptional ? "(không bắt buộc)" : ""}
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder={
                conn?.hasApiKey
                  ? "•••••• (đã lưu — nhập để thay)"
                  : isAntigravity && !baseUrl.trim()
                    ? "Google API Key (giống Gemini)"
                    : "nhập API key"
              }
            />
          </label>

          {isAntigravity ? (
            <p className="muted" style={{ margin: 0, lineHeight: 1.45 }}>
              Mặc định giống Gemini: chỉ cần <strong>Google API Key</strong> + model, để trống Base
              URL. Chỉ điền Base URL khi dùng proxy OpenAI-compatible (local/remote). Khác với{" "}
              <strong>Connect IDE Antigravity</strong> trên trang Unit test.
            </p>
          ) : null}

          <div className="btn-row">
            <button className="btn" type="submit" disabled={busy}>
              {busy ? "Đang lưu…" : "Lưu"}
            </button>
            <button className="btn ghost" type="button" onClick={onVerify} disabled={busy}>
              Xác minh
            </button>
          </div>
          {conn?.lastError ? <p className="warn">Lỗi gần nhất: {conn.lastError}</p> : null}
        </form>
      </section>
    </div>
  );
}
