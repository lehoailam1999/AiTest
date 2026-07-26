const API_ROOT = (import.meta.env.VITE_API_URL ?? "http://127.0.0.1:5088/api").replace(/\/api\/?$/, "");

export type ApiHealth = {
  status?: string;
  stack?: string;
  features?: string[];
};

export async function fetchApiHealth(): Promise<ApiHealth | null> {
  try {
    const res = await fetch(`${API_ROOT}/health`, { method: "GET" });
    if (!res.ok) return null;
    return (await res.json()) as ApiHealth;
  } catch {
    return null;
  }
}

export function apiSupportsProjectMeta(health: ApiHealth | null): boolean {
  return Boolean(health?.features?.includes("projectMeta"));
}

export async function assertApiReadyForSync(): Promise<void> {
  const health = await fetchApiHealth();
  if (!health?.status) {
    throw new Error(
      "Không kết nối được API AITest. Chạy: cd api → npm run start (port trong api/.env, mặc định 5088). Khớp VITE_API_URL — nên dùng http://127.0.0.1:... không dùng localhost nếu có Forensic."
    );
  }
  if (!apiSupportsProjectMeta(health)) {
    throw new Error(
      "Sai server trên port này (health không phải AITest Python). Dừng app khác hoặc đổi PORT trong api/.env và VITE_API_URL."
    );
  }
}
