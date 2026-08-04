/**
 * Phase step-2 — Inspect DOM cache keyed by URL + featurePath + FE seed.
 * Same-route TCs share one Chromium inspect; different screens do not.
 */

export type InspectCacheEntry = {
  domSnapshot: string;
  elementCount: number;
  routeCount: number;
  source: string;
  routes: string[];
  at: number;
  loginWall: boolean;
};

export function inspectCacheKey(parts: {
  targetUrl: string;
  featurePath?: string;
  feSeed?: string;
}): string {
  const url = (parts.targetUrl || "").trim().replace(/\/+$/, "");
  const path = (parts.featurePath || "").trim().replace(/\\/g, "/");
  const seed = (parts.feSeed || "").trim().replace(/\\/g, "/").toLowerCase();
  return `${url}|${path}|${seed}`;
}

/** Heuristic aligned with API is_login_wall_dom — password / sign-in UI. */
export function isLikelyLoginWallDom(domSnapshot: string): boolean {
  const t = (domSnapshot || "").trim();
  if (!t) return false;
  return /đăng\s*nhập|sign\s*in|log\s*in|mật\s*khẩu|"password"|type["']?\s*:\s*["']password["']|textbox[^\n]{0,40}(?:email|password|username)/i.test(
    t
  );
}

export function isLikelyLoginTestCase(tc: {
  title?: string | null;
  steps?: string | null;
  type?: string | null;
}): boolean {
  const blob = `${tc.title || ""} ${tc.steps || ""}`;
  return /login|log\s*in|đăng\s*nhập|sign\s*in|logout|đăng\s*xuất/i.test(blob);
}

const DEFAULT_TTL_MS = 5 * 60 * 1000;

/**
 * In-flight dedupe + TTL cache so parallel Generate workers for the same
 * featurePath share one Inspect instead of N Chromium launches.
 */
export function createInspectDomCache(ttlMs = DEFAULT_TTL_MS) {
  const entries = new Map<string, InspectCacheEntry>();
  const inflight = new Map<string, Promise<InspectCacheEntry>>();

  return {
    get(key: string): InspectCacheEntry | undefined {
      const e = entries.get(key);
      if (!e) return undefined;
      if (Date.now() - e.at > ttlMs) {
        entries.delete(key);
        return undefined;
      }
      return e;
    },

    async getOrFetch(
      key: string,
      fetch: () => Promise<Omit<InspectCacheEntry, "at" | "loginWall"> & { loginWall?: boolean }>
    ): Promise<{ entry: InspectCacheEntry; fromCache: boolean }> {
      const hit = this.get(key);
      if (hit) return { entry: hit, fromCache: true };
      const pending = inflight.get(key);
      if (pending) {
        const entry = await pending;
        return { entry, fromCache: true };
      }

      const p = (async () => {
        const raw = await fetch();
        const entry: InspectCacheEntry = {
          ...raw,
          at: Date.now(),
          loginWall:
            raw.loginWall ?? isLikelyLoginWallDom(raw.domSnapshot || ""),
        };
        entries.set(key, entry);
        return entry;
      })().finally(() => {
        inflight.delete(key);
      });

      inflight.set(key, p);
      const entry = await p;
      return { entry, fromCache: false };
    },

    size(): number {
      return entries.size;
    },
  };
}

export type InspectDomCache = ReturnType<typeof createInspectDomCache>;
