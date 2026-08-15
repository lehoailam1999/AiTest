/**
 * Liveness probe for IDE bridge discovery.
 *
 * A discovery file outlives its IDE when the window is killed before
 * `deactivate` can delete it, so `~/.aitest/ide-bridge-<port>.json` may point at
 * a dead port. Probe = connect + auth, which also rejects a stale file whose
 * port got recycled by another process.
 */
import {
  IdeRpcClient,
  bridgeWsUrl,
  type IdeBridgeDiscovery,
  type IdeRpcClientOptions,
} from "@aitest/ide-protocol";

const PROBE_TIMEOUT_MS = 1200;
const CACHE_TTL_MS = 2500;

export type ProbeOptions = {
  WebSocketImpl?: IdeRpcClientOptions["WebSocketImpl"];
  timeoutMs?: number;
  now?: () => number;
};

type DiscoveryKeyed = Pick<IdeBridgeDiscovery, "port" | "token">;

const cache = new Map<string, { alive: boolean; at: number }>();

function cacheKey(discovery: DiscoveryKeyed): string {
  return `${discovery.port}:${discovery.token ?? ""}`;
}

/** Skip a probe when the caller already holds an open session on that bridge. */
export function markDiscoveryAlive(
  discovery: DiscoveryKeyed,
  alive: boolean,
  now: () => number = Date.now
): void {
  cache.set(cacheKey(discovery), { alive, at: now() });
}

export function clearDiscoveryLivenessCache(): void {
  cache.clear();
}

export async function probeDiscoveryAlive(
  discovery: IdeBridgeDiscovery,
  opts: ProbeOptions = {}
): Promise<boolean> {
  const now = opts.now ?? Date.now;
  const key = cacheKey(discovery);
  const cached = cache.get(key);
  if (cached && now() - cached.at < CACHE_TTL_MS) return cached.alive;

  const timeoutMs = opts.timeoutMs ?? PROBE_TIMEOUT_MS;
  const client = new IdeRpcClient({
    url: bridgeWsUrl(discovery),
    token: discovery.token,
    WebSocketImpl: opts.WebSocketImpl,
    requestTimeoutMs: timeoutMs,
  });

  let timer: ReturnType<typeof setTimeout> | null = null;
  const alive = await Promise.race([
    client
      .connect()
      .then(() => true)
      .catch(() => false),
    new Promise<boolean>((resolve) => {
      timer = setTimeout(() => resolve(false), timeoutMs);
    }),
  ]);
  if (timer) clearTimeout(timer);
  try {
    client.disconnect();
  } catch {
    /* probe socket only */
  }

  cache.set(key, { alive, at: now() });
  return alive;
}

export async function filterAliveDiscoveries<T extends IdeBridgeDiscovery>(
  list: T[],
  opts: ProbeOptions = {}
): Promise<T[]> {
  const flags = await Promise.all(
    list.map((discovery) => probeDiscoveryAlive(discovery, opts))
  );
  return list.filter((_, i) => flags[i]);
}
