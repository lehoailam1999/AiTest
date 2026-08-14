import { useEffect, useState } from "react";
import { Alert } from "antd";
import { Link } from "react-router-dom";

const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:8000/api";

/** W7 Hardening — banner khi API down */
export function ApiHealthBanner() {
  const [down, setDown] = useState(false);

  useEffect(() => {
    let cancelled = false;
    async function ping() {
      try {
        const base = API_URL.replace(/\/api\/?$/, "");
        const res = await fetch(`${base}/health`, { method: "GET" });
        if (!cancelled) setDown(!res.ok);
      } catch {
        if (!cancelled) setDown(true);
      }
    }
    void ping();
    const id = window.setInterval(ping, 30000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  if (!down) return null;
  return (
    <Alert
      type="error"
      showIcon
      banner
      title={
        <span>
          API không phản hồi ({API_URL}). Kiểm tra <code>npm run start</code> trong thư mục{" "}
          <code>api/</code>.{" "}
          <Link to="/settings/ai">Cấu hình AI</Link>
        </span>
      }
    />
  );
}
