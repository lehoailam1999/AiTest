const API_URL = import.meta.env.VITE_API_URL ?? "http://127.0.0.1:5088/api";

const ACCESS_KEY = "aitest.accessToken";
const REFRESH_KEY = "aitest.refreshToken";

export type ApiError = { errors?: string[] };

export type Paged<T> = {
  items: T[];
  pageNumber: number;
  pageSize: number;
  totalCount: number;
  totalPages: number;
  hasPrevious: boolean;
  hasNext: boolean;
};

let onUnauthorized: (() => void) | null = null;

export function setUnauthorizedHandler(fn: (() => void) | null) {
  onUnauthorized = fn;
}

export const session = {
  getAccess: () => localStorage.getItem(ACCESS_KEY),
  getRefresh: () => localStorage.getItem(REFRESH_KEY),
  set(access: string, refresh: string) {
    localStorage.setItem(ACCESS_KEY, access);
    localStorage.setItem(REFRESH_KEY, refresh);
  },
  clear() {
    localStorage.removeItem(ACCESS_KEY);
    localStorage.removeItem(REFRESH_KEY);
  },
};

async function rawFetch(path: string, options: RequestInit, token?: string | null) {
  const headers = new Headers(options.headers);
  headers.set("Accept", "application/json");
  if (options.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  if (token) headers.set("Authorization", `Bearer ${token}`);
  return fetch(`${API_URL}${path}`, { ...options, headers });
}

async function parse<T>(res: Response): Promise<T> {
  const text = await res.text();
  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      if (!res.ok) {
        const hint =
          res.status === 500
            ? " Có thể port API bị app khác chiếm (vd. 5000) — chạy AITest api/ (PORT=5001) và khớp VITE_API_URL."
            : "";
        throw new Error(`HTTP ${res.status} — phản hồi không phải JSON AITest.${hint}`);
      }
      throw new Error("Phản hồi API không hợp lệ (không phải JSON).");
    }
  }
  if (!res.ok) {
    const err = data as ApiError & { detail?: string; title?: string };
    const message =
      err?.errors?.join("; ") ||
      (typeof err?.detail === "string" ? err.detail : null) ||
      (typeof err?.title === "string" ? err.title : null) ||
      `HTTP ${res.status}`;
    throw new Error(message);
  }
  return data as T;
}

async function tryRefresh(): Promise<string | null> {
  const refreshToken = session.getRefresh();
  if (!refreshToken) return null;
  const res = await rawFetch("/auth/refresh", {
    method: "POST",
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) return null;
  const data = (await res.json()) as { accessToken: string; refreshToken: string };
  session.set(data.accessToken, data.refreshToken);
  return data.accessToken;
}

/** Unauthenticated call (login/register/refresh). */
export async function apiFetch<T>(
  path: string,
  options: RequestInit = {},
  token?: string | null
): Promise<T> {
  const res = await rawFetch(path, options, token);
  return parse<T>(res);
}

/** Authenticated multipart upload (no JSON Content-Type). */
export async function authUpload<T>(path: string, form: FormData): Promise<T> {
  let token = session.getAccess();
  const headers = new Headers({ Accept: "application/json" });
  if (token) headers.set("Authorization", `Bearer ${token}`);

  const ctrl = new AbortController();
  // First docx+images used to hang past browser defaults — fail with clear message.
  const timer = window.setTimeout(() => ctrl.abort(), 120_000);
  try {
    let res = await fetch(`${API_URL}${path}`, {
      method: "POST",
      headers,
      body: form,
      signal: ctrl.signal,
    });
    if (res.status === 401) {
      token = await tryRefresh();
      if (token) {
        const retryHeaders = new Headers({ Accept: "application/json" });
        retryHeaders.set("Authorization", `Bearer ${token}`);
        res = await fetch(`${API_URL}${path}`, {
          method: "POST",
          headers: retryHeaders,
          body: form,
          signal: ctrl.signal,
        });
      } else {
        session.clear();
        onUnauthorized?.();
        throw new Error("Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.");
      }
    }
    return await parse<T>(res);
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") {
      throw new Error(
        "Upload quá lâu (>120s) — thử .md/.txt hoặc Word ít ảnh, rồi Phân tích lại."
      );
    }
    throw e;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Authenticated call — injects access token, refreshes once on 401. */
export async function authFetch<T>(path: string, options: RequestInit = {}): Promise<T> {
  let token = session.getAccess();
  const bodyText = typeof options.body === "string" ? options.body : null;
  const requestInit = (): RequestInit =>
    bodyText !== null ? { ...options, body: bodyText } : { ...options };

  let res = await rawFetch(path, requestInit(), token);
  if (res.status === 401) {
    token = await tryRefresh();
    if (token) {
      res = await rawFetch(path, requestInit(), token);
    } else {
      session.clear();
      onUnauthorized?.();
      throw new Error("Phiên đăng nhập đã hết hạn — hãy đăng nhập lại.");
    }
  }
  return parse<T>(res);
}
